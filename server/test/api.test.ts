import { describe, expect, it } from 'vitest'
import { Address } from '@ton/core'
import { buildApi } from '../src/api.js'
import { Store } from '../src/db.js'
import { toNano } from '../src/money.js'
import { TillBus, processIncoming } from '../src/processor.js'
import { TillService, isValidTimezone, startOfLocalDay, tzOffsetSeconds, type Notifier } from '../src/service.js'
import { pcmToWav } from '../src/stt.js'

const ADDR = 'EQD2NmD_lH5f5u1Kj3KfGyTvhZSX0Eg6qp2a5IQUKXxOG21n'

function setup() {
  const store = new Store()
  const bus = new TillBus()
  const sent: { label: string; reminder: boolean }[] = []
  const notifier: Notifier = {
    async requestPayment(_s, order, customer, reminder) {
      if (!customer?.tgChatId) return false
      sent.push({ label: order.label, reminder })
      return true
    },
  }
  const service = new TillService(store, bus, notifier, {
    network: 'testnet',
    publicUrl: 'https://till.example',
    timezone: 'Africa/Lagos',
    orderTtlMinutes: 30,
    maxChargeGram: 500,
  })
  const app = buildApi({ store, bus, service, stt: { baseUrl: 'x', model: 'x' }, publicUrl: 'https://till.example', devSimulate: true })
  const seller = store.createSeller("Mama T's Kitchen", ADDR, Address.parse(ADDR).toRawString(), 111)
  store.upsertCustomer(seller.id, 'Tunde', 222)
  store.setMenuItem(seller.id, 'jollof', toNano('12'))
  return { store, bus, service, app, seller, sent }
}

