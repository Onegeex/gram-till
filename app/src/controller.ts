import type { Display, Gesture } from './display'
import type { InterpretResult } from './backend'
import {
  confirmCard,
  listeningCard,
  menuItems,
  messageCard,
  offlineCard,
  orderActionItems,
  paymentCard,
  thinkingCard,
  tillCard,
  unpairedCard,
  waitingItems,
  type Confirm,
  type PaymentEvent,
  type TillSnapshot,
  type WaitingOrder,
} from './format'

/** The backend calls the controller uses (the real Backend class satisfies this). */
export interface TillApi {
  voice(pcm: Uint8Array): Promise<InterpretResult>
  command(text: string): Promise<InterpretResult>
  repeat(): Promise<InterpretResult>
  confirm(id: string): Promise<{ ok: boolean; message: string }>
  discard(id: string): Promise<unknown>
  remind(orderId: number): Promise<{ ok: boolean; message: string }>
  cancel(orderId: number): Promise<unknown>
}

type Screen =
  | { kind: 'unpaired' }
  | { kind: 'till' }
  | { kind: 'menu' }
  | { kind: 'waiting' }
  | { kind: 'order'; order: WaitingOrder }
  | { kind: 'listening'; startedAt: number; chunks: Uint8Array[]; vad: Vad }
  | { kind: 'thinking'; transcript?: string }
  | { kind: 'confirm'; confirm: Confirm; startedAt: number }
  | { kind: 'message'; text: string; examples?: string[] }
  | { kind: 'payment'; event: PaymentEvent; back: Screen }

export const MAX_LISTEN_SEC = 8

/**
 * Tiny energy-based end-of-speech detector, so the flow is "tap, speak" (no second tap).
 * Calibrates to the room from the quiet start, then ends after a pause once speech was heard.
 * PCM is s16le mono 16 kHz, so 32 bytes = 1 ms.
 */
export class Vad {
  private window: { rms: number; ms: number }[] = []
  private windowMs = 0
  private speechMs = 0
  private silenceMs = 0
  heardSpeech = false
  /** Live loudness above the room, 0..1 (drives the lens mic meter). */
  level = 0

  constructor(private opts = { minLevel: 400, factor: 3, windowMs: 1500, minSpeechMs: 200, endSilenceMs: 900 }) {}

  /**
   * Background level: the quietest moment in the last ~1.5 s. Speech has gaps between
   * syllables and words, so its quiet moments reveal the room; steady hum never rises
   * above itself, so it's never mistaken for speech.
   */
  private floor(): number {
    return this.window.length ? Math.min(...this.window.map(w => w.rms)) : Infinity
  }

  /** Feed one chunk; returns true when the speaker has finished. */
  push(pcm: Uint8Array): boolean {
    const n = pcm.byteLength >> 1
    if (!n) return false
    const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2)
    let sum = 0
    for (let i = 0; i < n; i++) {
      const v = view.getInt16(i * 2, true)
      sum += v * v
    }
    const rms = Math.sqrt(sum / n)
    const ms = n / 16
    const threshold = Math.max(this.opts.minLevel, this.floor() * this.opts.factor)
    const room = Math.max(this.opts.minLevel / this.opts.factor, Math.min(this.floor(), rms))
    this.level = Math.max(0, Math.min(1, Math.log10(Math.max(rms, 1) / room) / 1.3))
    this.window.push({ rms, ms })
    this.windowMs += ms
    while (this.window.length > 1 && this.windowMs - this.window[0].ms >= this.opts.windowMs) this.windowMs -= this.window.shift()!.ms

    if (rms > threshold) {
      this.speechMs += ms
      this.silenceMs = 0
      if (this.speechMs >= this.opts.minSpeechMs) this.heardSpeech = true
    } else {
      this.silenceMs += ms
      if (!this.heardSpeech) this.speechMs = Math.max(0, this.speechMs - ms) // ignore clicks/blips
    }
    return this.heardSpeech && this.silenceMs >= this.opts.endSilenceMs
  }
}
const MIN_PCM_BYTES = 16000 // 0.5 s of 16 kHz s16le mono
const MESSAGE_MS = 2500
const PAYMENT_MS = 4000

