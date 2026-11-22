import { matchPayment, type IncomingPayment, type MatchResult } from './matcher.js'
import { fromNano } from './money.js'
import type { Order, TillStore } from './store/index.js'

export interface ProcessedPayment {
  result: MatchResult['kind']
  order: Order | null
  late: boolean
  payment: IncomingPayment
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
  const result = matchPayment(p, await store.ordersForMatching(sellerId))
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
  return { result: result.kind, order, late, payment: p }
}
