import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy'
import QRCode from 'qrcode'
import type { Customer, Order, Seller, Store } from './db.js'
import { fromNano, toNano } from './money.js'
import type { TillBus } from './processor.js'
import { isError, type Notifier, type TillService } from './service.js'
import { friendlyAddress, isValidAddress, rawAddress, type Network } from './ton.js'
import { parseCommand } from './voice.js'

interface BotDeps {
  token: string
  store: Store
  bus: TillBus
  service: TillService
  network: Network
  publicUrl: string
  log: (...a: unknown[]) => void
}

type Step = { step: 'shop_name' } | { step: 'wallet'; name: string }

const HELP = `*Gram Till*: a hands-free till for your Telegram shop, on Even G2 glasses.

*Set up*
/wallet <address>: change the wallet you get paid into
/name <shop name>: rename your shop
/menu jollof 12: set a menu price (/menu to list, /menu remove jollof)
/link: your shop link and counter QR for customers

*Use*
/pair: 6-digit code to connect your glasses
/charge Tunde 15 for jollof: charge from Telegram
/waiting · /today · /customers

Gram Till never holds money or keys. It only watches your wallet and sends payment links.`

const isHttps = (u: string) => u.startsWith('https://')

export async function startBot(d: BotDeps): Promise<Notifier> {
  const bot = new Bot(d.token)
  const steps = new Map<number, Step>()
  const me = await bot.api.getMe()
  const shopLink = (s: Seller) => `https://t.me/${me.username}?start=shop_${s.id}`
  const explorer = (hash: string) =>
    hash.startsWith('dev-') ? null : `https://${d.network === 'testnet' ? 'testnet.' : ''}tonviewer.com/transaction/${hash}`
  const net = d.network === 'testnet' ? ' (testnet)' : ''

  const sellerOf = (ctx: Context) => (ctx.chat?.type === 'private' ? d.store.getSellerByChat(ctx.chat.id) : null)

  /** Pay button: Mini App inside Telegram when we have https, plain link otherwise. */
  function payKeyboard(order: Order): InlineKeyboard | undefined {
    const url = d.service.payUrl(order)
    if (!isHttps(url)) return undefined // Telegram rejects non-https buttons; link goes in the text instead
    return new InlineKeyboard().webApp(`Pay ${fromNano(order.amountNano)} GRAM`, url)
  }

  function requestText(seller: Seller, order: Order, reminder: boolean) {
    const url = d.service.payUrl(order)
    return [
      reminder ? `⏰ *Reminder from ${md(seller.name)}*` : `💳 *${md(seller.name)}* requests payment`,
      `*${fromNano(order.amountNano)} GRAM*${order.item ? ` · ${md(order.item)}` : ''}${net}`,
      `Order \`${order.code}\``,
      isHttps(url) ? '' : `Pay here: ${url}`,
    ]
      .filter(Boolean)
      .join('\n')
  }

  // ---------- onboarding ----------
  bot.command('start', async ctx => {
    if (ctx.chat.type !== 'private') return
    const payload = ctx.match?.trim() ?? ''
    if (payload.startsWith('shop_')) return customerJoin(ctx, Number(payload.slice(5)))
    const seller = sellerOf(ctx)
    if (seller) return ctx.reply(HELP, { parse_mode: 'Markdown' })
    steps.set(ctx.chat.id, { step: 'shop_name' })
    return ctx.reply("Welcome to Gram Till 👋\nLet's set up your shop. What's your shop called?")
  })

  bot.command('help', ctx => ctx.reply(HELP, { parse_mode: 'Markdown' }))

  bot.command('wallet', async ctx => {
    const seller = sellerOf(ctx)
    if (!seller) return ctx.reply('Send /start to set up your shop first.')
    const addr = ctx.match?.trim() ?? ''
    if (!addr) return ctx.reply(`Your till watches:\n\`${seller.address}\`${net}\n\nTo change it: /wallet <address>`, { parse_mode: 'Markdown' })
    if (!isValidAddress(addr)) return ctx.reply("That doesn't look like a TON address. Copy it from your Gram Wallet → Receive.")
    d.store.updateSellerAddress(seller.id, friendlyAddress(addr, d.network), rawAddress(addr))
    return ctx.reply(`✅ Now watching \`${friendlyAddress(addr, d.network)}\`${net}`, { parse_mode: 'Markdown' })
  })

  bot.command('name', async ctx => {
    const seller = sellerOf(ctx)
    if (!seller) return ctx.reply('Send /start to set up your shop first.')
    const name = ctx.match?.trim()
    if (!name) return ctx.reply('Usage: /name Mama T’s Kitchen')
    d.store.updateSellerName(seller.id, name.slice(0, 40))
    return ctx.reply(`✅ Shop name: ${name.slice(0, 40)}`)
  })

  bot.command('pair', async ctx => {
    const seller = sellerOf(ctx)
    if (!seller) return ctx.reply('Send /start to set up your shop first.')
    const code = d.store.createPairCode(seller.id)
    return ctx.reply(`🕶 Glasses pairing code: *${code}*\nEnter it in Gram Till on your phone (Even app). Valid for 10 minutes, works once.`, { parse_mode: 'Markdown' })
  })

  bot.command('menu', async ctx => {
    const seller = sellerOf(ctx)
    if (!seller) return ctx.reply('Send /start to set up your shop first.')
    const args = (ctx.match ?? '').trim()
    if (!args) {
      const menu = d.store.listMenu(seller.id)
      return ctx.reply(
        menu.length ? '📋 Menu\n' + menu.map(m => `• ${m.item}: ${fromNano(m.amountNano)} GRAM`).join('\n') + '\n\nSay "charge two jollof" on the glasses.' : 'No menu yet. Add one: /menu jollof 12',
      )
    }
    const rm = args.match(/^remove\s+(.+)$/i)
    if (rm) {
      d.store.removeMenuItem(seller.id, rm[1])
      return ctx.reply(`Removed ${rm[1]}`)
    }
    const m = args.match(/^(.+?)\s+(\d+(?:\.\d{1,9})?)$/)
    if (!m) return ctx.reply('Usage: /menu jollof 12')
    d.store.setMenuItem(seller.id, m[1], toNano(m[2]))
    return ctx.reply(`✅ ${m[1].toLowerCase()}: ${m[2]} GRAM`)
  })

  bot.command('link', async ctx => {
    const seller = sellerOf(ctx)
    if (!seller) return ctx.reply('Send /start to set up your shop first.')
    const link = shopLink(seller)
    const png = await QRCode.toBuffer(link, { width: 600, margin: 2 })
    return ctx.replyWithPhoto(new InputFile(png, 'counter-qr.png'), {
      caption: `🧾 Counter QR for ${seller.name}\nCustomers scan it (or open ${link}) once. After that, your payment requests reach them right here in Telegram.\nWalk-in? They scan it and see your latest waiting order.`,
    })
  })

  bot.command('customers', async ctx => {
    const seller = sellerOf(ctx)
    if (!seller) return
    const list = d.store.listCustomers(seller.id)
    return ctx.reply(list.length ? '👥 ' + list.map(c => `${c.name}${c.tgChatId ? '' : ' (not on Telegram)'}`).join(', ') : 'No customers yet. Share /link.')
  })

  bot.command('waiting', async ctx => {
    const seller = sellerOf(ctx)
    if (!seller) return
    const w = d.store.waitingOrders(seller.id)
    if (!w.length) return ctx.reply('Nothing waiting ✅')
    const kb = new InlineKeyboard()
    w.slice(0, 8).forEach(o => kb.text(`⏰ ${o.label}`, `remind:${o.id}`).text('✖', `cancel:${o.id}`).row())
    return ctx.reply('⏳ Waiting\n' + w.map(o => `• ${o.label}: ${fromNano(o.amountNano)} GRAM ${o.item ? `(${o.item}) ` : ''}\`${o.code}\``).join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: kb,
    })
  })

  bot.command('today', async ctx => {
    const seller = sellerOf(ctx)
    if (!seller) return
    const s = d.service.snapshot(seller)
    return ctx.reply(`📊 Today: *${s.today.total} GRAM*\n${s.today.paid} paid · ${s.today.waiting} waiting · ${s.today.unmatched} unmatched`, { parse_mode: 'Markdown' })
  })

  bot.command('charge', async ctx => {
    const seller = sellerOf(ctx)
    if (!seller) return ctx.reply('Send /start to set up your shop first.')
    const ctxV = { menu: d.store.listMenu(seller.id).map(m => m.item), customers: d.store.listCustomers(seller.id).map(c => c.name) }
    const cmd = parseCommand(`charge ${ctx.match ?? ''}`, ctxV)
    if (cmd.kind !== 'charge') return ctx.reply('Usage: /charge Tunde 15 for jollof')
    const p = d.service.previewCharge(seller, cmd)
    if (isError(p)) return ctx.reply(p.error)
    const r = await d.service.charge(seller, p)
    return ctx.reply(
      `✅ Request sent: ${r.order.label} · ${fromNano(r.order.amountNano)} GRAM \`${r.order.code}\`\n${r.delivered ? 'Delivered on Telegram.' : `Not on Telegram: let them scan your /link QR or open ${r.links.page}`}`,
      { parse_mode: 'Markdown' },
    )
  })

  bot.callbackQuery(/^(remind|cancel):(\d+)$/, async ctx => {
    const seller = sellerOf(ctx)
    if (!seller) return ctx.answerCallbackQuery()
    const [, action, id] = ctx.match
    if (action === 'remind') {
      const r = await d.service.remind(seller, [Number(id)])
      return ctx.answerCallbackQuery(r.reminded ? 'Reminder sent' : 'Customer not on Telegram')
    }
    const r = d.service.cancel(seller, Number(id))
    return ctx.answerCallbackQuery(isError(r) ? r.error : `Cancelled ${r.label}`)
  })

  // Free text: onboarding steps.
  bot.on('message:text', async ctx => {
    if (ctx.chat.type !== 'private') return
    const st = steps.get(ctx.chat.id)
    if (!st) return ctx.reply('Send /help to see what I can do.')
    const text = ctx.message.text.trim()
    if (st.step === 'shop_name') {
      steps.set(ctx.chat.id, { step: 'wallet', name: text.slice(0, 40) })
      return ctx.reply(
        `Great, *${md(text.slice(0, 40))}*.\nNow send the wallet address you want to get paid into${d.network === 'testnet' ? ' (a *testnet* wallet for this demo)' : ': Telegram → Wallet → Receive → copy'}.`,
        { parse_mode: 'Markdown' },
      )
    }
    if (!isValidAddress(text)) return ctx.reply("That doesn't look like a TON address. Try again.")
    steps.delete(ctx.chat.id)
    const seller = d.store.createSeller(st.name, friendlyAddress(text, d.network), rawAddress(text), ctx.chat.id)
    await ctx.reply(`✅ ${seller.name} is ready. Watching \`${seller.address}\`${net}.\n\nNext: /link for your counter QR, /menu to add prices, /pair to connect your glasses.`, {
      parse_mode: 'Markdown',
    })
  })

  // ---------- customers ----------
  async function customerJoin(ctx: Context, sellerId: number) {
    const seller = d.store.getSeller(sellerId)
    if (!seller || !ctx.chat || !ctx.from) return ctx.reply('Shop not found.')
    if (seller.tgChatId === ctx.chat.id) return ctx.reply("That's your own shop link. Share it with customers 🙂")
    const first = (ctx.from.first_name || 'Customer').trim()
    // Keep names unique per shop so "charge Tunde" is never ambiguous.
    let name = first
    const clash = d.store.findCustomer(seller.id, name)
    if (clash && clash.tgChatId !== ctx.chat.id) name = `${first} ${(ctx.from.last_name ?? ctx.from.username ?? String(ctx.from.id)).slice(0, 1).toUpperCase()}.`
    const customer = d.store.upsertCustomer(seller.id, name, ctx.chat.id)
    await ctx.reply(`👋 You're connected to *${md(seller.name)}* as *${md(customer.name)}*.\nPayment requests and receipts will arrive here.`, { parse_mode: 'Markdown' })
    // Walk-in: offer the latest waiting order that isn't assigned to a named customer.
    const walkIn = d.store.waitingOrders(seller.id).find(o => !o.customerId)
    if (walkIn) {
      await ctx.reply(`Is this yours?\n${requestText(seller, walkIn, false)}`, { parse_mode: 'Markdown', reply_markup: payKeyboard(walkIn) })
    }
  }

  // ---------- notifier used by the till service ----------
  const notifier: Notifier = {
    async requestPayment(seller, order, customer: Customer | null, reminder) {
      if (!customer?.tgChatId) return false
      await bot.api.sendMessage(customer.tgChatId, requestText(seller, order, reminder), { parse_mode: 'Markdown', reply_markup: payKeyboard(order) })
      return true
    },
  }

  // ---------- receipts & seller alerts (works even when the glasses app is closed) ----------
  d.bus.subscribe(async e => {
    if (e.type !== 'payment') return
    const seller = d.store.getSeller(e.sellerId)
    if (!seller) return
    const amount = fromNano(e.payment.amountNano)
    const tx = explorer(e.payment.txHash)
    try {
      if (e.result === 'paid' && e.order) {
        if (seller.tgChatId) await bot.api.sendMessage(seller.tgChatId, `✅ +${amount} GRAM · ${e.order.label}${e.order.item ? ` · ${e.order.item}` : ''} · ${e.order.code}${e.late ? ' (paid after expiry)' : ''}`)
        const customer = e.order.customerId ? d.store.getCustomer(e.order.customerId) : null
        if (customer?.tgChatId) {
          await bot.api.sendMessage(
            customer.tgChatId,
            `🧾 *Receipt*\n${md(seller.name)}\n${fromNano(e.order.amountNano)} GRAM${e.order.item ? ` · ${md(e.order.item)}` : ''}\nOrder \`${e.order.code}\` · Paid ✓${net}${tx ? `\n[View transaction](${tx})` : ''}`,
            { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
          )
        }
      } else if (seller.tgChatId) {
        const why =
          e.result === 'unmatched' ? 'no order code' : e.result === 'underpaid' ? `short for ${e.order?.code}` : e.result === 'already_paid' ? `extra payment for ${e.order?.code}` : `for cancelled ${e.order?.code}`
        await bot.api.sendMessage(seller.tgChatId, `⚠️ +${amount} GRAM received (${why})${e.payment.comment ? `\nComment: ${e.payment.comment}` : ''}`)
      }
    } catch (err) {
      d.log('[bot] notify failed:', (err as Error).message)
    }
  })

  await bot.api.setMyCommands([
    { command: 'start', description: 'Set up your shop' },
    { command: 'pair', description: 'Code to connect your glasses' },
    { command: 'link', description: 'Shop link + counter QR' },
    { command: 'menu', description: 'Menu prices' },
    { command: 'charge', description: 'Charge a customer' },
    { command: 'waiting', description: 'Waiting orders' },
    { command: 'today', description: "Today's total" },
    { command: 'wallet', description: 'Wallet you get paid into' },
    { command: 'help', description: 'Help' },
  ])
  bot.catch(err => d.log('[bot] error:', err.message))
  void bot.start({ onStart: () => d.log(`Telegram bot @${me.username} running`) })
  return notifier
}

/** Escape Markdown (legacy) special characters in user-provided text. */
function md(s: string) {
  return s.replace(/([_*`\[])/g, '\\$1')
}
