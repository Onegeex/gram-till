import type { Customer, Order, Seller, Store } from './db.js'
import { fromNano, toNano } from './money.js'
import type { TillBus } from './processor.js'
import { tonTransferLink, tonkeeperLink, type Network } from './ton.js'
import type { Command } from './voice.js'

/** Delivery of payment requests to customers (implemented by the Telegram bot). */
export interface Notifier {
  /** Send the customer a payment request. Returns true if it reached them on Telegram. */
  requestPayment(seller: Seller, order: Order, customer: Customer | null, reminder: boolean): Promise<boolean>
}

export const nullNotifier: Notifier = { requestPayment: async () => false }

export interface ChargePreview {
  label: string
  amountNano: bigint
  item: string | null
  qty: number
  customer: Customer | null
  /** true when the customer can receive the request in Telegram; otherwise the seller shows the counter QR. */
  reachable: boolean
}

export type ServiceError = { error: string }

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function tzOffsetSeconds(timeZone: string, at = new Date()): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find(p => p.type === 'timeZoneName')?.value // "GMT+01:00" or "GMT"
  const m = part?.match(/GMT([+-])(\d{2}):?(\d{2})?/)
  if (!m) return 0
  const s = (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60
  return m[1] === '-' ? -s : s
}

export function startOfLocalDay(timeZone: string, nowSec = Math.floor(Date.now() / 1000)): number {
  const off = tzOffsetSeconds(timeZone, new Date(nowSec * 1000))
  return Math.floor((nowSec + off) / 86400) * 86400 - off
}

export class TillService {
  constructor(
    private store: Store,
    private bus: TillBus,
    public notifier: Notifier,
    private cfg: { network: Network; publicUrl: string; timezone: string; orderTtlMinutes: number; maxChargeGram: number },
  ) {}

  // ---------- read ----------

  snapshot(seller: Seller) {
    const now = Math.floor(Date.now() / 1000)
    const totals = this.store.todayTotals(seller.id, startOfLocalDay(seller.timezone ?? this.cfg.timezone, now))
    const labelFor = (orderId: number | null) => (orderId ? this.store.getOrder(orderId)?.label ?? null : null)
    return {
      seller: { name: seller.name, address: seller.address, network: this.cfg.network },
      today: {
        total: fromNano(totals.totalNano),
        paid: totals.paidCount,
        unmatched: totals.unmatched,
        waiting: totals.waiting,
      },
      waiting: this.store.waitingOrders(seller.id).slice(0, 20).map(o => this.orderView(o, now)),
      recent: this.store.recentPayments(seller.id, 8).map(p => ({
        amount: fromNano(p.amountNano),
        result: p.result,
        label: labelFor(p.orderId),
        comment: p.comment,
        agoMin: Math.max(0, Math.round((now - p.utime) / 60)),
      })),
    }
  }

  orderView(o: Order, now = Math.floor(Date.now() / 1000)) {
    return {
      id: o.id,
      code: o.code,
      label: o.label,
      item: o.item,
      amount: fromNano(o.amountNano),
      status: o.status,
      agoMin: Math.max(0, Math.round((now - o.createdAt) / 60)),
      expired: o.status === 'waiting' && now > o.expiresAt,
    }
  }

  payUrl(order: Order) {
    return `${this.cfg.publicUrl}/pay/${order.code}`
  }

  payLinks(seller: Seller, order: Order) {
    return {
      page: this.payUrl(order),
      ton: tonTransferLink(seller.address, order.amountNano, order.code, order.expiresAt),
      tonkeeper: tonkeeperLink(seller.address, order.amountNano, order.code),
    }
  }

  // ---------- voice / glasses commands ----------

