import type { MatchableOrder, OrderStatus } from '../matcher.js'

export interface Seller {
  id: number
  name: string
  address: string // user-friendly form, used in links and display
  addressRaw: string // 0:… form, used for comparisons
  tgChatId: number | null
  timezone: string | null // IANA zone, e.g. "Europe/Berlin"; null = server default
  language: string // spoken-command language (ISO-639-1), default "en"
}

export interface Order extends MatchableOrder {
  sellerId: number
  label: string // "Maria", "Table 4", "Walk-in"
  item: string | null
  customerId: number | null
  createdAt: number
  paidAt: number | null
  txHash: string | null
  payer: string | null
  late: boolean
}

export interface Customer {
  id: number
  sellerId: number
  name: string
  tgChatId: number | null
}

export interface PaymentRow {
  txHash: string
  sellerId: number
  amountNano: bigint
  comment: string | null
  from: string | null
  utime: number
  result: string
  orderId: number | null
}

/** Live-update events, stored so the watcher (daemon) and the API (functions) can share them. */
export type EventPayload =
  | { type: 'payment'; result: string; amount: string; label: string | null; code: string | null; item: string | null; late: boolean; comment: string | null }
  | { type: 'order'; change: 'created' | 'cancelled' | 'reminded'; orderId: number }

export interface StoredEvent {
  id: number
  sellerId: number
  payload: EventPayload
}

/** A preview shown on the lens, waiting for the one-tap confirm. Stored so any instance can confirm it. */
export type PendingAction =
  | { kind: 'charge'; label: string; amountNano: string; item: string | null; qty: number; customerId: number | null; reachable: boolean }
  | { kind: 'cancel'; orderId: number }

/** Multi-step Telegram conversations (seller onboarding), persisted so stateless functions can continue them. */
export type BotStep = { step: 'shop_name' } | { step: 'wallet'; name: string }

/**
 * All persistence goes through this interface.
 * - SqliteStore: zero-config local development and tests.
 * - PgStore: production on Vercel (Neon Postgres), shared by the API functions and the watcher daemon.
 */
export interface TillStore {
  readonly kind: 'sqlite' | 'pg'
  migrate(): Promise<void>
  close(): Promise<void>

  // sellers
  createSeller(name: string, address: string, addressRaw: string, tgChatId: number | null): Promise<Seller>
  updateSellerAddress(id: number, address: string, addressRaw: string): Promise<void>
  updateSellerName(id: number, name: string): Promise<void>
  updateSellerTimezone(id: number, timezone: string): Promise<void>
  updateSellerLanguage(id: number, language: string): Promise<void>
  getSeller(id: number): Promise<Seller | null>
  getSellerByChat(chatId: number): Promise<Seller | null>
  listSellers(): Promise<Seller[]>

  // pairing
  createPairCode(sellerId: number, ttlSec?: number): Promise<string>
  redeemPairCode(code: string): Promise<{ token: string; seller: Seller } | null>
  sellerForToken(token: string | undefined | null): Promise<Seller | null>

  // customers & menu
  upsertCustomer(sellerId: number, name: string, tgChatId: number | null): Promise<Customer>
  findCustomer(sellerId: number, name: string): Promise<Customer | null>
  getCustomer(id: number): Promise<Customer | null>
  listCustomers(sellerId: number): Promise<Customer[]>
  setMenuItem(sellerId: number, item: string, amountNano: bigint): Promise<void>
  removeMenuItem(sellerId: number, item: string): Promise<void>
  listMenu(sellerId: number): Promise<{ item: string; amountNano: bigint }[]>

  // orders
  createOrder(input: { sellerId: number; label: string; amountNano: bigint; item?: string | null; customerId?: number | null; ttlSec?: number }): Promise<Order>
  getOrder(id: number): Promise<Order | null>
  getOrderByCode(code: string): Promise<Order | null>
  ordersForMatching(sellerId: number): Promise<Order[]>
  waitingOrders(sellerId: number): Promise<Order[]>
  lastOrder(sellerId: number): Promise<Order | null>
  markPaid(orderId: number, txHash: string, payer: string | null, late: boolean, paidAt: number): Promise<void>
  setOrderStatus(orderId: number, status: OrderStatus): Promise<void>

  // payments
  hasPayment(txHash: string): Promise<boolean>
  /** Returns false if this tx hash was already recorded (idempotency across processes). */
  recordPayment(p: PaymentRow): Promise<boolean>
  recentPayments(sellerId: number, limit?: number): Promise<PaymentRow[]>
  todayTotals(sellerId: number, dayStart: number): Promise<{ totalNano: bigint; paidCount: number; unmatched: number; waiting: number }>

  // watcher cursor
  getCursor(sellerId: number): Promise<{ lt: string; hash: string } | null>
  setCursor(sellerId: number, lt: string, hash: string): Promise<void>

  // live events
  appendEvent(sellerId: number, payload: EventPayload): Promise<number>
  eventsSince(sellerId: number, afterId: number, limit?: number): Promise<StoredEvent[]>
  latestEventId(sellerId: number): Promise<number>

  // one-shot confirmations (voice preview -> tap)
  putPending(id: string, sellerId: number, action: PendingAction, ttlSec: number): Promise<void>
  /** Atomically removes and returns it; null if missing, expired, or another seller's. */
  takePending(id: string, sellerId: number): Promise<PendingAction | null>
  dropPending(id: string): Promise<void>

  // telegram conversation state
  getBotStep(chatId: number): Promise<BotStep | null>
  setBotStep(chatId: number, step: BotStep | null): Promise<void>
}

export const nowSec = () => Math.floor(Date.now() / 1000)
