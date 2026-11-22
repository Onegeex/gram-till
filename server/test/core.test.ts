import { describe, expect, it } from 'vitest'
import { Address, beginCell } from '@ton/core'
import { extractOrderCode, fromNano, newOrderCode, toNano } from '../src/money.js'
import { matchPayment, type MatchableOrder } from '../src/matcher.js'
import { extractPayment, parseComment, tonTransferLink, type TxLike } from '../src/ton.js'
import { Store } from '../src/db.js'
import { TillBus, processIncoming, type TillEvent } from '../src/processor.js'
import { Watcher, type FetchTxs } from '../src/watcher.js'

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

function setup() {
  const store = new Store()
  const bus = new TillBus()
  const events: TillEvent[] = []
  bus.subscribe(e => events.push(e))
  const seller = store.createSeller('Mama T', SELLER, Address.parse(SELLER).toRawString(), 1)
  return { store, bus, events, seller }
}

describe('processIncoming', () => {
  it('marks the order paid, records the payment once, and emits one event', () => {
    const { store, bus, events, seller } = setup()
    const order = store.createOrder({ sellerId: seller.id, label: 'Tunde', amountNano: toNano('15') })
    const p = { txHash: 'abc', from: 'x', amountNano: toNano('15'), comment: order.code, utime: Math.floor(Date.now() / 1000) }
    expect(processIncoming(store, bus, seller.id, p)).toBe('paid')
    expect(processIncoming(store, bus, seller.id, p)).toBe('duplicate_tx')
    expect(store.getOrder(order.id)!.status).toBe('paid')
    expect(events.filter(e => e.type === 'payment')).toHaveLength(1)
    const totals = store.todayTotals(seller.id, 0)
    expect(totals).toMatchObject({ totalNano: toNano('15'), paidCount: 1, waiting: 0 })
  })
})

describe('Watcher', () => {
  it('ignores history on first sight, then processes only new transfers in order', async () => {
    const { store, bus, events, seller } = setup()
    const order = store.createOrder({ sellerId: seller.id, label: 'Table 4', amountNano: toNano('12') })
    const chain: TxLike[] = [fakeTx({ amount: toNano('99'), comment: 'old' })] // newest-first list
    const fetchTxs: FetchTxs = async (_a, { limit, lt }) => {
      const start = lt ? chain.findIndex(t => t.lt.toString() === lt) : 0
      return chain.slice(start, start + limit)
    }
    const w = new Watcher(store, bus, fetchTxs, 'testnet', { pageSize: 2 })

    await w.tick() // first sight: sets cursor only
    expect(events).toHaveLength(0)

    chain.unshift(fakeTx({ amount: toNano('1'), comment: 'tip' }))
    chain.unshift(fakeTx({ amount: toNano('2'), out: 1 })) // bounced: skipped
    chain.unshift(fakeTx({ amount: toNano('12'), comment: order.code }))
    await w.tick()
    const kinds = events.map(e => (e.type === 'payment' ? e.result : e.type))
    expect(kinds).toEqual(['unmatched', 'paid']) // oldest first, across 2 pages
    expect(store.getOrder(order.id)!.status).toBe('paid')

    await w.tick() // nothing new
    expect(events).toHaveLength(2)
  })
})
