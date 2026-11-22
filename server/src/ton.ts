// Read-only TON access. Gram Till never signs or sends anything on-chain:
// it only reads the seller's own wallet history and builds payment links.
//
// Incoming-payment detection follows the official TON guidebook example
// (ton-org/docs-examples, guidebook/toncoin-processing/src/deposits/invoices.ts).

import { Address, Cell } from '@ton/core'
import { TonClient, type Transaction } from '@ton/ton'
import type { IncomingPayment } from './matcher.js'

export type Network = 'testnet' | 'mainnet'

export function toncenterEndpoint(network: Network): string {
  return network === 'testnet'
    ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
    : 'https://toncenter.com/api/v2/jsonRPC'
}

export function makeClient(network: Network, apiKey?: string): TonClient {
  return new TonClient({ endpoint: toncenterEndpoint(network), apiKey: apiKey || undefined })
}

/** Parse a text comment (op 0 + UTF-8 tail) from a message body. */
export function parseComment(body: Cell | null | undefined): string | null {
  if (!body) return null
  try {
    const s = body.beginParse()
    if (s.remainingBits < 32) return null
    if (s.loadUint(32) !== 0) return null
    return s.loadStringTail()
  } catch {
    return null
  }
}

/** Minimal shape we need from a Transaction (lets tests use plain fakes). */
export type TxLike = Pick<Transaction, 'inMessage' | 'outMessages' | 'lt' | 'now'> & { hash(): Buffer }

/**
 * Turn a transaction into an incoming payment, or null when it is not one:
 * external/outgoing messages are ignored, and a transaction that produced outgoing
 * messages is skipped because the coins may have bounced back.
 */
export function extractPayment(tx: TxLike, network: Network): IncomingPayment | null {
  const inMsg = tx.inMessage
  if (!inMsg || inMsg.info.type !== 'internal' || !inMsg.info.src) return null
  if (tx.outMessages.size > 0) return null
  const amount = inMsg.info.value.coins
  if (amount <= 0n) return null
  return {
    txHash: tx.hash().toString('hex'),
    from: inMsg.info.src.toString({ testOnly: network === 'testnet', bounceable: false }),
    amountNano: amount,
    comment: parseComment(inMsg.body),
    utime: tx.now,
  }
}

/** Normalise any address form to raw "0:abcd…" so two spellings compare equal. */
export function rawAddress(addr: string): string {
  return Address.parse(addr.trim()).toRawString()
}

/** User-friendly, non-bounceable form for display and payment links. */
export function friendlyAddress(addr: string, network: Network): string {
  return Address.parse(addr.trim()).toString({ testOnly: network === 'testnet', bounceable: false })
}

export function isValidAddress(addr: string): boolean {
  try {
    Address.parse(addr.trim())
    return true
  } catch {
    return false
  }
}

/**
 * Payment request link with amount, order code and expiry.
 * Format: ton://transfer/<ADDRESS>?amount=<NANO>&text=<TEXT>&exp=<UNIX>
 * (https://docs.ton.org/ecosystem/wallet-apps/deep-links)
 */
export function tonTransferLink(address: string, amountNano: bigint, text: string, exp?: number): string {
  const q = new URLSearchParams({ amount: amountNano.toString(), text })
  if (exp) q.set('exp', String(exp))
  return `ton://transfer/${address}?${q.toString()}`
}

/** https link that opens Tonkeeper's send screen (useful where ton:// isn't clickable). */
export function tonkeeperLink(address: string, amountNano: bigint, text: string): string {
  const q = new URLSearchParams({ amount: amountNano.toString(), text })
  return `https://app.tonkeeper.com/transfer/${address}?${q.toString()}`
}
