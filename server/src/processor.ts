import { matchPayment, type IncomingPayment, type MatchResult } from './matcher.js'
import { extractOrderCode, fromNano } from './money.js'
import type { Order, TillStore } from './store/index.js'

export interface ProcessedPayment {
  result: MatchResult['kind']
  order: Order | null
  late: boolean
  payment: IncomingPayment
  /** For an underpaid order: what the customer still owes. */
  shortNano: bigint | null
}

/** Called after a payment is applied (Telegram receipts / seller alerts). */
export type PaymentListener = (sellerId: number, p: ProcessedPayment) => Promise<void> | void

/**
 * Apply one incoming transfer for a seller. Idempotent by tx hash: the same transfer
 * is processed once, even if the watcher sees it twice or restarts.
 * Publishes a 'payment' event that every connected glasses app receives.
 */
export async function processIncoming(store: TillStore, sellerId: number, p: IncomingPayment): Promise<ProcessedPayment | null> {
  if (await store.hasPayment(p.txHash)) return null
  const orders = await store.ordersForMatching(sellerId)
  // Earlier part-payments count toward the order, so a customer can top up a short payment.
  const code = extractOrderCode(p.comment)
  const target = code ? orders.find(o => o.code === code) : undefined
  const prior = target ? await store.partialPaidNano(target.id) : 0n
  const result = matchPayment(p, orders, id => (target && id === target.id ? prior : 0n))
  let late = false
  if (result.kind === 'paid') {
    await store.markPaid(result.order.id, p.txHash, p.from, result.late, p.utime)
    late = result.late
  }
  const order = result.kind === 'unmatched' ? null : await store.getOrder(result.order.id)
  const inserted = await store.recordPayment({
    txHash: p.txHash,
    sellerId,
    amountNano: p.amountNano,
    comment: p.comment,
    from: p.from,
    utime: p.utime,
    result: result.kind,
    orderId: order?.id ?? null,
  })
  if (!inserted) return null // another process recorded it first
  await store.appendEvent(sellerId, {
    type: 'payment',
    result: result.kind,
    amount: fromNano(p.amountNano),
    label: order?.label ?? null,
    code: order?.code ?? null,
    item: order?.item ?? null,
    late,
    comment: p.comment,
  })
  return { result: result.kind, order, late, payment: p, shortNano: result.kind === 'underpaid' ? result.shortNano : null }
}
