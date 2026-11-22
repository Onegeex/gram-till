import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { TillController, type TillApi } from '../src/controller'
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

  it('auto-stops listening after the limit', async () => {
    const { c, api } = setup()
    await c.gesture({ kind: 'tap' })
    await c.gesture(pcm(40000))
    await vi.advanceTimersByTimeAsync(9000)
    expect(api.calls).toContain('voice:40000')
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