  /** Turn a parsed charge command into a concrete preview the seller confirms with one tap. */
  previewCharge(seller: Seller, cmd: Extract<Command, { kind: 'charge' }>): ChargePreview | ServiceError {
    let amountNano: bigint
    if (cmd.amount !== null) {
      try {
        amountNano = toNano(String(cmd.amount))
      } catch {
        return { error: 'Amount not understood' }
      }
    } else {
      const priced = this.store.listMenu(seller.id).find(m => m.item === (cmd.item ?? '').toLowerCase())
      if (!priced) return { error: `No price for "${cmd.item}". Add it in Telegram: /menu ${cmd.item ?? 'item'} 12` }
      amountNano = priced.amountNano * BigInt(cmd.qty)
    }
    if (amountNano <= 0n) return { error: 'Amount must be above zero' }
    if (amountNano > toNano(String(this.cfg.maxChargeGram))) return { error: `Over the ${this.cfg.maxChargeGram} GRAM limit` }
    const customer = cmd.label && !/^Table \d+$/.test(cmd.label) ? this.store.findCustomer(seller.id, cmd.label) : null
    const item = cmd.item ? (cmd.qty > 1 ? `${cmd.qty}× ${cmd.item}` : cmd.item) : null
    return {
      label: customer?.name ?? cmd.label ?? 'Walk-in',
      amountNano,
      item,
      qty: cmd.qty,
      customer,
      reachable: !!customer?.tgChatId,
    }
  }

  /** Repeat the last charge (same label, amount, item) as a new order preview. */
  previewRepeat(seller: Seller): ChargePreview | ServiceError {
    const last = this.store.lastOrder(seller.id)
    if (!last) return { error: 'Nothing to repeat yet' }
    const customer = last.customerId ? this.store.getCustomer(last.customerId) : null
    return { label: last.label, amountNano: last.amountNano, item: last.item, qty: 1, customer, reachable: !!customer?.tgChatId }
  }

  async charge(seller: Seller, p: ChargePreview) {
    const order = this.store.createOrder({
      sellerId: seller.id,
      label: p.label,
      amountNano: p.amountNano,
      item: p.item,
      customerId: p.customer?.id ?? null,
      ttlSec: this.cfg.orderTtlMinutes * 60,
    })
    this.bus.publish({ type: 'order', sellerId: seller.id, order, change: 'created' })
    const delivered = await this.notifier.requestPayment(seller, order, p.customer, false).catch(() => false)
    return { order, delivered, links: this.payLinks(seller, order) }
  }

  findWaiting(seller: Seller, target: string | 'last'): Order | null {
    const waiting = this.store.waitingOrders(seller.id)
    if (target === 'last') return waiting[0] ?? null
    const t = target.toLowerCase()
    return waiting.find(o => o.label.toLowerCase() === t || o.code.toLowerCase() === t) ?? null
  }

  cancel(seller: Seller, orderId: number): Order | ServiceError {
    const o = this.store.getOrder(orderId)
    if (!o || o.sellerId !== seller.id) return { error: 'Order not found' }
    if (o.status !== 'waiting') return { error: `Order is already ${o.status}` }
    this.store.setOrderStatus(o.id, 'cancelled')
    const updated = this.store.getOrder(o.id)!
    this.bus.publish({ type: 'order', sellerId: seller.id, order: updated, change: 'cancelled' })
    return updated
  }

  async remind(seller: Seller, orderIds: number[]): Promise<{ reminded: number; unreachable: number }> {
    let reminded = 0
    let unreachable = 0
    for (const id of orderIds) {
      const o = this.store.getOrder(id)
      if (!o || o.sellerId !== seller.id || o.status !== 'waiting') continue
      const customer = o.customerId ? this.store.getCustomer(o.customerId) : null
      const ok = await this.notifier.requestPayment(seller, o, customer, true).catch(() => false)
      if (ok) {
        reminded++
        this.bus.publish({ type: 'order', sellerId: seller.id, order: o, change: 'reminded' })
      } else unreachable++
    }
    return { reminded, unreachable }
  }

  /** Data for the customer-facing pay page. Never exposes other orders or customer data. */
  payInfo(code: string) {
    const order = this.store.getOrderByCode(code)
    if (!order) return null
    const seller = this.store.getSeller(order.sellerId)!
    const now = Math.floor(Date.now() / 1000)
    return {
      shop: seller.name,
      code: order.code,
      item: order.item,
      amount: fromNano(order.amountNano),
      amountNano: order.amountNano.toString(),
      status: order.status,
      expired: order.status === 'waiting' && now > order.expiresAt,
      address: seller.address,
      network: this.cfg.network,
      links: this.payLinks(seller, order),
    }
  }
}

export const isError = (x: unknown): x is ServiceError => typeof x === 'object' && x !== null && 'error' in x