/** Screens a payment takeover may interrupt (never mid-voice or mid-confirm). */
const INTERRUPTIBLE = new Set<Screen['kind']>(['till', 'menu', 'waiting', 'order', 'message'])

export class TillController {
  screen: Screen = { kind: 'unpaired' }
  snapshot: TillSnapshot | null = null
  online = false
  /** Set by the companion page when the user wants voice-free testing. */
  onTranscript?: (text: string) => void
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastMeterAt = 0
  private ticker: ReturnType<typeof setInterval> | null = null
  private queuedPayments: PaymentEvent[] = []
  private lastListKey = ''

  constructor(
    private display: Display,
    private api: TillApi,
  ) {}

  // ---------- inputs from the outside world ----------

  setPaired(paired: boolean) {
    this.go(paired ? { kind: 'till' } : { kind: 'unpaired' })
  }

  setOnline(online: boolean) {
    this.online = online
    if (this.screen.kind === 'till') this.render()
  }

  setSnapshot(s: TillSnapshot) {
    this.snapshot = s
    // Refresh passive screens in place; never disturb voice/confirm flows.
    if (this.screen.kind === 'till' || this.screen.kind === 'menu' || this.screen.kind === 'waiting') this.render()
  }

  onPayment(p: PaymentEvent) {
    if (INTERRUPTIBLE.has(this.screen.kind)) this.showPayment(p)
    else this.queuedPayments.push(p)
  }

  /** Text command typed on the phone (testing / noisy places): same confirm flow as voice. */
  async typed(text: string) {
    if (this.screen.kind === 'listening') await this.stopListening('cancel')
    this.go({ kind: 'thinking', transcript: text })
    await this.handleResult(() => this.api.command(text))
  }

  async gesture(g: Gesture) {
    const s = this.screen
    if (g.kind === 'audio') {
      if (s.kind === 'listening') {
        s.chunks.push(g.pcm)
        if (s.vad.push(g.pcm)) return void this.stopListening('auto') // speaker paused: send
        if (Date.now() - this.lastMeterAt > 300) {
          this.lastMeterAt = Date.now()
          void this.render() // live mic meter (only the changed parts are redrawn)
        }
      }
      return
    }
    if (g.kind === 'exit') return this.stopListening('cancel')
    if (g.kind === 'foreground') {
      if (g.on) this.render()
      else if (s.kind === 'listening') {
        await this.stopListening('cancel') // never leave the mic open in the background
        this.screen = { kind: 'till' }
      }
      return
    }

    switch (s.kind) {
      case 'unpaired':
        if (g.kind === 'double') return this.display.exitDialog()
        return
      case 'till':
        if (g.kind === 'tap') return this.startListening()
        if (g.kind === 'up' || g.kind === 'down') return this.go({ kind: 'menu' })
        if (g.kind === 'double') return this.display.exitDialog()
        return
      case 'menu':
        if (g.kind === 'double') return this.go({ kind: 'till' })
        if (g.kind === 'select') return this.menuSelect(g.index)
        return
      case 'waiting':
        if (g.kind === 'double') return this.go({ kind: 'till' })
        if (g.kind === 'select') {
          const order = this.snapshot?.waiting[g.index]
          return order ? this.go({ kind: 'order', order }) : this.go({ kind: 'till' })
        }
        return
      case 'order':
        if (g.kind === 'double') return this.go({ kind: 'waiting' })
        if (g.kind === 'select') return this.orderSelect(s.order, g.index)
        return
      case 'listening':
        if (g.kind === 'tap') return this.stopListening('manual')
        if (g.kind === 'double') {
          await this.stopListening('cancel')
          return this.go({ kind: 'till' })
        }
        return
      case 'thinking':
        return
      case 'confirm':
        if (g.kind === 'tap') return this.confirm(s.confirm)
        if (g.kind === 'double') {
          void this.api.discard(s.confirm.id)
          return this.message('Not sent')
        }
        return
      case 'message':
        if (g.kind === 'tap' || g.kind === 'double') return this.go({ kind: 'till' })
        return
      case 'payment':
        if (g.kind === 'tap' || g.kind === 'double') return this.go(s.back)
        return
    }
  }

