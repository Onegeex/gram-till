import postgres from 'postgres'
import { randomBytes, randomInt } from 'node:crypto'
import { newOrderCode } from '../money.js'
import type { OrderStatus } from '../matcher.js'
import { nowSec as now, type PendingAction, type BotStep, type Customer, type EventPayload, type Order, type PaymentRow, type Seller, type StoredEvent, type TillStore } from './types.js'

/**
 * Postgres store (production on Vercel with Neon). Shared by the API functions and the
 * watcher daemon. Amounts are TEXT (nanograms as decimal strings) to stay exact.
 */
export class PgStore implements TillStore {
  readonly kind = 'pg' as const
  readonly sql: postgres.Sql

  constructor(url: string) {
    this.sql = postgres(url, {
      max: Number(process.env.PG_POOL_MAX ?? 5),
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false, // works through transaction-mode poolers (Neon "-pooler" URLs)
      onnotice: () => {},
      types: { bigint: postgres.BigInt },
    })
  }

  async migrate() {
    const sql = this.sql
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS sellers (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        address_raw TEXT NOT NULL,
        tg_chat_id BIGINT UNIQUE,
        timezone TEXT,
        language TEXT NOT NULL DEFAULT 'en',
        created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        token TEXT PRIMARY KEY,
        seller_id BIGINT NOT NULL REFERENCES sellers(id),
        created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pair_codes (
        code TEXT PRIMARY KEY,
        seller_id BIGINT NOT NULL REFERENCES sellers(id),
        expires_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS customers (
        id BIGSERIAL PRIMARY KEY,
        seller_id BIGINT NOT NULL REFERENCES sellers(id),
        name TEXT NOT NULL,
        tg_chat_id BIGINT,
        created_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS customers_seller_name ON customers (seller_id, lower(name));
      CREATE TABLE IF NOT EXISTS menu (
        seller_id BIGINT NOT NULL REFERENCES sellers(id),
        item TEXT NOT NULL,
        amount_nano TEXT NOT NULL,
        PRIMARY KEY (seller_id, item)
      );
      CREATE TABLE IF NOT EXISTS orders (
        id BIGSERIAL PRIMARY KEY,
        seller_id BIGINT NOT NULL REFERENCES sellers(id),
        code TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        item TEXT,
        customer_id BIGINT REFERENCES customers(id),
        amount_nano TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        paid_at BIGINT,
        tx_hash TEXT,
        payer TEXT,
        late BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS orders_seller_status ON orders (seller_id, status, id DESC);
      CREATE TABLE IF NOT EXISTS payments (
        tx_hash TEXT PRIMARY KEY,
        seller_id BIGINT NOT NULL REFERENCES sellers(id),
        amount_nano TEXT NOT NULL,
        comment TEXT,
        from_addr TEXT,
        utime BIGINT NOT NULL,
        result TEXT NOT NULL,
        order_id BIGINT REFERENCES orders(id)
      );
      CREATE INDEX IF NOT EXISTS payments_seller_time ON payments (seller_id, utime DESC);
      CREATE TABLE IF NOT EXISTS cursors (
        seller_id BIGINT PRIMARY KEY REFERENCES sellers(id),
        lt TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id BIGSERIAL PRIMARY KEY,
        seller_id BIGINT NOT NULL,
        payload JSONB NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_seller ON events (seller_id, id);
      CREATE TABLE IF NOT EXISTS pending (
        id TEXT PRIMARY KEY,
        seller_id BIGINT NOT NULL,
        action JSONB NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_state (
        chat_id BIGINT PRIMARY KEY,
        step JSONB NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `)
  }

  async close() {
    await this.sql.end({ timeout: 5 })
  }

  // ---------- sellers ----------

  async createSeller(name: string, address: string, addressRaw: string, tgChatId: number | null): Promise<Seller> {
    const [r] = await this.sql`INSERT INTO sellers (name, address, address_raw, tg_chat_id, created_at)
      VALUES (${name}, ${address}, ${addressRaw}, ${tgChatId}, ${now()}) RETURNING *`
    return toSeller(r)
  }

  async updateSellerAddress(id: number, address: string, addressRaw: string) {
    await this.sql`UPDATE sellers SET address = ${address}, address_raw = ${addressRaw} WHERE id = ${id}`
    await this.sql`DELETE FROM cursors WHERE seller_id = ${id}` // new wallet: start fresh
  }

  async updateSellerName(id: number, name: string) {
    await this.sql`UPDATE sellers SET name = ${name} WHERE id = ${id}`
  }

  async updateSellerTimezone(id: number, timezone: string) {
    await this.sql`UPDATE sellers SET timezone = ${timezone} WHERE id = ${id}`
  }

  async updateSellerLanguage(id: number, language: string) {
    await this.sql`UPDATE sellers SET language = ${language} WHERE id = ${id}`
  }

  async getSeller(id: number): Promise<Seller | null> {
    const [r] = await this.sql`SELECT * FROM sellers WHERE id = ${id}`
    return r ? toSeller(r) : null
  }

  async getSellerByChat(chatId: number): Promise<Seller | null> {
    const [r] = await this.sql`SELECT * FROM sellers WHERE tg_chat_id = ${chatId}`
    return r ? toSeller(r) : null
  }

  async listSellers(): Promise<Seller[]> {
    return (await this.sql`SELECT * FROM sellers ORDER BY id`).map(toSeller)
  }

  // ---------- pairing ----------

  async createPairCode(sellerId: number, ttlSec = 600): Promise<string> {
    await this.sql`DELETE FROM pair_codes WHERE seller_id = ${sellerId} OR expires_at < ${now()}`
    for (;;) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
      const r = await this.sql`INSERT INTO pair_codes (code, seller_id, expires_at) VALUES (${code}, ${sellerId}, ${now() + ttlSec})
        ON CONFLICT (code) DO NOTHING RETURNING code`
      if (r.length) return code
    }
  }

  /** One-time: the DELETE … RETURNING makes redemption atomic even with concurrent requests. */
  async redeemPairCode(code: string): Promise<{ token: string; seller: Seller } | null> {
    const [r] = await this.sql`DELETE FROM pair_codes WHERE code = ${code.trim()} AND expires_at >= ${now()} RETURNING seller_id`
    if (!r) return null
    const token = randomBytes(24).toString('base64url')
    await this.sql`INSERT INTO devices (token, seller_id, created_at) VALUES (${token}, ${r.seller_id}, ${now()})`
    return { token, seller: (await this.getSeller(Number(r.seller_id)))! }
  }

  async sellerForToken(token: string | undefined | null): Promise<Seller | null> {
    if (!token) return null
    const [r] = await this.sql`SELECT s.* FROM devices d JOIN sellers s ON s.id = d.seller_id WHERE d.token = ${token}`
    return r ? toSeller(r) : null
  }

  // ---------- customers & menu ----------

  async upsertCustomer(sellerId: number, name: string, tgChatId: number | null): Promise<Customer> {
    const clean = name.trim().replace(/\s+/g, ' ')
    const existing = await this.findCustomer(sellerId, clean)
    if (existing) {
      if (tgChatId && existing.tgChatId !== tgChatId) {
        await this.sql`UPDATE customers SET tg_chat_id = ${tgChatId} WHERE id = ${existing.id}`
        existing.tgChatId = tgChatId
      }
      return existing
    }
    const [r] = await this.sql`INSERT INTO customers (seller_id, name, tg_chat_id, created_at) VALUES (${sellerId}, ${clean}, ${tgChatId}, ${now()})
      ON CONFLICT (seller_id, lower(name)) DO UPDATE SET name = customers.name RETURNING *`
    return toCustomer(r)
  }

  async findCustomer(sellerId: number, name: string): Promise<Customer | null> {
    const [r] = await this.sql`SELECT * FROM customers WHERE seller_id = ${sellerId} AND lower(name) = lower(${name.trim()})`
    return r ? toCustomer(r) : null
  }

  async getCustomer(id: number): Promise<Customer | null> {
    const [r] = await this.sql`SELECT * FROM customers WHERE id = ${id}`
    return r ? toCustomer(r) : null
  }

  async listCustomers(sellerId: number): Promise<Customer[]> {
    return (await this.sql`SELECT * FROM customers WHERE seller_id = ${sellerId} ORDER BY lower(name)`).map(toCustomer)
  }

  async setMenuItem(sellerId: number, item: string, amountNano: bigint) {
    await this.sql`INSERT INTO menu (seller_id, item, amount_nano) VALUES (${sellerId}, ${item.trim().toLowerCase()}, ${amountNano.toString()})
      ON CONFLICT (seller_id, item) DO UPDATE SET amount_nano = excluded.amount_nano`
  }

  async removeMenuItem(sellerId: number, item: string) {
    await this.sql`DELETE FROM menu WHERE seller_id = ${sellerId} AND item = ${item.trim().toLowerCase()}`
  }

  async listMenu(sellerId: number): Promise<{ item: string; amountNano: bigint }[]> {
    return (await this.sql`SELECT item, amount_nano FROM menu WHERE seller_id = ${sellerId} ORDER BY item`).map(r => ({
      item: r.item as string,
      amountNano: BigInt(r.amount_nano),
    }))
  }

  // ---------- orders ----------

  async createOrder(input: { sellerId: number; label: string; amountNano: bigint; item?: string | null; customerId?: number | null; ttlSec?: number }): Promise<Order> {
    const t = now()
    for (;;) {
      const code = newOrderCode()
      const [r] = await this.sql`INSERT INTO orders (seller_id, code, label, item, customer_id, amount_nano, status, created_at, expires_at)
        VALUES (${input.sellerId}, ${code}, ${input.label}, ${input.item ?? null}, ${input.customerId ?? null}, ${input.amountNano.toString()}, 'waiting', ${t}, ${t + (input.ttlSec ?? 30 * 60)})
        ON CONFLICT (code) DO NOTHING RETURNING *`
      if (r) return toOrder(r)
    }
  }

  async getOrder(id: number): Promise<Order | null> {
    const [r] = await this.sql`SELECT * FROM orders WHERE id = ${id}`
    return r ? toOrder(r) : null
  }

  async getOrderByCode(code: string): Promise<Order | null> {
    const [r] = await this.sql`SELECT * FROM orders WHERE code = ${code.toUpperCase()}`
    return r ? toOrder(r) : null
  }

  async ordersForMatching(sellerId: number): Promise<Order[]> {
    return (await this.sql`SELECT * FROM orders WHERE seller_id = ${sellerId} ORDER BY id DESC LIMIT 500`).map(toOrder)
  }

  async waitingOrders(sellerId: number): Promise<Order[]> {
    return (await this.sql`SELECT * FROM orders WHERE seller_id = ${sellerId} AND status = 'waiting' ORDER BY id DESC`).map(toOrder)
  }

  async lastOrder(sellerId: number): Promise<Order | null> {
    const [r] = await this.sql`SELECT * FROM orders WHERE seller_id = ${sellerId} ORDER BY id DESC LIMIT 1`
    return r ? toOrder(r) : null
  }

  async markPaid(orderId: number, txHash: string, payer: string | null, late: boolean, paidAt: number) {
    await this.sql`UPDATE orders SET status = 'paid', tx_hash = ${txHash}, payer = ${payer}, late = ${late}, paid_at = ${paidAt}
      WHERE id = ${orderId} AND status = 'waiting'`
  }

  async setOrderStatus(orderId: number, status: OrderStatus) {
    await this.sql`UPDATE orders SET status = ${status} WHERE id = ${orderId}`
  }

  // ---------- payments ----------

  async hasPayment(txHash: string): Promise<boolean> {
    return (await this.sql`SELECT 1 FROM payments WHERE tx_hash = ${txHash}`).length > 0
  }

  async recordPayment(p: PaymentRow): Promise<boolean> {
    const r = await this.sql`INSERT INTO payments (tx_hash, seller_id, amount_nano, comment, from_addr, utime, result, order_id)
      VALUES (${p.txHash}, ${p.sellerId}, ${p.amountNano.toString()}, ${p.comment}, ${p.from}, ${p.utime}, ${p.result}, ${p.orderId})
      ON CONFLICT (tx_hash) DO NOTHING RETURNING tx_hash`
    return r.length > 0
  }

  async recentPayments(sellerId: number, limit = 10): Promise<PaymentRow[]> {
    return (await this.sql`SELECT * FROM payments WHERE seller_id = ${sellerId} ORDER BY utime DESC LIMIT ${limit}`).map(toPayment)
  }

  async todayTotals(sellerId: number, dayStart: number) {
    const rows = await this.sql`SELECT amount_nano, result FROM payments WHERE seller_id = ${sellerId} AND utime >= ${dayStart}`
    let total = 0n
    let paidCount = 0
    let unmatched = 0
    for (const r of rows) {
      total += BigInt(r.amount_nano)
      if (r.result === 'paid') paidCount++
      else if (r.result === 'unmatched') unmatched++
    }
    const [w] = await this.sql`SELECT COUNT(*)::int AS n FROM orders WHERE seller_id = ${sellerId} AND status = 'waiting'`
    return { totalNano: total, paidCount, unmatched, waiting: Number(w.n) }
  }

  // ---------- watcher cursor ----------

  async getCursor(sellerId: number): Promise<{ lt: string; hash: string } | null> {
    const [r] = await this.sql`SELECT lt, hash FROM cursors WHERE seller_id = ${sellerId}`
    return r ? { lt: r.lt, hash: r.hash } : null
  }

  async setCursor(sellerId: number, lt: string, hash: string) {
    await this.sql`INSERT INTO cursors (seller_id, lt, hash) VALUES (${sellerId}, ${lt}, ${hash})
      ON CONFLICT (seller_id) DO UPDATE SET lt = excluded.lt, hash = excluded.hash`
  }

  // ---------- live events ----------

  async appendEvent(sellerId: number, payload: EventPayload): Promise<number> {
    const [r] = await this.sql`INSERT INTO events (seller_id, payload, created_at) VALUES (${sellerId}, ${this.sql.json(payload as any)}, ${now()}) RETURNING id`
    const id = Number(r.id)
    if (id % 500 === 0) await this.sql`DELETE FROM events WHERE created_at < ${now() - 86400}`
    return id
  }

  async eventsSince(sellerId: number, afterId: number, limit = 50): Promise<StoredEvent[]> {
    return (await this.sql`SELECT id, seller_id, payload FROM events WHERE seller_id = ${sellerId} AND id > ${afterId} ORDER BY id LIMIT ${limit}`).map(r => ({
      id: Number(r.id),
      sellerId: Number(r.seller_id),
      payload: r.payload as EventPayload,
    }))
  }

  async latestEventId(sellerId: number): Promise<number> {
    const [r] = await this.sql`SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE seller_id = ${sellerId}`
    return Number(r.id)
  }

  // ---------- one-shot confirmations ----------

  async putPending(id: string, sellerId: number, action: PendingAction, ttlSec: number) {
    await this.sql`DELETE FROM pending WHERE expires_at < ${now()}`
    await this.sql`INSERT INTO pending (id, seller_id, action, expires_at) VALUES (${id}, ${sellerId}, ${this.sql.json(action as any)}, ${now() + ttlSec})`
  }

  async takePending(id: string, sellerId: number): Promise<PendingAction | null> {
    const [r] = await this.sql`DELETE FROM pending WHERE id = ${id} RETURNING seller_id, action, expires_at`
    if (!r || Number(r.seller_id) !== sellerId || Number(r.expires_at) < now()) return null
    return r.action as PendingAction
  }

  async dropPending(id: string) {
    await this.sql`DELETE FROM pending WHERE id = ${id}`
  }

  // ---------- telegram conversation state ----------

  async getBotStep(chatId: number): Promise<BotStep | null> {
    const [r] = await this.sql`SELECT step FROM bot_state WHERE chat_id = ${chatId} AND updated_at > ${now() - 3600}`
    return r ? (r.step as BotStep) : null
  }

  async setBotStep(chatId: number, step: BotStep | null): Promise<void> {
    if (!step) await this.sql`DELETE FROM bot_state WHERE chat_id = ${chatId}`
    else
      await this.sql`INSERT INTO bot_state (chat_id, step, updated_at) VALUES (${chatId}, ${this.sql.json(step as any)}, ${now()})
        ON CONFLICT (chat_id) DO UPDATE SET step = excluded.step, updated_at = excluded.updated_at`
  }
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

function toSeller(r: any): Seller {
  return {
    id: Number(r.id),
    name: r.name,
    address: r.address,
    addressRaw: r.address_raw,
    tgChatId: num(r.tg_chat_id),
    timezone: r.timezone ?? null,
    language: r.language ?? 'en',
  }
}

function toCustomer(r: any): Customer {
  return { id: Number(r.id), sellerId: Number(r.seller_id), name: r.name, tgChatId: num(r.tg_chat_id) }
}

function toOrder(r: any): Order {
  return {
    id: Number(r.id),
    sellerId: Number(r.seller_id),
    code: r.code,
    label: r.label,
    item: r.item ?? null,
    customerId: num(r.customer_id),
    amountNano: BigInt(r.amount_nano),
    status: r.status,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    paidAt: num(r.paid_at),
    txHash: r.tx_hash ?? null,
    payer: r.payer ?? null,
    late: !!r.late,
  }
}

function toPayment(r: any): PaymentRow {
  return {
    txHash: r.tx_hash,
    sellerId: Number(r.seller_id),
    amountNano: BigInt(r.amount_nano),
    comment: r.comment ?? null,
    from: r.from_addr ?? null,
    utime: Number(r.utime),
    result: r.result,
    orderId: num(r.order_id),
  }
}
