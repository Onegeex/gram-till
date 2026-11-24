import { describe, expect, it } from 'vitest'
import { Address, beginCell } from '@ton/core'
import { extractOrderCode, fromNano, newOrderCode, toNano } from '../src/money.js'
import { matchPayment, type MatchableOrder } from '../src/matcher.js'
import { extractPayment, parseComment, tonTransferLink, type TxLike } from '../src/ton.js'
import { processIncoming } from '../src/processor.js'
import { Watcher, type FetchTxs } from '../src/watcher.js'
import { makeStore } from './helpers.js'

const SELLER = 'EQD2NmD_lH5f5u1Kj3KfGyTvhZSX0Eg6qp2a5IQUKXxOG21n'
const PAYER = Address.parse('UQDYzZmfsrGzhObKJUw4gzdeIxEai3jAFbiGKGwxvxHinf4K')

let ltCounter = 1000n
function fakeTx(o: { amount: bigint; comment?: string; out?: number; external?: boolean; lt?: bigint; now?: number }): TxLike {
  const lt = o.lt ?? ltCounter++
  const body = o.comment !== undefined ? beginCell().storeUint(0, 32).storeStringTail(o.comment).endCell() : beginCell().endCell()
  return {
    lt,
    now: o.now ?? 1_800_000_000,
    hash: () => Buffer.from(lt.toString(16).padStart(64, '0'), 'hex'),
    outMessages: { size: o.out ?? 0 } as any,
    inMessage: o.external
      ? ({ info: { type: 'external-in', dest: PAYER }, body } as any)
      : ({ info: { type: 'internal', src: PAYER, value: { coins: o.amount } }, body } as any),
  }
}

describe('money', () => {
  it('converts amounts exactly', () => {
    expect(toNano('15')).toBe(15_000_000_000n)
    expect(toNano('0.1')).toBe(100_000_000n)
    expect(toNano(12.5)).toBe(12_500_000_000n)
    expect(() => toNano('1.2345678901')).toThrow()
    expect(() => toNano('-1')).toThrow()
    expect(fromNano(15_000_000_000n)).toBe('15')
    expect(fromNano(12_500_000_000n)).toBe('12.5')
    expect(fromNano(100_000_000n)).toBe('0.1')
  })

  it('generates and extracts order codes', () => {
    const code = newOrderCode()
    expect(code).toMatch(/^GT-[A-Z2-9]{4}$/)
    expect(extractOrderCode(`thanks! ${code.toLowerCase()} :)`)).toBe(code)
    expect(extractOrderCode('no code here')).toBeNull()
    expect(extractOrderCode(null)).toBeNull()
  })
})

describe('matchPayment', () => {
  const order: MatchableOrder = { id: 1, code: 'GT-7F3K', amountNano: toNano('15'), status: 'waiting', expiresAt: 2_000 }
  const pay = (amount: string, comment: string | null, utime = 1_000) => ({ txHash: 'h', from: null, amountNano: toNano(amount), comment, utime })

  it('marks an exact payment with the right code as paid', () => {
    const r = matchPayment(pay('15', 'GT-7F3K'), [order])
    expect(r.kind).toBe('paid')
  })
  it('accepts overpayment and reports it', () => {
    const r = matchPayment(pay('16', 'gt-7f3k tip'), [order])
    expect(r).toMatchObject({ kind: 'paid', overpaidNano: toNano('1') })
  })
  it('flags underpayment instead of marking paid', () => {
    expect(matchPayment(pay('14.9', 'GT-7F3K'), [order])).toMatchObject({ kind: 'underpaid', shortNano: toNano('0.1') })
  })
  it('never marks a payment without a known code as paid', () => {
    expect(matchPayment(pay('15', null), [order]).kind).toBe('unmatched')
    expect(matchPayment(pay('15', 'GT-ZZZZ'), [order]).kind).toBe('unmatched')
  })
  it('reports a second payment for an already-paid order', () => {
    expect(matchPayment(pay('15', 'GT-7F3K'), [{ ...order, status: 'paid' }]).kind).toBe('already_paid')
  })
  it('reports payments for cancelled orders', () => {
    expect(matchPayment(pay('15', 'GT-7F3K'), [{ ...order, status: 'cancelled' }]).kind).toBe('cancelled_order')
  })
  it('accepts but flags late payments', () => {
    expect(matchPayment(pay('15', 'GT-7F3K', 3_000), [order])).toMatchObject({ kind: 'paid', late: true })
  })
})

describe('ton parsing', () => {
  it('parses text comments and ignores other bodies', () => {
    expect(parseComment(beginCell().storeUint(0, 32).storeStringTail('GT-7F3K').endCell())).toBe('GT-7F3K')
    expect(parseComment(beginCell().storeUint(0x0f8a7ea5, 32).endCell())).toBeNull()
    expect(parseComment(beginCell().endCell())).toBeNull()
    expect(parseComment(null)).toBeNull()
  })
  it('extracts incoming payments only', () => {
    expect(extractPayment(fakeTx({ amount: toNano('2'), comment: 'GT-AAAA' }), 'testnet')).toMatchObject({
      amountNano: toNano('2'),
      comment: 'GT-AAAA',
    })
    expect(extractPayment(fakeTx({ amount: toNano('2'), out: 1 }), 'testnet')).toBeNull() // bounced
    expect(extractPayment(fakeTx({ amount: 0n, external: true }), 'testnet')).toBeNull() // seller's own outgoing
  })
  it('builds payment links with amount, comment and expiry', () => {
    const link = tonTransferLink(SELLER, toNano('15'), 'GT-7F3K', 1_900_000_000)
    expect(link).toBe(`ton://transfer/${SELLER}?amount=15000000000&text=GT-7F3K&exp=1900000000`)
  })
})

