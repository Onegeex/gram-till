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
  | { kind: 'listening'; startedAt: number; chunks: Uint8Array[] }
  | { kind: 'thinking'; transcript?: string }
  | { kind: 'confirm'; confirm: Confirm }
  | { kind: 'message'; text: string; examples?: string[] }
  | { kind: 'payment'; event: PaymentEvent; back: Screen }

export const MAX_LISTEN_SEC = 8
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
    if (this.screen.kind === 'listening') this.stopListening(false)
    this.go({ kind: 'thinking', transcript: text })
    await this.handleResult(() => this.api.command(text))
  }

  async gesture(g: Gesture) {
    const s = this.screen
    if (g.kind === 'audio') {
      if (s.kind === 'listening') s.chunks.push(g.pcm)
      return
    }
    if (g.kind === 'exit') return this.stopListening(false)
    if (g.kind === 'foreground') {
      if (g.on) this.render()
      else if (s.kind === 'listening') this.stopListening(false) // never leave the mic open in the background
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
        if (g.kind === 'tap') return this.stopListening(true)
        if (g.kind === 'double') {
          this.stopListening(false)
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
    const ok = await this.display.mic(true).catch(() => false)
    if (!ok) return this.message('Mic not available', ['Type a charge on your phone'])
    this.go({ kind: 'listening', startedAt: Date.now(), chunks: [] })
    this.ticker = setInterval(() => {
      if (this.screen.kind !== 'listening') return this.clearTicker()
      const left = MAX_LISTEN_SEC - Math.floor((Date.now() - this.screen.startedAt) / 1000)
      if (left <= 0) void this.stopListening(true)
      else void this.display.text(listeningCard(left))
    }, 1000)
  }

  private async stopListening(send: boolean) {
    this.clearTicker()
    const s = this.screen
    if (s.kind !== 'listening') return
    await this.display.mic(false).catch(() => false)
    if (!send) return
    const pcm = concat(s.chunks)
    if (pcm.byteLength < MIN_PCM_BYTES) return this.message("Didn't hear anything", ['Tap, speak, then tap again'])
    this.go({ kind: 'thinking' })
    await this.handleResult(() => this.api.voice(pcm))
  }

  private async handleResult(call: () => Promise<InterpretResult>) {
    try {
      const r = await call()
      if (r.transcript) this.onTranscript?.(r.transcript)
      if (r.action === 'confirm' && r.confirm) return this.go({ kind: 'confirm', confirm: r.confirm })
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
        return this.display.text(unpairedCard())
      case 'till':
        return this.display.text(snap ? (this.online ? tillCard(snap) : offlineCard(snap.seller.name)) : offlineCard())
      case 'menu':
        return this.listOnce('GRAM TILL  |  menu  (2x tap = back)', menuItems(snap, null))
      case 'waiting':
        return this.listOnce('WAITING  (tap = actions, 2x = back)', waitingItems(snap ?? emptySnap))
      case 'order':
        return this.listOnce(`${s.order.label}  ${s.order.amount} GRAM  ${s.order.code}`, orderActionItems(s.order))
      case 'listening':
        return this.display.text(listeningCard(MAX_LISTEN_SEC - Math.floor((Date.now() - s.startedAt) / 1000)))
      case 'thinking':
        return this.display.text(thinkingCard(s.transcript))
      case 'confirm':
        return this.display.text(confirmCard(s.confirm))
      case 'message':
        return this.display.text(messageCard(s.text, s.examples))
      case 'payment':
        return this.display.text(paymentCard(s.event))
    }
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
