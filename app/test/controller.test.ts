import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { TillController, Vad, type TillApi } from '../src/controller'
import { toGestures, type Display } from '../src/display'
import { tillCard, type PaymentEvent, type TillSnapshot } from '../src/format'

class FakeDisplay implements Display {
  frames: string[] = []
  micState = false
  exits = 0
  get last() {
    return this.frames[this.frames.length - 1]
  }
  async text(c: string) {
    this.frames.push(c)
  }
  async list(header: string, items: string[]) {
    this.frames.push(`[LIST] ${header}\n${items.join('\n')}`)
  }
  async mic(on: boolean) {
    this.micState = on
    return true
  }
  async exitDialog() {
    this.exits++
  }
}

const snap: TillSnapshot = {
  seller: { name: "Mama T's", address: 'x', network: 'testnet' },
  today: { total: '214', paid: 18, unmatched: 0, waiting: 1 },
  waiting: [{ id: 7, code: 'GT-7F3K', label: 'Tunde', item: 'jollof', amount: '15', status: 'waiting', agoMin: 3, expired: false }],
  recent: [{ amount: '12', result: 'paid', label: 'Table 4', comment: 'GT-AAAA', agoMin: 2 }],
}

const paid: PaymentEvent = { result: 'paid', amount: '15', label: 'Tunde', code: 'GT-7F3K', item: 'jollof', late: false, comment: 'GT-7F3K' }
const confirmCharge = { id: 'c1', kind: 'charge' as const, label: 'Tunde', amount: '15', item: 'jollof', reachable: true, expiresInSec: 20 }

function makeApi(over: Partial<TillApi> = {}): TillApi & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    voice: vi.fn(async (pcm: Uint8Array) => (calls.push(`voice:${pcm.byteLength}`), { transcript: 'charge tunde 15', action: 'confirm' as const, confirm: confirmCharge })),
    command: vi.fn(async (t: string) => (calls.push(`command:${t}`), { transcript: t, action: 'done' as const, message: 'Reminded 1' })),
    repeat: vi.fn(async () => ({ transcript: 'repeat', action: 'confirm' as const, confirm: confirmCharge })),
    confirm: vi.fn(async (id: string) => (calls.push(`confirm:${id}`), { ok: true, message: 'Sent to Tunde on Telegram' })),
    discard: vi.fn(async (id: string) => calls.push(`discard:${id}`)),
    remind: vi.fn(async () => ({ ok: true, message: 'Reminder sent' })),
    cancel: vi.fn(async () => ({ ok: true })),
    ...over,
  }
}

function setup(api = makeApi()) {
  const d = new FakeDisplay()
  const c = new TillController(d, api)
  c.setSnapshot(snap)
  c.setOnline(true)
  c.setPaired(true)
  return { d, c, api }
}