async function setup() {
  const store = await makeStore()
  const seller = await store.createSeller('Corner Coffee', SELLER, Address.parse(SELLER).toRawString(), 1)
  const events = async () => (await store.eventsSince(seller.id, 0)).map(e => e.payload)
  return { store, events, seller }
}

describe('processIncoming', () => {
  it('marks the order paid, records the payment once, and emits one event', async () => {
    const { store, events, seller } = await setup()
    const order = await store.createOrder({ sellerId: seller.id, label: 'Maria', amountNano: toNano('15') })
    const p = { txHash: 'abc', from: 'x', amountNano: toNano('15'), comment: order.code, utime: Math.floor(Date.now() / 1000) }
    expect((await processIncoming(store, seller.id, p))?.result).toBe('paid')
    expect(await processIncoming(store, seller.id, p)).toBeNull() // same tx again
    expect((await store.getOrder(order.id))!.status).toBe('paid')
    expect((await events()).filter(e => e.type === 'payment')).toHaveLength(1)
    const totals = await store.todayTotals(seller.id, 0)
    expect(totals).toMatchObject({ totalNano: toNano('15'), paidCount: 1, waiting: 0 })
    await store.close()
  })
})

describe('Watcher', () => {
  it('ignores history on first sight, then processes only new transfers in order', async () => {
    const { store, events, seller } = await setup()
    const order = await store.createOrder({ sellerId: seller.id, label: 'Table 4', amountNano: toNano('12') })
    const chain: TxLike[] = [fakeTx({ amount: toNano('99'), comment: 'old' })] // newest-first list
    const fetchTxs: FetchTxs = async (_a, { limit, lt }) => {
      const start = lt ? chain.findIndex(t => t.lt.toString() === lt) : 0
      return chain.slice(start, start + limit)
    }
    const notified: string[] = []
    const w = new Watcher(store, fetchTxs, 'testnet', { pageSize: 2, onPayment: (_id, p) => void notified.push(p.result) })

    await w.tick() // first sight: sets cursor only
    expect(await events()).toHaveLength(0)

    chain.unshift(fakeTx({ amount: toNano('1'), comment: 'tip' }))
    chain.unshift(fakeTx({ amount: toNano('2'), out: 1 })) // bounced: skipped
    chain.unshift(fakeTx({ amount: toNano('12'), comment: order.code }))
    await w.tick()
    const kinds = (await events()).map(e => (e.type === 'payment' ? e.result : e.type))
    expect(kinds).toEqual(['unmatched', 'paid']) // oldest first, across 2 pages
    expect(notified).toEqual(['unmatched', 'paid']) // receipts/alerts hook
    expect((await store.getOrder(order.id))!.status).toBe('paid')

    await w.tick() // nothing new
    expect(await events()).toHaveLength(2)
    await store.close()
  })
})

describe('Watcher first sight', () => {
  it('catches up a payment for a waiting order made before the first successful poll, ignoring other history', async () => {
    const { store, events, seller } = await setup()
    const order = await store.createOrder({ sellerId: seller.id, label: 'Abiola', amountNano: toNano('1') })
    const now = Math.floor(Date.now() / 1000)
    const chain: TxLike[] = [
      fakeTx({ amount: toNano('1'), comment: order.code, now }), // paid while the API was down
      fakeTx({ amount: toNano('2'), comment: 'faucet', now: now - 5 }), // unrelated: not replayed
      fakeTx({ amount: toNano('9'), comment: order.code, now: now - 86_400 }), // older than the order
    ]
    const w = new Watcher(store, async (_a, { limit }) => chain.slice(0, limit), 'testnet')
    await w.tick()
    expect((await events()).filter(e => e.type === 'payment').map(e => (e as any).result)).toEqual(['paid'])
    expect((await store.getOrder(order.id))!.status).toBe('paid')
    await w.tick() // cursor now set: nothing replays
    expect((await events()).filter(e => e.type === 'payment')).toHaveLength(1)
    await store.close()
  })

  it('falls back to archive nodes only when the regular query fails', async () => {
    const calls: any[] = []
    const { toncenterFetcher } = await import('../src/watcher.js')
    const f = toncenterFetcher({
      getTransactions: async (_a, o) => {
        calls.push(o.archival ?? false)
        if (!o.archival) throw new Error('boom')
        return []
      },
    })
    await f('EQD2NmD_lH5f5u1Kj3KfGyTvhZSX0Eg6qp2a5IQUKXxOG21n', { limit: 1 })
    expect(calls).toEqual([false, true])
  })
})

describe('Watcher database usage', () => {
  it('idle polling does not hit the database every tick', async () => {
    const { store, seller } = await setup()
    const counts = { listSellers: 0, getCursor: 0 }
    const wrapped = new Proxy(store, {
      get(t: any, k: string) {
        if (k in counts) return (...a: any[]) => ((counts as any)[k]++, t[k](...a))
        const v = t[k]
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
    const chain: TxLike[] = [fakeTx({ amount: toNano('1'), comment: 'x' })]
    const w = new Watcher(wrapped, async () => chain.slice(0, 1), 'testnet', { sellerRefreshMs: 60_000 })
    for (let i = 0; i < 10; i++) await w.tick()
    expect(counts.listSellers).toBe(1)
    expect(counts.getCursor).toBe(1)
    expect(seller.id).toBeGreaterThan(0)
    await store.close()
  })
})