  // ---------- flows ----------

  private async startListening() {
    // Start buffering audio *before* anything else: people talk the instant they tap, and
    // frames that arrive while we wait for audioControl() to resolve would otherwise be lost
    // (measured in the simulator: ~0.75 s, enough to cut off "Charge").
    // The mic-on call is also queued ahead of the screen redraw, which is slow over BLE.
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.screen = { kind: 'listening', startedAt: Date.now(), chunks: [], vad: new Vad() }
    const micOn = this.display.mic(true).catch(() => false)
    void this.render()
    if (!(await micOn)) {
      this.screen = { kind: 'till' }
      return this.message('Mic not available', ['Type a charge on your phone'])
    }
    this.ticker = setInterval(() => {
      if (this.screen.kind !== 'listening') return this.clearTicker()
      const left = MAX_LISTEN_SEC - Math.floor((Date.now() - this.screen.startedAt) / 1000)
      if (left <= 0) void this.stopListening('auto')
      else void this.render()
    }, 1000)
  }

  /**
   * manual: the user tapped to finish, so send whatever we have.
   * auto:   pause detected or time limit, so send only if speech was actually heard
   *         (Whisper tends to invent text for silence).
   * cancel: close the mic, send nothing.
   */
  private async stopListening(mode: 'manual' | 'auto' | 'cancel') {
    this.clearTicker()
    const s = this.screen
    if (s.kind !== 'listening') return
    this.screen = { kind: 'thinking' } // leave 'listening' at once so late frames / a second trigger are ignored
    await this.display.mic(false).catch(() => false)
    if (mode === 'cancel') return
    const pcm = concat(s.chunks)
    if (pcm.byteLength < MIN_PCM_BYTES || (mode === 'auto' && !s.vad.heardSpeech))
      return this.message("Didn't hear anything", ['Tap, then say e.g.', '"Charge Maria twelve"'])
    this.go({ kind: 'thinking' })
    await this.handleResult(() => this.api.voice(pcm))
  }

  private async handleResult(call: () => Promise<InterpretResult>) {
    try {
      const r = await call()
      if (r.transcript) this.onTranscript?.(r.transcript)
      if (r.action === 'confirm' && r.confirm) return this.go({ kind: 'confirm', confirm: r.confirm, startedAt: Date.now() })
      if (r.action === 'done') return this.message(r.message ?? 'Done')
      return this.message(r.message ?? "Didn't catch that", r.examples)
    } catch (err) {
      return this.message((err as Error).message || 'Network error')
    }
  }

  private async confirm(c: Confirm) {
    this.go({ kind: 'thinking', transcript: c.kind === 'charge' ? `Sending to ${c.label}` : `Cancelling ${c.label}` })
    try {
      const r = await this.api.confirm(c.id)
      return this.message(r.message)
    } catch (err) {
      return this.message((err as Error).message)
    }
  }

  private async menuSelect(i: number) {
    switch (i) {
      case 0:
        return this.go({ kind: 'till' }).then(() => this.startListening())
      case 1:
        this.go({ kind: 'thinking', transcript: 'Repeat last charge' })
        return this.handleResult(() => this.api.repeat())
      case 2:
        return this.go({ kind: 'waiting' })
      case 3:
        this.go({ kind: 'thinking', transcript: 'Reminding everyone waiting' })
        return this.handleResult(() => this.api.command('remind all'))
      default:
        return this.go({ kind: 'till' })
    }
  }

