import { describe, expect, it } from 'vitest'
import { buildApi } from '../src/api.js'
import { toNano } from '../src/money.js'
import { processIncoming } from '../src/processor.js'
import { TillService, nullNotifier } from '../src/service.js'
import { ADDR, makeStore, rawOf } from './helpers.js'

/** Two API "instances" sharing one store = two Vercel Function instances sharing Postgres. */
async function setup() {
  const store = await makeStore()
  const cfg = { network: 'testnet' as const, publicUrl: 'https://till.example', timezone: 'UTC', orderTtlMinutes: 30, maxChargeGram: 500 }
  const make = () =>
    buildApi({ store, service: new TillService(store, nullNotifier, cfg), stt: { baseUrl: 'x', model: 'x' }, publicUrl: cfg.publicUrl, devSimulate: false, sse: { pollMs: 25, maxSec: 2 } })
  const seller = await store.createSeller('Corner Coffee', ADDR, rawOf(ADDR), 1)
  await store.upsertCustomer(seller.id, 'Maria', null)
  const { token } = (await (await make().request('/api/pair', { method: 'POST', body: JSON.stringify({ code: await store.createPairCode(seller.id) }), headers: { 'Content-Type': 'application/json' } })).json()) as any
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  return { store, seller, a: make(), b: make(), auth }
}

describe('Vercel mode (stateless API instances + separate watcher)', () => {
  it('a preview made on one instance can be confirmed on another, exactly once', async () => {
    const { a, b, auth, store, seller } = await setup()
    const prev = (await (await a.request('/api/command', { method: 'POST', body: JSON.stringify({ text: 'charge Maria 12' }), headers: auth })).json()) as any
    expect(prev.action).toBe('confirm')
    const ok = await b.request(`/api/confirm/${prev.confirm.id}`, { method: 'POST', headers: auth })
    expect(ok.status).toBe(200)
    expect((await a.request(`/api/confirm/${prev.confirm.id}`, { method: 'POST', headers: auth })).status).toBe(410)
    expect(await store.waitingOrders(seller.id)).toHaveLength(1)
    await store.close()
  })

  it('a payment recorded by the watcher process streams to a connected glasses app', async () => {
    const { a, auth, store, seller } = await setup()
    const order = await store.createOrder({ sellerId: seller.id, label: 'Maria', amountNano: toNano('12') })
    const res = await a.request('/api/stream', { headers: auth })
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    const readUntil = async (needle: string) => {
      const end = Date.now() + 3000
      while (!text.includes(needle) && Date.now() < end) {
        const { value, done } = await reader.read()
        if (done) break
        text += dec.decode(value)
      }
      return text.includes(needle)
    }
    expect(await readUntil('event: till')).toBe(true)
    // ... meanwhile, in the daemon:
    await processIncoming(store, seller.id, { txHash: 'tx-1', from: null, amountNano: toNano('12'), comment: order.code, utime: Math.floor(Date.now() / 1000) })
    expect(await readUntil('event: payment')).toBe(true)
    expect(text).toContain('"result":"paid"')
    expect(text).toMatch(/id: \d+/) // event ids let EventSource resume after a reconnect
    await reader.cancel()
    await store.close()
  })

  it('a reconnecting stream resumes from Last-Event-ID without missing payments', async () => {
    const { a, auth, store, seller } = await setup()
    const before = await store.latestEventId(seller.id)
    await processIncoming(store, seller.id, { txHash: 'tx-2', from: null, amountNano: toNano('3'), comment: null, utime: Math.floor(Date.now() / 1000) })
    const res = await a.request('/api/stream', { headers: { ...auth, 'Last-Event-ID': String(before) } })
    const reader = res.body!.getReader()
    let text = ''
    const end = Date.now() + 3000
    while (!text.includes('event: payment') && Date.now() < end) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    expect(text).toContain('"result":"unmatched"')
    await reader.cancel()
    await store.close()
  })

  it('Telegram onboarding steps survive across instances (stored, not in memory)', async () => {
    const { store } = await setup()
    await store.setBotStep(42, { step: 'wallet', name: 'Corner Coffee' })
    expect(await store.getBotStep(42)).toEqual({ step: 'wallet', name: 'Corner Coffee' })
    await store.setBotStep(42, null)
    expect(await store.getBotStep(42)).toBeNull()
    await store.close()
  })
})