const pcm = (bytes: number) => ({ kind: 'audio' as const, pcm: new Uint8Array(bytes) })
/** s16le mono 16 kHz: a loud 300 Hz tone ("speech") or near-silence, `ms` long. */
function audio(ms: number, loud: boolean) {
  const n = ms * 16
  const buf = new Uint8Array(n * 2)
  const v = new DataView(buf.buffer)
  for (let i = 0; i < n; i++) v.setInt16(i * 2, loud ? Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / 16000)) : (i % 7) - 3, true)
  return { kind: 'audio' as const, pcm: buf }
}
const speak = async (c: TillController, ms: number) => {
  for (let t = 0; t < ms; t += 200) {
    await c.gesture(audio(160, true)) // syllable
    await c.gesture(audio(40, false)) // gap
  }
}
const quiet = async (c: TillController, ms: number) => { for (let t = 0; t < ms; t += 100) await c.gesture(audio(100, false)) }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('TillController', () => {
  it('shows the till card when paired', () => {
    const { d } = setup()
    expect(d.last).toBe(tillCard(snap))
    expect(d.last).toContain('TODAY  214 GRAM')
  })

  it('tap -> listen -> tap -> confirm card -> tap -> sent', async () => {
    const { d, c, api } = setup()
    await c.gesture({ kind: 'tap' })
    expect(d.micState).toBe(true)
    expect(d.last).toContain('LISTENING')
    await c.gesture(pcm(20000))
    await c.gesture(pcm(20000))
    await c.gesture({ kind: 'tap' })
    expect(d.micState).toBe(false)
    expect(api.calls).toContain('voice:40000')
    expect(d.last).toContain('CHARGE Tunde')
    expect(d.last).toContain('tap = SEND')
    await c.gesture({ kind: 'tap' })
    expect(api.calls).toContain('confirm:c1')
    expect(d.last).toContain('Sent to Tunde')
    vi.advanceTimersByTime(3000)
    expect(d.last).toBe(tillCard(snap))
  })

  it('keeps audio that arrives before the mic confirms (no clipped first word)', async () => {
    const { d, c, api } = setup()
    let resolveMic!: (v: boolean) => void
    d.mic = async (on: boolean) => {
      d.micState = on
      return on ? new Promise<boolean>(r => (resolveMic = r)) : true
    }
    const tap = c.gesture({ kind: 'tap' }) // mic not confirmed yet...
    await c.gesture(pcm(20000)) // ...but the user is already saying "Charge"
    resolveMic(true)
    await tap
    await c.gesture(pcm(20000))
    await c.gesture({ kind: 'tap' })
    expect(api.calls).toContain('voice:40000')
  })

  it('double-tap on the confirm card discards it and nothing is sent', async () => {
    const { d, c, api } = setup()
    await c.gesture({ kind: 'tap' })
    await c.gesture(pcm(40000))
    await c.gesture({ kind: 'tap' })
    await c.gesture({ kind: 'double' })
    expect(api.calls).toContain('discard:c1')
    expect(api.calls).not.toContain('confirm:c1')
    expect(d.last).toContain('Not sent')
  })

  it('too-short audio is not sent to speech-to-text', async () => {
    const { d, c, api } = setup()
    await c.gesture({ kind: 'tap' })
    await c.gesture(pcm(1000))
    await c.gesture({ kind: 'tap' })
    expect(api.calls.some(x => x.startsWith('voice'))).toBe(false)
    expect(d.last).toContain("Didn't hear")
  })

  it('sends automatically when the speaker pauses (tap, speak, done)', async () => {
    const { d, c, api } = setup()
    await c.gesture({ kind: 'tap' })
    await quiet(c, 300) // room noise while the user starts
    await speak(c, 1200) // "Charge Maria twelve"
    expect(api.calls.some(x => x.startsWith('voice'))).toBe(false) // still listening
    await quiet(c, 1000) // pause -> send
    expect(api.calls.some(x => x.startsWith('voice'))).toBe(true)
    expect(d.micState).toBe(false)
    expect(d.last).toContain('CHARGE Tunde') // fake API answers with Tunde's confirm card
  })

  it('a short pause mid-sentence does not cut the command', async () => {
    const { c, api } = setup()
    await c.gesture({ kind: 'tap' })
    await quiet(c, 200)
    await speak(c, 700) // "Charge table four,"
    await quiet(c, 500) // breath
    await speak(c, 600) // "two lattes"
    expect(api.calls.some(x => x.startsWith('voice'))).toBe(false)
  })

  it('time limit sends if speech was heard, and sends nothing for silence', async () => {
    const a = setup()
    await a.c.gesture({ kind: 'tap' })
    await speak(a.c, 500)
    await vi.advanceTimersByTimeAsync(9000)
    expect(a.api.calls.some(x => x.startsWith('voice'))).toBe(true)

    const b = setup()
    await b.c.gesture({ kind: 'tap' })
    await quiet(b.c, 2000)
    await vi.advanceTimersByTimeAsync(9000)
    expect(b.api.calls.some(x => x.startsWith('voice'))).toBe(false) // Whisper would invent text for silence
    expect(b.d.last).toContain("Didn't hear")
  })

  it('closes the mic when the app goes to the background', async () => {
    const { d, c } = setup()
    await c.gesture({ kind: 'tap' })
    await c.gesture({ kind: 'foreground', on: false })
    expect(d.micState).toBe(false)
  })

  it('payment takes over the till for a few seconds, then returns', () => {
    const { d, c } = setup()
    c.onPayment(paid)
    expect(d.last).toContain('PAID')
    expect(d.last).toContain('+15 GRAM')
    vi.advanceTimersByTime(4100)
    expect(d.last).toBe(tillCard(snap))
  })

  it('payment never interrupts a confirm card; it shows right after', async () => {
    const { d, c } = setup()
    await c.gesture({ kind: 'tap' })
    await c.gesture(pcm(40000))
    await c.gesture({ kind: 'tap' }) // confirm card up
    c.onPayment(paid)
    expect(d.last).toContain('CHARGE Tunde')
    await c.gesture({ kind: 'double' }) // discard -> message
    vi.advanceTimersByTime(2600) // message -> till -> queued payment
    expect(d.last).toContain('PAID')
  })

  it('swipe opens the menu; waiting -> order -> remind', async () => {
    const { d, c, api } = setup()
    await c.gesture({ kind: 'down' })
    expect(d.last).toContain('[LIST]')
    expect(d.last).toContain('Waiting orders (1)')
    await c.gesture({ kind: 'select', index: 2 })
    expect(d.last).toContain('Tunde  15 GRAM  3m')
    await c.gesture({ kind: 'select', index: 0 })
    expect(d.last).toContain('Remind Tunde')
    await c.gesture({ kind: 'select', index: 0 })
    expect(api.remind).toHaveBeenCalledWith(7)
    expect(d.last).toContain('Reminder sent')
  })

  it('menu "remind all" and double-tap back', async () => {
    const { d, c, api } = setup()
    await c.gesture({ kind: 'up' })
    await c.gesture({ kind: 'select', index: 3 })
    expect(api.calls).toContain('command:remind all')
    vi.advanceTimersByTime(3000)
    await c.gesture({ kind: 'down' })
    await c.gesture({ kind: 'double' })
    expect(d.last).toBe(tillCard(snap))
  })

  it('double-tap on the till opens the exit dialog', async () => {
    const { d, c } = setup()
    await c.gesture({ kind: 'double' })
    expect(d.exits).toBe(1)
  })

  it('typed commands from the phone use the same confirm flow', async () => {
    const api = makeApi({ command: vi.fn(async () => ({ transcript: 'charge tunde 15', action: 'confirm' as const, confirm: confirmCharge })) })
    const { d, c } = setup(api)
    await c.typed('charge Tunde 15')
    expect(d.last).toContain('CHARGE Tunde')
  })

  it('shows an honest card for unmatched money', () => {
    const { d, c } = setup()
    c.onPayment({ ...paid, result: 'unmatched', label: null, code: null, comment: 'thanks' })
    expect(d.last).toContain('MONEY IN')
    expect(d.last).toContain('No order code')
    expect(d.last).not.toContain('PAID')
  })
})

