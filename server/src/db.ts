import { DatabaseSync } from 'node:sqlite'
import { randomBytes, randomInt } from 'node:crypto'
import { newOrderCode } from './money.js'
import type { MatchableOrder, OrderStatus } from './matcher.js'

export interface Seller {
  id: number
  name: string
  address: string // user-friendly form, used in links and display
  addressRaw: string // 0:… form, used for comparisons
  tgChatId: number | null
}

export interface Order extends MatchableOrder {
  sellerId: number
  label: string // "Tunde", "Table 4", "Walk-in"
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

const now = () => Math.floor(Date.now() / 1000)

export class Store {
  readonly db: DatabaseSync

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sellers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        address_raw TEXT NOT NULL,
        tg_chat_id INTEGER UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        token TEXT PRIMARY KEY,
        seller_id INTEGER NOT NULL REFERENCES sellers(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pair_codes (
        code TEXT PRIMARY KEY,
        seller_id INTEGER NOT NULL REFERENCES sellers(id),
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY,
        seller_id INTEGER NOT NULL REFERENCES sellers(id),
        name TEXT NOT NULL COLLATE NOCASE,
        tg_chat_id INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (seller_id, name)
      );
      CREATE TABLE IF NOT EXISTS menu (
        seller_id INTEGER NOT NULL REFERENCES sellers(id),
        item TEXT NOT NULL COLLATE NOCASE,
        amount_nano TEXT NOT NULL,
        PRIMARY KEY (seller_id, item)
      );
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY,
        seller_id INTEGER NOT NULL REFERENCES sellers(id),
        code TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        item TEXT,
        customer_id INTEGER REFERENCES customers(id),
        amount_nano TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        paid_at INTEGER,
        tx_hash TEXT,
        payer TEXT,
        late INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS payments (
        tx_hash TEXT PRIMARY KEY,
        seller_id INTEGER NOT NULL REFERENCES sellers(id),
        amount_nano TEXT NOT NULL,
        comment TEXT,
        from_addr TEXT,
        utime INTEGER NOT NULL,
        result TEXT NOT NULL,
        order_id INTEGER REFERENCES orders(id)
      );
      CREATE TABLE IF NOT EXISTS cursors (
        seller_id INTEGER PRIMARY KEY REFERENCES sellers(id),
        lt TEXT NOT NULL,
        hash TEXT NOT NULL
      );
    `)
  }

  // ---------- sellers ----------

  createSeller(name: string, address: string, addressRaw: string, tgChatId: number | null): Seller {
    const r = this.db
      .prepare('INSERT INTO sellers (name, address, address_raw, tg_chat_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, address, addressRaw, tgChatId, now())
    return this.getSeller(Number(r.lastInsertRowid))!
  }

  updateSellerAddress(id: number, address: string, addressRaw: string) {
    this.db.prepare('UPDATE sellers SET address = ?, address_raw = ? WHERE id = ?').run(address, addressRaw, id)
    this.db.prepare('DELETE FROM cursors WHERE seller_id = ?').run(id) // new wallet: start fresh
  }

  updateSellerName(id: number, name: string) {
    this.db.prepare('UPDATE sellers SET name = ? WHERE id = ?').run(name, id)
  }

  getSeller(id: number): Seller | null {
    const r = this.db.prepare('SELECT * FROM sellers WHERE id = ?').get(id) as any
    return r ? toSeller(r) : null
  }

  getSellerByChat(chatId: number): Seller | null {
    const r = this.db.prepare('SELECT * FROM sellers WHERE tg_chat_id = ?').get(chatId) as any
    return r ? toSeller(r) : null
  }

  listSellers(): Seller[] {
    return (this.db.prepare('SELECT * FROM sellers').all() as any[]).map(toSeller)
  }

  // ---------- pairing (glasses app has no Google sign-in; use a 6-digit code from the bot) ----------

  createPairCode(sellerId: number, ttlSec = 600): string {
    this.db.prepare('DELETE FROM pair_codes WHERE seller_id = ? OR expires_at < ?').run(sellerId, now())
    let code: string
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    while (this.db.prepare('SELECT 1 FROM pair_codes WHERE code = ?').get(code))
    this.db.prepare('INSERT INTO pair_codes (code, seller_id, expires_at) VALUES (?, ?, ?)').run(code, sellerId, now() + ttlSec)
    return code
  }

  /** One-time: a code can be redeemed once, then it is gone. Returns a device token. */
  redeemPairCode(code: string): { token: string; seller: Seller } | null {
    const r = this.db.prepare('SELECT * FROM pair_codes WHERE code = ? AND expires_at >= ?').get(code.trim(), now()) as any
    if (!r) return null
    this.db.prepare('DELETE FROM pair_codes WHERE code = ?').run(r.code)
    const token = randomBytes(24).toString('base64url')
    this.db.prepare('INSERT INTO devices (token, seller_id, created_at) VALUES (?, ?, ?)').run(token, r.seller_id, now())
    return { token, seller: this.getSeller(r.seller_id)! }
  }

  sellerForToken(token: string | undefined | null): Seller | null {
    if (!token) return null
    const r = this.db.prepare('SELECT seller_id FROM devices WHERE token = ?').get(token) as any
    return r ? this.getSeller(r.seller_id) : null
  }

  revokeDevices(sellerId: number) {
    this.db.prepare('DELETE FROM devices WHERE seller_id = ?').run(sellerId)
  }

  // ---------- customers & menu ----------

  upsertCustomer(sellerId: number, name: string, tgChatId: number | null): Customer {
    const clean = name.trim().replace(/\s+/g, ' ')
    const existing = this.findCustomer(sellerId, clean)
    if (existing) {
      if (tgChatId && existing.tgChatId !== tgChatId) {
        this.db.prepare('UPDATE customers SET tg_chat_id = ? WHERE id = ?').run(tgChatId, existing.id)
        existing.tgChatId = tgChatId
      }
      return existing
    }
    const r = this.db
      .prepare('INSERT INTO customers (seller_id, name, tg_chat_id, created_at) VALUES (?, ?, ?, ?)')
      .run(sellerId, clean, tgChatId, now())
    return { id: Number(r.lastInsertRowid), sellerId, name: clean, tgChatId }
  }

  findCustomer(sellerId: number, name: string): Customer | null {
    const r = this.db.prepare('SELECT * FROM customers WHERE seller_id = ? AND name = ?').get(sellerId, name.trim()) as any
    return r ? toCustomer(r) : null
  }

  getCustomer(id: number): Customer | null {
    const r = this.db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as any
    return r ? toCustomer(r) : null
  }

  listCustomers(sellerId: number): Customer[] {
    return (this.db.prepare('SELECT * FROM customers WHERE seller_id = ? ORDER BY name').all(sellerId) as any[]).map(toCustomer)
  }

  setMenuItem(sellerId: number, item: string, amountNano: bigint) {
    this.db
      .prepare('INSERT INTO menu (seller_id, item, amount_nano) VALUES (?, ?, ?) ON CONFLICT(seller_id, item) DO UPDATE SET amount_nano = excluded.amount_nano')
      .run(sellerId, item.trim().toLowerCase(), amountNano.toString())
  }

  removeMenuItem(sellerId: number, item: string) {
    this.db.prepare('DELETE FROM menu WHERE seller_id = ? AND item = ?').run(sellerId, item.trim().toLowerCase())
  }

  listMenu(sellerId: number): { item: string; amountNano: bigint }[] {
    return (this.db.prepare('SELECT item, amount_nano FROM menu WHERE seller_id = ? ORDER BY item').all(sellerId) as any[]).map(r => ({
      item: r.item,
      amountNano: BigInt(r.amount_nano),
    }))
  }

  // ---------- orders ----------

  createOrder(input: {
    sellerId: number
    label: string
    amountNano: bigint
    item?: string | null
    customerId?: number | null
    ttlSec?: number
  }): Order {
    let code: string
    do code = newOrderCode()
    while (this.db.prepare('SELECT 1 FROM orders WHERE code = ?').get(code))
    const t = now()
    const r = this.db
      .prepare(
        'INSERT INTO orders (seller_id, code, label, item, customer_id, amount_nano, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(input.sellerId, code, input.label, input.item ?? null, input.customerId ?? null, input.amountNano.toString(), 'waiting', t, t + (input.ttlSec ?? 30 * 60))
    return this.getOrder(Number(r.lastInsertRowid))!
  }

  getOrder(id: number): Order | null {
    const r = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any
    return r ? toOrder(r) : null
  }

  getOrderByCode(code: string): Order | null {
    const r = this.db.prepare('SELECT * FROM orders WHERE code = ?').get(code.toUpperCase()) as any
    return r ? toOrder(r) : null
  }

  /** Orders that a payment could match (any status, so we can report duplicates/cancelled). */
  ordersForMatching(sellerId: number): Order[] {
    return (this.db.prepare('SELECT * FROM orders WHERE seller_id = ? ORDER BY id DESC LIMIT 500').all(sellerId) as any[]).map(toOrder)
  }

  waitingOrders(sellerId: number): Order[] {
    return (this.db.prepare("SELECT * FROM orders WHERE seller_id = ? AND status = 'waiting' ORDER BY id DESC").all(sellerId) as any[]).map(toOrder)
  }

  latestWaitingOrder(sellerId: number): Order | null {
    return this.waitingOrders(sellerId)[0] ?? null
  }

  lastOrder(sellerId: number): Order | null {
    const r = this.db.prepare('SELECT * FROM orders WHERE seller_id = ? ORDER BY id DESC LIMIT 1').get(sellerId) as any
    return r ? toOrder(r) : null
  }

  markPaid(orderId: number, txHash: string, payer: string | null, late: boolean, paidAt: number) {
    this.db
      .prepare("UPDATE orders SET status = 'paid', tx_hash = ?, payer = ?, late = ?, paid_at = ? WHERE id = ? AND status = 'waiting'")
      .run(txHash, payer, late ? 1 : 0, paidAt, orderId)
  }

  setOrderStatus(orderId: number, status: OrderStatus) {
    this.db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId)
  }

  // ---------- payments ----------

  hasPayment(txHash: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM payments WHERE tx_hash = ?').get(txHash)
  }

  recordPayment(p: PaymentRow) {
    this.db
      .prepare('INSERT OR IGNORE INTO payments (tx_hash, seller_id, amount_nano, comment, from_addr, utime, result, order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.txHash, p.sellerId, p.amountNano.toString(), p.comment, p.from, p.utime, p.result, p.orderId)
  }

  recentPayments(sellerId: number, limit = 10): PaymentRow[] {
    return (this.db.prepare('SELECT * FROM payments WHERE seller_id = ? ORDER BY utime DESC LIMIT ?').all(sellerId, limit) as any[]).map(toPayment)
  }

  /** Totals for "today" in the seller's local day, given the start of that day (unix seconds). */
  todayTotals(sellerId: number, dayStart: number) {
    const rows = this.db.prepare('SELECT amount_nano, result FROM payments WHERE seller_id = ? AND utime >= ?').all(sellerId, dayStart) as any[]
    let total = 0n
    let paidCount = 0
    let unmatched = 0
    for (const r of rows) {
      total += BigInt(r.amount_nano)
      if (r.result === 'paid') paidCount++
      else if (r.result === 'unmatched') unmatched++
    }
    const waiting = (this.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE seller_id = ? AND status = 'waiting'").get(sellerId) as any).n as number
    return { totalNano: total, paidCount, unmatched, waiting }
  }

  // ---------- watcher cursor ----------

  getCursor(sellerId: number): { lt: string; hash: string } | null {
    const r = this.db.prepare('SELECT lt, hash FROM cursors WHERE seller_id = ?').get(sellerId) as any
    return r ? { lt: r.lt, hash: r.hash } : null
  }

  setCursor(sellerId: number, lt: string, hash: string) {
    this.db
      .prepare('INSERT INTO cursors (seller_id, lt, hash) VALUES (?, ?, ?) ON CONFLICT(seller_id) DO UPDATE SET lt = excluded.lt, hash = excluded.hash')
      .run(sellerId, lt, hash)
  }
}

function toSeller(r: any): Seller {
  return { id: r.id, name: r.name, address: r.address, addressRaw: r.address_raw, tgChatId: r.tg_chat_id ?? null }
}

function toCustomer(r: any): Customer {
  return { id: r.id, sellerId: r.seller_id, name: r.name, tgChatId: r.tg_chat_id ?? null }
}

function toOrder(r: any): Order {
  return {
    id: r.id,
    sellerId: r.seller_id,
    code: r.code,
    label: r.label,
    item: r.item ?? null,
    customerId: r.customer_id ?? null,
    amountNano: BigInt(r.amount_nano),
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    paidAt: r.paid_at ?? null,
    txHash: r.tx_hash ?? null,
    payer: r.payer ?? null,
    late: !!r.late,
  }
}

function toPayment(r: any): PaymentRow {
  return {
    txHash: r.tx_hash,
    sellerId: r.seller_id,
    amountNano: BigInt(r.amount_nano),
    comment: r.comment ?? null,
    from: r.from_addr ?? null,
    utime: r.utime,
    result: r.result,
    orderId: r.order_id ?? null,
  }
}
