import { EventEmitter } from 'node:events'
import type { Order, Store } from './db.js'
import { matchPayment, type IncomingPayment, type MatchResult } from './matcher.js'

export type TillEvent =
  | { type: 'payment'; sellerId: number; payment: IncomingPayment; result: MatchResult['kind']; order: Order | null; late: boolean }
  | { type: 'order'; sellerId: number; order: Order; change: 'created' | 'cancelled' | 'reminded' }

/** In-process event bus: the watcher publishes, SSE streams and the Telegram bot subscribe. */
export class TillBus extends EventEmitter {
  publish(e: TillEvent) {
    this.emit('event', e)
  }
  subscribe(fn: (e: TillEvent) => void): () => void {
    this.on('event', fn)
    return () => this.off('event', fn)
  }
}

/**
 * Apply one incoming transfer for a seller. Idempotent: the same tx hash is
 * processed once, even if the watcher sees it twice.
 */
export function processIncoming(store: Store, bus: TillBus, sellerId: number, p: IncomingPayment): MatchResult['kind'] | 'duplicate_tx' {
  if (store.hasPayment(p.txHash)) return 'duplicate_tx'
  const result = matchPayment(p, store.ordersForMatching(sellerId))
  let order: Order | null = null
  let late = false
  if (result.kind === 'paid') {
    store.markPaid(result.order.id, p.txHash, p.from, result.late, p.utime)
    late = result.late
  }
  if (result.kind !== 'unmatched') order = store.getOrder(result.order.id)
  store.recordPayment({
    txHash: p.txHash,
    sellerId,
    amountNano: p.amountNano,
    comment: p.comment,
    from: p.from,
    utime: p.utime,
    result: result.kind,
    orderId: order?.id ?? null,
  })
  bus.publish({ type: 'payment', sellerId, payment: p, result: result.kind, order, late })
  return result.kind
}