async function pair(s: ReturnType<typeof setup>) {
  const code = s.store.createPairCode(s.seller.id)
  const res = await s.app.request('/api/pair', { method: 'POST', body: JSON.stringify({ code }), headers: { 'Content-Type': 'application/json' } })
  expect(res.status).toBe(200)
  const { token } = (await res.json()) as any
  return (path: string, init: RequestInit = {}) =>
    s.app.request(path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
}

describe('API', () => {
  it('rejects unpaired requests and one-time pairing codes', async () => {
    const s = setup()
    expect((await s.app.request('/api/till')).status).toBe(401)
    const code = s.store.createPairCode(s.seller.id)
    const body = JSON.stringify({ code })
    const h = { 'Content-Type': 'application/json' }
    expect((await s.app.request('/api/pair', { method: 'POST', body, headers: h })).status).toBe(200)
    expect((await s.app.request('/api/pair', { method: 'POST', body, headers: h })).status).toBe(401) // already used
  })

  it('voice text -> preview -> confirm -> request sent -> paid -> till updated', async () => {
    const s = setup()
    const api = await pair(s)

    const prev = (await (await api('/api/command', { method: 'POST', body: JSON.stringify({ text: 'Charge Tunde fifteen for jollof' }) })).json()) as any
    expect(prev.action).toBe('confirm')
    expect(prev.confirm).toMatchObject({ kind: 'charge', label: 'Tunde', amount: '15', item: 'jollof', reachable: true })
    expect(s.store.waitingOrders(s.seller.id)).toHaveLength(0) // nothing created before the tap

    const done = (await (await api(`/api/confirm/${prev.confirm.id}`, { method: 'POST' })).json()) as any
    expect(done).toMatchObject({ ok: true, delivered: true })
    expect(s.sent).toEqual([{ label: 'Tunde', reminder: false }])
    // A confirmation can only be used once.
    expect((await api(`/api/confirm/${prev.confirm.id}`, { method: 'POST' })).status).toBe(410)

    const code = done.order.code as string
    const pay = await s.app.request(`/dev/pay/${code}`, { method: 'POST' })
    expect(((await pay.json()) as any).result).toBe('paid')

    const till = (await (await api('/api/till')).json()) as any
    expect(till.today).toMatchObject({ total: '15', paid: 1, waiting: 0 })
    expect(till.recent[0]).toMatchObject({ amount: '15', result: 'paid', label: 'Tunde' })
  })

  it('prices menu items with quantity and labels tables', async () => {
    const s = setup()
    const api = await pair(s)
    const r = (await (await api('/api/command', { method: 'POST', body: JSON.stringify({ text: 'charge table 4 for two jollof' }) })).json()) as any
    expect(r.confirm).toMatchObject({ label: 'Table 4', amount: '24', item: '2× jollof', reachable: false })
  })

  it('refuses charges over the limit and unknown items', async () => {
    const s = setup()
    const api = await pair(s)
    const big = (await (await api('/api/command', { method: 'POST', body: JSON.stringify({ text: 'charge Tunde 900' }) })).json()) as any
    expect(big).toMatchObject({ action: 'error' })
    const unk = (await (await api('/api/command', { method: 'POST', body: JSON.stringify({ text: 'charge pizza' }) })).json()) as any
    expect(unk.action).toBe('error')
  })

  it('repeat, remind and cancel', async () => {
    const s = setup()
    const api = await pair(s)
    const p = (await (await api('/api/command', { method: 'POST', body: JSON.stringify({ text: 'charge Tunde 5' }) })).json()) as any
    await api(`/api/confirm/${p.confirm.id}`, { method: 'POST' })
    const rep = (await (await api('/api/repeat', { method: 'POST' })).json()) as any
    expect(rep.confirm).toMatchObject({ label: 'Tunde', amount: '5' })
    const rem = (await (await api('/api/command', { method: 'POST', body: JSON.stringify({ text: 'remind all' }) })).json()) as any
    expect(rem).toMatchObject({ action: 'done', message: 'Reminded 1' })
    expect(s.sent.at(-1)).toEqual({ label: 'Tunde', reminder: true })
    const can = (await (await api('/api/command', { method: 'POST', body: JSON.stringify({ text: 'cancel last' }) })).json()) as any
    expect(can.confirm).toMatchObject({ kind: 'cancel', label: 'Tunde' })
    await api(`/api/confirm/${can.confirm.id}`, { method: 'POST' })
    expect(s.store.waitingOrders(s.seller.id)).toHaveLength(0)
  })

  it("uses each seller's own time zone for today's totals", async () => {
    const s = setup()
    const api = await pair(s)
    s.store.updateSellerTimezone(s.seller.id, 'Pacific/Kiritimati') // UTC+14, the earliest "today" on Earth
    s.store.recordPayment({ txHash: 'y', sellerId: s.seller.id, amountNano: toNano('3'), comment: null, from: null, utime: Math.floor(Date.now() / 1000) - 60, result: 'unmatched', orderId: null })
    const till = (await (await api('/api/till')).json()) as any
    expect(till.today.total).toBe('3')
  })

  it('serves the pay page and status', async () => {
    const s = setup()
    const order = s.store.createOrder({ sellerId: s.seller.id, label: 'Tunde', amountNano: toNano('15'), item: 'jollof' })
    const page = await s.app.request(`/pay/${order.code}`)
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(html).toContain('15 GRAM')
    expect(html).toContain('TESTNET')
    expect(html).toContain(`ton://transfer/${ADDR}?amount=15000000000&amp;text=${order.code}`)
    expect(html).toContain("Mama T&#39;s Kitchen") // escaped
    processIncoming(s.store, s.bus, s.seller.id, { txHash: 't1', from: null, amountNano: toNano('15'), comment: order.code, utime: Math.floor(Date.now() / 1000) })
    expect(await (await s.app.request(`/pay/${order.code}/status`)).json()).toEqual({ status: 'paid', expired: false })
    expect((await s.app.request('/pay/GT-NOPE')).status).toBe(404)
  })
})

describe('helpers', () => {
  it('starts "today" at local midnight in any time zone', () => {
    const t = Date.UTC(2026, 10, 22, 12, 0) / 1000 // noon UTC
    expect(startOfLocalDay('UTC', t)).toBe(Date.UTC(2026, 10, 22, 0, 0) / 1000)
    expect(startOfLocalDay('Asia/Tokyo', t)).toBe(Date.UTC(2026, 10, 21, 15, 0) / 1000) // UTC+9
    expect(startOfLocalDay('America/New_York', t)).toBe(Date.UTC(2026, 10, 22, 5, 0) / 1000) // UTC-5 (standard time)
    expect(startOfLocalDay('Asia/Kolkata', t)).toBe(Date.UTC(2026, 10, 21, 18, 30) / 1000) // UTC+5:30
    expect(startOfLocalDay('Europe/Berlin', t)).toBe(Date.UTC(2026, 10, 21, 23, 0) / 1000) // UTC+1
  })
  it('validates IANA time zones', () => {
    expect(isValidTimezone('America/Sao_Paulo')).toBe(true)
    expect(isValidTimezone('Mars/Olympus')).toBe(false)
  })
  it('computes Lagos day start', () => {
    expect(tzOffsetSeconds('Africa/Lagos')).toBe(3600)
    // 2026-11-22 00:30 Lagos = 2026-11-21 23:30 UTC -> day starts 2026-11-21 23:00 UTC
    const t = Date.UTC(2026, 10, 21, 23, 30) / 1000
    expect(startOfLocalDay('Africa/Lagos', t)).toBe(Date.UTC(2026, 10, 21, 23, 0) / 1000)
  })
  it('wraps PCM as WAV', () => {
    const wav = pcmToWav(new Uint8Array(32000))
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF')
    expect(wav.byteLength).toBe(32044)
  })
})