describe('toGestures', () => {
  it('maps SDK events, including protobuf-omitted zero values', () => {
    expect(toGestures({ sysEvent: {} } as any)).toEqual([{ kind: 'tap' }])
    expect(toGestures({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } } as any)).toEqual([{ kind: 'double' }])
    expect(toGestures({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } } as any)).toEqual([{ kind: 'down' }])
    expect(toGestures({ listEvent: {} } as any)).toEqual([{ kind: 'select', index: 0 }])
    expect(toGestures({ listEvent: { currentSelectItemIndex: 3 } } as any)).toEqual([{ kind: 'select', index: 3 }])
    expect(toGestures({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } } as any)).toEqual([{ kind: 'foreground', on: false }])
    expect(toGestures({ audioEvent: { audioPcm: new Uint8Array(4) } } as any)).toEqual([{ kind: 'audio', pcm: new Uint8Array(4) }]) // audio is not a tap
  })
})

describe('Vad (end-of-speech detection)', () => {
  function chunk(ms: number, amp: number, noise = 0) {
    const n = ms * 16
    const buf = new Uint8Array(n * 2)
    const v = new DataView(buf.buffer)
    let seed = 7
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const r = ((seed / 0x7fffffff) * 2 - 1) * noise
      v.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / 16000) + r))), true)
    }
    return buf
  }
  const feed = (vad: Vad, ms: number, amp: number, noise = 0) => {
    let done = false
    for (let t = 0; t < ms; t += 40) done = vad.push(chunk(40, amp, noise)) || done
    return done
  }
  it('works in a noisy place (cafe hum well above the absolute minimum)', () => {
    const vad = new Vad()
    expect(feed(vad, 600, 0, 1500)).toBe(false) // noise only: not speech
    expect(vad.heardSpeech).toBe(false)
    expect(feed(vad, 1000, 9000, 1500)).toBe(false) // talking over the noise
    expect(vad.heardSpeech).toBe(true)
    expect(feed(vad, 1000, 0, 1500)).toBe(true) // back to noise: done
  })
  it('detects speech that starts immediately (syllables with short gaps)', () => {
    const vad = new Vad()
    for (let i = 0; i < 4; i++) {
      feed(vad, 160, 3000) // syllable
      feed(vad, 40, 0) // gap between syllables
    }
    expect(vad.heardSpeech).toBe(true)
  })
  it('a steady tone/hum is never speech', () => {
    const vad = new Vad()
    expect(feed(vad, 3000, 3000)).toBe(false)
    expect(vad.heardSpeech).toBe(false)
  })
})

