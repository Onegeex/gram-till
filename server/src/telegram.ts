// Outgoing Telegram messages (payment requests, receipts, seller alerts).
// Uses only the Bot API over HTTPS, so both the API functions and the watcher daemon can send.

import { Api, InlineKeyboard } from 'grammy'
import { fromNano } from './money.js'
import type { ProcessedPayment } from './processor.js'
import type { Notifier, TillService } from './service.js'
import type { Customer, Order, Seller, TillStore } from './store/index.js'
import type { Network } from './ton.js'

/** Escape Markdown (legacy) special characters in user-provided text. */
export const md = (s: string) => s.replace(/([_*`\[])/g, '\\$1')
const isHttps = (u: string) => u.startsWith('https://')

export function explorerLink(network: Network, hash: string): string | null {
  return hash.startsWith('dev-') ? null : `https://${network === 'testnet' ? 'testnet.' : ''}tonviewer.com/transaction/${hash}`
}

export class TelegramOut {
  readonly api: Api
  private net: string

  constructor(
    token: string,
    private store: TillStore,
    private service: TillService,
    private network: Network,
    private log: (...a: unknown[]) => void = console.log,
  ) {
    this.api = new Api(token)
    this.net = network === 'testnet' ? ' (testnet)' : ''
  }

  /** Pay button: opens the pay page as a Telegram Mini App (needs https). */
  payKeyboard(order: Order): InlineKeyboard | undefined {
    const url = this.service.payUrl(order)
    return isHttps(url) ? new InlineKeyboard().webApp(`Pay ${fromNano(order.amountNano)} GRAM`, url) : undefined
  }

  requestText(seller: Seller, order: Order, reminder: boolean) {
    const url = this.service.payUrl(order)
    return [
      reminder ? `⏰ *Reminder from ${md(seller.name)}*` : `💳 *${md(seller.name)}* requests payment`,
      `*${fromNano(order.amountNano)} GRAM*${order.item ? ` · ${md(order.item)}` : ''}${this.net}`,
      `Order \`${order.code}\``,
      isHttps(url) ? '' : `Pay here: ${url}`,
    ]
      .filter(Boolean)
      .join('\n')
  }

  notifier(): Notifier {
    return {
      requestPayment: async (seller: Seller, order: Order, customer: Customer | null, reminder: boolean) => {
        if (!customer?.tgChatId) return false
        await this.api.sendMessage(customer.tgChatId, this.requestText(seller, order, reminder), { parse_mode: 'Markdown', reply_markup: this.payKeyboard(order) })
        return true
      },
    }
  }

  /** Receipt to the customer + alert to the seller (works even when the glasses app is closed). */
  async onPayment(sellerId: number, e: ProcessedPayment) {
    const seller = await this.store.getSeller(sellerId)
    if (!seller) return
    const amount = fromNano(e.payment.amountNano)
    const tx = explorerLink(this.network, e.payment.txHash)
    try {
      if (e.result === 'paid' && e.order) {
        if (seller.tgChatId)
          await this.api.sendMessage(seller.tgChatId, `✅ +${amount} GRAM · ${e.order.label}${e.order.item ? ` · ${e.order.item}` : ''} · ${e.order.code}${e.late ? ' (paid after expiry)' : ''}`)
        const customer = e.order.customerId ? await this.store.getCustomer(e.order.customerId) : null
        if (customer?.tgChatId) {
          await this.api.sendMessage(
            customer.tgChatId,
            `🧾 *Receipt*\n${md(seller.name)}\n${fromNano(e.order.amountNano)} GRAM${e.order.item ? ` · ${md(e.order.item)}` : ''}\nOrder \`${e.order.code}\` · Paid ✓${this.net}${tx ? `\n[View transaction](${tx})` : ''}`,
            { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
          )
        }
      } else if (seller.tgChatId) {
        const why =
          e.result === 'unmatched'
            ? 'no order code'
            : e.result === 'underpaid'
              ? `short for ${e.order?.code}`
              : e.result === 'already_paid'
                ? `extra payment for ${e.order?.code}`
                : `for cancelled ${e.order?.code}`
        await this.api.sendMessage(seller.tgChatId, `⚠️ +${amount} GRAM received (${why})${e.payment.comment ? `\nComment: ${e.payment.comment}` : ''}`)
      }
    } catch (err) {
      this.log('[telegram] notify failed:', (err as Error).message)
    }
  }
}