  private async orderSelect(order: WaitingOrder, i: number) {
    try {
      if (i === 0) {
        const r = await this.api.remind(order.id)
        return this.message(r.message)
      }
      if (i === 1) {
        await this.api.cancel(order.id)
        return this.message(`Cancelled ${order.label}`)
      }
    } catch (err) {
      return this.message((err as Error).message)
    }
    return this.go({ kind: 'waiting' })
  }

  private showPayment(p: PaymentEvent) {
    const back: Screen = this.screen.kind === 'payment' ? this.screen.back : this.screen.kind === 'message' ? { kind: 'till' } : this.screen
    this.go({ kind: 'payment', event: p, back })
    this.timer = setTimeout(() => this.go(back), PAYMENT_MS)
  }

  private message(text: string, examples?: string[]) {
    this.go({ kind: 'message', text, examples })
    this.timer = setTimeout(() => this.go({ kind: 'till' }), examples?.length ? MESSAGE_MS * 2 : MESSAGE_MS)
  }

  // ---------- rendering ----------

  private go(next: Screen): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (next.kind !== 'listening') this.clearTicker()
    this.screen = next
    if (next.kind === 'confirm') {
      // Visible countdown; when it runs out the request is dropped (the server would refuse it anyway).
      this.ticker = setInterval(() => {
        if (this.screen !== next) return this.clearTicker()
        if (this.confirmLeft(next) <= 0) {
          this.clearTicker()
          void this.api.discard(next.confirm.id)
          void this.message('Timed out, not sent')
        } else void this.render()
      }, 1000)
    }
    if (next.kind !== 'menu' && next.kind !== 'waiting' && next.kind !== 'order') this.lastListKey = '' // display is back in text layout
    // Payments that arrived mid-voice/confirm are shown as soon as we're back on a passive screen.
    if (INTERRUPTIBLE.has(next.kind) && next.kind !== 'message' && this.queuedPayments.length) {
      this.showPayment(this.queuedPayments.shift()!)
      return Promise.resolve()
    }
    return this.render()
  }

  render(): Promise<void> {
    const s = this.screen
    const snap = this.snapshot
    switch (s.kind) {
      case 'unpaired':
        return this.display.card(unpairedCard())
      case 'till':
        return this.display.card(snap ? (this.online ? tillCard(snap) : offlineCard(snap)) : offlineCard())
      case 'menu':
        return this.listOnce('MENU        TAP  choose        2x TAP  back', menuItems(snap, null))
      case 'waiting':
        return this.listOnce('WAITING     TAP  actions       2x TAP  back', waitingItems(snap ?? emptySnap))
      case 'order':
        return this.listOnce(`${s.order.label}  ${s.order.amount} GRAM  ${s.order.code}`, orderActionItems(s.order))
      case 'listening':
        return this.display.card(listeningCard(MAX_LISTEN_SEC - Math.floor((Date.now() - s.startedAt) / 1000), snap, s.vad.level, s.vad.heardSpeech))
      case 'thinking':
        return this.display.card(thinkingCard(s.transcript, snap))
      case 'confirm':
        return this.display.card(confirmCard(s.confirm, snap, this.confirmLeft(s)))
      case 'message':
        return this.display.card(messageCard(s.text, s.examples, snap))
      case 'payment':
        return this.display.card(paymentCard(s.event, snap))
    }
  }

  private confirmLeft(s: { confirm: Confirm; startedAt: number }) {
    return s.confirm.expiresInSec - 1 - Math.floor((Date.now() - s.startedAt) / 1000)
  }

  /** Rebuilding a list resets its scroll position, so only rebuild when the items changed. */
  private listOnce(header: string, items: string[]) {
    const key = `${this.screen.kind}|${header}|${items.join('|')}`
    if (key === this.lastListKey) return Promise.resolve()
    this.lastListKey = key
    return this.display.list(header, items)
  }

  private clearTicker() {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }
}

const emptySnap: TillSnapshot = {
  seller: { name: '', address: '', network: 'testnet' },
  today: { total: '0', paid: 0, unmatched: 0, waiting: 0 },
  waiting: [],
  recent: [],
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}