describe('Vad on real speech, in the 3,200-byte (100 ms) frames the SDK delivers', () => {
  // Fixtures: espeak-ng speech resampled to 16 kHz s16le mono; "-noisy" adds steady pink noise
  // (~ -32 dBFS, a busy cafe) with 0.5 s of noise before the speech.
  const load = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}.raw`, import.meta.url)))
  const silence = (ms: number) => new Uint8Array(ms * 32)
  /** Returns the time (ms from the start of the stream) when the VAD said "done", or null. */
  function endpoint(stream: Uint8Array): number | null {
    const vad = new Vad()
    for (let off = 0; off < stream.byteLength; off += 3200) {
      if (vad.push(stream.subarray(off, Math.min(off + 3200, stream.byteLength)))) return (off + 3200) / 32
    }
    return null
  }
  const join = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
    let o = 0
    for (const p of parts) (out.set(p, o), (o += p.byteLength))
    return out
  }

  it.each(['charge-maria-twelve', 'charge-table-four-two-lattes'])('%s: ends ~1 s after the speech, not before', name => {
    const speech = load(name)
    const speechMs = speech.byteLength / 32
    const t = endpoint(join(silence(200), speech, silence(2000)))
    expect(t).not.toBeNull()
    expect(t!).toBeGreaterThan(200 + speechMs - 600) // espeak adds ~0.3-0.5 s of trailing silence itself
    expect(t!).toBeLessThan(200 + speechMs + 1300)
  })

  it('works over cafe noise', () => {
    const noisy = load('charge-maria-twelve-noisy')
    const t = endpoint(noisy)
    expect(t).not.toBeNull()
    expect(t!).toBeGreaterThan(500 + 1000) // not before the phrase is mostly said
  })

  it('noise alone never ends a recording as speech', () => {
    const noisy = load('charge-maria-twelve-noisy')
    expect(endpoint(noisy.subarray(0, 450 * 32))).toBeNull() // just the 0.5 s of cafe noise before speaking
  })
})
