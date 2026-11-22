import { Address } from '@ton/core'
import type { Store } from './db.js'
import type { TillBus } from './processor.js'
import { processIncoming } from './processor.js'
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

  constructor(
    private store: Store,
    private bus: TillBus,
    private fetchTxs: FetchTxs,
    private network: Network,
    private opts: { intervalMs?: number; pageSize?: number; log?: (...a: unknown[]) => void } = {},
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
      for (const seller of this.store.listSellers()) {
        if (!seller.address) continue
        await this.pollSeller(seller.id, seller.address)
      }
      this.failures = 0
    } catch (err) {
      this.failures = Math.min(this.failures + 1, 4)
      this.opts.log?.('[watcher] poll failed:', (err as Error).message)
    } finally {
      this.busy = false
    }
  }

  async pollSeller(sellerId: number, address: string) {
    const limit = this.opts.pageSize ?? 20
    const cursor = this.store.getCursor(sellerId)

    if (!cursor) {
      const latest = await this.fetchTxs(address, { limit: 1 })
      if (latest[0]) {
        const id = txId(latest[0])
        this.store.setCursor(sellerId, id.lt, id.hash)
      } else {
        this.store.setCursor(sellerId, '0', '') // empty wallet: everything from now on is new
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
        const kind = processIncoming(this.store, this.bus, sellerId, payment)
        this.opts.log?.(`[watcher] seller ${sellerId}: ${kind} +${payment.amountNano} "${payment.comment ?? ''}"`)
      }
      const id = txId(tx)
      this.store.setCursor(sellerId, id.lt, id.hash)
    }
  }
}
