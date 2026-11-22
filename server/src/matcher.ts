import { extractOrderCode } from './money.js'

export type OrderStatus = 'waiting' | 'paid' | 'cancelled'

export interface MatchableOrder {
  id: number
  code: string
  amountNano: bigint
  status: OrderStatus
  expiresAt: number // unix seconds
}

export interface IncomingPayment {
  txHash: string
  from: string | null
  amountNano: bigint
  comment: string | null
  utime: number // unix seconds
}

export type MatchResult =
  | { kind: 'paid'; order: MatchableOrder; late: boolean; overpaidNano: bigint }
  | { kind: 'underpaid'; order: MatchableOrder; shortNano: bigint }
  | { kind: 'already_paid'; order: MatchableOrder } // second payment carrying the same code
  | { kind: 'cancelled_order'; order: MatchableOrder } // paid an order the seller cancelled
  | { kind: 'unmatched' } // no/unknown code: shown honestly as "Unmatched", never as paid

/**
 * Decide what an incoming transfer means for the seller.
 * A payment only counts as "paid" when its comment carries a known order code AND
 * the amount covers the order. Everything else is surfaced, never silently dropped.
 */
export function matchPayment(payment: IncomingPayment, orders: MatchableOrder[]): MatchResult {
  const code = extractOrderCode(payment.comment)
  if (!code) return { kind: 'unmatched' }
  const order = orders.find(o => o.code === code)
  if (!order) return { kind: 'unmatched' }
  if (order.status === 'paid') return { kind: 'already_paid', order }
  if (order.status === 'cancelled') return { kind: 'cancelled_order', order }
  if (payment.amountNano < order.amountNano) {
    return { kind: 'underpaid', order, shortNano: order.amountNano - payment.amountNano }
  }
  return {
    kind: 'paid',
    order,
    late: payment.utime > order.expiresAt,
    overpaidNano: payment.amountNano - order.amountNano,
  }
}
