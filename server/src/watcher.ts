import { Address } from '@ton/core'
import type { TillStore } from './store/index.js'
import { processIncoming, type PaymentListener } from './processor.js'
import { extractPayment, type Network, type TxLike } from './ton.js'

/** Fetch transactions newest-first; optionally starting below (lt, hash). Injected so tests need no network. */
export type FetchTxs = (address: string, opts: { limit: number; lt?: string; hash?: string }) => Promise<TxLike[]>

export function toncenterFetcher(client: { getTransactions: (a: Address, o: any) => Promise<any[]> }): FetchTxs {
  return (address, opts) => client.getTransactions(Address.parse(address), { limit: opts.limit, lt: opts.lt, hash: opts.hash, archival: true })
}

const txId = (tx: TxLike) => ({ lt: tx.lt.toString(), hash: tx.hash().toString('base64') })

/**
 * Polls each seller's wallet for new incoming transfers (read-only).
 * First sight of a wallet sets the cursor to its newest transaction WITHOUT
 * processing history, so old transfers never show up as fresh "Paid" events.
 */
export class Watcher {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private failures = 0
  // Keep database traffic low while idle (free-tier databases bill per request / awake hour):
  // the seller list is refreshed once a minute and cursors live in memory after the first read.
  private sellers: { id: number; address: string }[] = []
  private sellersAt = 0
  private cursors = new Map<string, { lt: string; hash: string } | null>()

  constructor(
    private store: TillStore,
    private fetchTxs: FetchTxs,
    private network: Network,
    private opts: {
      intervalMs?: number
      pageSize?: number
      sellerRefreshMs?: number
      log?: (...a: unknown[]) => void
      onPayment?: PaymentListener
      onTick?: () => void
    } = {},
  ) {}

  start() {
    if (this.timer) return
    const loop = async () => {
      await this.tick()
      // Back off up to 60 s while the API is failing; normal cadence otherwise.
      const base = this.opts.intervalMs ?? 4000
      const delay = Math.min(base * 2 ** this.failures, 60_000)
      this.timer = setTimeout(loop, delay)
    }
    this.timer = setTimeout(loop, 0)
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      if (Date.now() - this.sellersAt >= (this.opts.sellerRefreshMs ?? 60_000)) {
        this.sellers = (await this.store.listSellers()).map(s => ({ id: s.id, address: s.address }))
        this.sellersAt = Date.now()
      }
      for (const seller of this.sellers) {
        if (!seller.address) continue
        await this.pollSeller(seller.id, seller.address)
      }
      this.failures = 0
      this.opts.onTick?.()
    } catch (err) {
      this.failures = Math.min(this.failures + 1, 4)
      this.opts.log?.('[watcher] poll failed:', (err as Error).message)
    } finally {
      this.busy = false
    }
  }

  async pollSeller(sellerId: number, address: string) {
    const limit = this.opts.pageSize ?? 20
    // Cursor cache is keyed by seller+address: changing the wallet (/wallet) starts fresh.
    const key = `${sellerId}|${address}`
    if (!this.cursors.has(key)) this.cursors.set(key, await this.store.getCursor(sellerId))
    const cursor = this.cursors.get(key) ?? null
    const save = async (lt: string, hash: string) => {
      this.cursors.set(key, { lt, hash })
      await this.store.setCursor(sellerId, lt, hash)
    }

    if (!cursor) {
      const latest = await this.fetchTxs(address, { limit: 1 })
      if (latest[0]) {
        const id = txId(latest[0])
        await save(id.lt, id.hash)
      } else {
        await save('0', '') // empty wallet: everything from now on is new
      }
      return
    }

    // Walk back from the newest transaction until we reach the cursor.
    const fresh: TxLike[] = []
    let page = await this.fetchTxs(address, { limit })
    outer: while (page.length) {
      for (const tx of page) {
        const id = txId(tx)
        if ((id.lt === cursor.lt && id.hash === cursor.hash) || BigInt(id.lt) <= BigInt(cursor.lt)) break outer
        fresh.push(tx)
      }
      if (page.length < limit) break
      const last = txId(page[page.length - 1])
      page = (await this.fetchTxs(address, { limit, lt: last.lt, hash: last.hash })).filter(t => txId(t).lt !== last.lt)
    }

    // Oldest first, advancing the cursor after each so a crash never replays or skips.
    for (const tx of fresh.reverse()) {
      const payment = extractPayment(tx, this.network)
      if (payment) {
        const done = await processIncoming(this.store, sellerId, payment)
        this.opts.log?.(`[watcher] seller ${sellerId}: ${done?.result ?? 'duplicate'} +${payment.amountNano} "${payment.comment ?? ''}"`)
        if (done) await Promise.resolve(this.opts.onPayment?.(sellerId, done)).catch(err => this.opts.log?.('[watcher] notify failed:', (err as Error).message))
      }
      const id = txId(tx)
      await save(id.lt, id.hash)
    }
  }
}
