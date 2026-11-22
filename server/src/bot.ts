import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy'
import QRCode from 'qrcode'
import type { Seller, TillStore } from './store/index.js'
import { fromNano, toNano } from './money.js'
import { isError, isValidTimezone, type TillService } from './service.js'
import { md, type TelegramOut } from './telegram.js'
import { WHISPER_LANGUAGES } from './stt.js'
import { friendlyAddress, isValidAddress, rawAddress, type Network } from './ton.js'
import { parseCommand } from './voice.js'

interface BotDeps {
  token: string
  store: TillStore
  service: TillService
  out: TelegramOut
  network: Network
  publicUrl: string
  defaultTimezone: string
  log: (...a: unknown[]) => void
}

const HELP = `*Gram Till*: a hands-free till for your Telegram shop, on Even G2 glasses.

*Set up*
/wallet <address>: change the wallet you get paid into
/name <shop name>: rename your shop
/menu latte 4: set a menu price (/menu to list, /menu remove latte)
/timezone Europe/Berlin: your local time zone (for "today" totals)
/language es: the language you speak commands in (default en)
/link: your shop link and counter QR for customers

*Use*
/pair: 6-digit code to connect your glasses
/charge Maria 12 for 2 lattes: charge from Telegram
/waiting · /today · /customers

Gram Till never holds money or keys. It only watches your wallet and sends payment links.`

export const BOT_COMMANDS = [
  { command: 'start', description: 'Set up your shop' },
  { command: 'pair', description: 'Code to connect your glasses' },
  { command: 'link', description: 'Shop link + counter QR' },
  { command: 'menu', description: 'Menu prices' },
  { command: 'charge', description: 'Charge a customer' },
  { command: 'waiting', description: 'Waiting orders' },
  { command: 'today', description: "Today's total" },
  { command: 'wallet', description: 'Wallet you get paid into' },
  { command: 'timezone', description: 'Your local time zone' },
  { command: 'language', description: 'Language for voice commands' },
  { command: 'help', description: 'Help' },
]

/**
 * Telegram command handlers. Stateless between updates (conversation steps live in the
 * store), so the same bot runs with long polling locally or behind a webhook on Vercel.
 */
export function createBot(d: BotDeps): Bot {
  const bot = new Bot(d.token)
  const shopLink = (s: Seller) => `https://t.me/${bot.botInfo.username}?start=shop_${s.id}`
  const net = d.network === 'testnet' ? ' (testnet)' : ''

  const sellerOf = async (ctx: Context) => (ctx.chat?.type === 'private' ? d.store.getSellerByChat(ctx.chat.id) : null)

  // ---------- onboarding ----------
  bot.command('start', async ctx => {
    if (ctx.chat.type !== 'private') return
    const payload = ctx.match?.trim() ?? ''
    if (payload.startsWith('shop_')) return customerJoin(ctx, Number(payload.slice(5)))
    const seller = await sellerOf(ctx)
    if (seller) return ctx.reply(HELP, { parse_mode: 'Markdown' })
    await d.store.setBotStep(ctx.chat.id, { step: 'shop_name' })
    return ctx.reply("Welcome to Gram Till 👋\nLet's set up your shop. What's your shop called?")
  })

  bot.command('help', ctx => ctx.reply(HELP, { parse_mode: 'Markdown' }))

  bot.command('wallet', async ctx => {
    const seller = await sellerOf(ctx)
    if (!seller) return ctx.reply('Send /start to set up your shop first.')
    const addr = ctx.match?.trim() ?? ''
    if (!addr) return ctx.reply(`Your till watches:\n\`${seller.address}\`${net}\n\nTo change it: /wallet <address>`, { parse_mode: 'Markdown' })
    if (!isValidAddress(addr)) return ctx.reply("That doesn't look like a TON address. Copy it from your Gram Wallet → Receive.")
    await d.store.updateSellerAddress(seller.id, friendlyAddress(addr, d.network), rawAddress(addr))
    return ctx.reply(`✅ Now watching \`${friendlyAddress(addr, d.network)}\`${net}`, { parse_mode: 'Markdown' })
  })

  bot.command('name', async ctx => {
    const seller = await sellerOf(ctx)
    if (!seller) return ctx.reply('Send /start to set up your shop first.')
    const name = ctx.match?.trim()
    if (!name) return ctx.reply('Usage: /name Corner Coffee')
    await d.store.updateSellerName(seller.id, name.slice(0, 40))
    return ctx.reply(`✅ Shop name: ${name.slice(0, 40)}`)
  })

  bot.command('timezone', async ctx => {
    const seller = await sellerOf(ctx)
    if (!seller) return ctx.reply('Send /start to set up your shop first.')
    const tz = ctx.match?.trim() ?? ''
    if (!tz) return ctx.reply(`Your till's day runs on ${seller.timezone ?? d.defaultTimezone}.\nChange it: /timezone Europe/Berlin (any IANA zone, e.g. America/New_York, Asia/Dubai, Asia/Jakarta)`)
    if (!isValidTimezone(tz)) return ctx.reply('Unknown time zone. Examples: Europe/London, America/Sao_Paulo, Asia/Dubai, Asia/Tokyo')
    await d.store.updateSellerTimezone(seller.id, tz)
    return ctx.reply(`✅ "Today" now follows ${tz}`)
  })

  bot.command('language', async ctx => {
    const seller = await sellerOf(ctx)
    if (!seller) return ctx.reply('Send /start to set up your shop first.')
    const code = (ctx.match ?? '').trim().toLowerCase()
    if (!code)
      return ctx.reply(
        `Your glasses listen for commands in: ${seller.language}\nChange it with a language code, e.g. /language es (Spanish), /language pt, /language fr, /language de, /language tr, /language id, /language ar, /language ja.\nSay commands naturally, e.g. "cobra a María doce". Amounts are always in GRAM.`,
      )
    if (!WHISPER_LANGUAGES.has(code)) return ctx.reply('Unknown language code. Use a 2-letter code like es, pt, fr, de, it, tr, id, ar, hi, ja, zh, sw, yo.')
    await d.store.updateSellerLanguage(seller.id, code)
    return ctx.reply(`✅ Voice commands: ${code}${code === 'en' ? '' : ' (translated to English for the till; names and menu words are kept as you say them)'}`)
  })

  bot.command('pair', async ctx => {
    const seller = await sellerOf(ctx)
    if (!seller) return ctx.reply('Send /start to set up your shop first.')
    const code = await d.store.createPairCode(seller.id)
    return ctx.reply(`🕶 Glasses pairing code: *${code}*\nEnter it in Gram Till on your phone (Even app). Valid for 10 minutes, works once.`, { parse_mode: 'Markdown' })
  })

  bot.command('menu', async ctx => {
    const seller = await sellerOf(ctx)
    if (!seller) return ctx.reply('Send /start to set up your shop first.')
    const args = (ctx.match ?? '').trim()
    if (!args) {
      const menu = await d.store.listMenu(seller.id)
      return ctx.reply(
        menu.length ? '📋 Menu\n' + menu.map(m => `• ${m.item}: ${fromNano(m.amountNano)} GRAM`).join('\n') + '\n\nSay "charge two lattes" on the glasses.' : 'No menu yet. Add one: /menu latte 4',
      )
    }
    const rm = args.match(/^remove\s+(.+)$/i)
    if (rm) {
      await d.store.removeMenuItem(seller.id, rm[1])
      return ctx.reply(`Removed ${rm[1]}`)
    }
    const m = args.match(/^(.+?)\s+(\d+(?:\.\d{1,9})?)$/)
    if (!m) return ctx.reply('Usage: /menu latte 4')
    await d.store.setMenuItem(seller.id, m[1], toNano(m[2]))
    return ctx.reply(`✅ ${m[1].toLowerCase()}: ${m[2]} GRAM`)
  })

  bot.command('link', async ctx => {
    const seller = await sellerOf(ctx)
    if (!seller) return ctx.reply('Send /start to set up your shop first.')
    const link = shopLink(seller)
    const png = await QRCode.toBuffer(link, { width: 600, margin: 2 })
    return ctx.replyWithPhoto(new InputFile(png, 'counter-qr.png'), {
      caption: `🧾 Counter QR for ${seller.name}\nCustomers scan it (or open ${link}) once. After that, your payment requests reach them right here in Telegram.\nWalk-in? They scan it and see your latest waiting order.`,
    })
  })

  bot.command('customers', async ctx => {
    const seller = await sellerOf(ctx)
    if (!seller) return
    const list = await d.store.listCustomers(seller.id)
    return ctx.reply(list.length ? '👥 ' + list.map(c => `${c.name}${c.tgChatId ? '' : ' (not on Telegram)'}`).join(', ') : 'No customers yet. Share /link.')
  })

  bot.command('waiting', async ctx => {
    const seller = await sellerOf(ctx)
    if (!seller) return
    const w = await d.store.waitingOrders(seller.id)
    if (!w.length) return ctx.reply('Nothing waiting ✅')
    const kb = new InlineKeyboard()
    w.slice(0, 8).forEach(o => kb.text(`⏰ ${o.label}`, `remind:${o.id}`).text('✖', `cancel:${o.id}`).row())
    return ctx.reply('⏳ Waiting\n' + w.map(o => `• ${o.label}: ${fromNano(o.amountNano)} GRAM ${o.item ? `(${o.item}) ` : ''}\`${o.code}\``).join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: kb,
    })
  })

  bot.command('today', async ctx => {
    const seller = await sellerOf(ctx)
    if (!seller) return
    const s = await d.service.snapshot(seller)
    return ctx.reply(`📊 Today: *${s.today.total} GRAM*\n${s.today.paid} paid · ${s.today.waiting} waiting · ${s.today.unmatched} unmatched`, { parse_mode: 'Markdown' })
  })

  bot.command('charge', async ctx => {
    const seller = await sellerOf(ctx)
    if (!seller) return ctx.reply('Send /start to set up your shop first.')
    const ctxV = { menu: (await d.store.listMenu(seller.id)).map(m => m.item), customers: (await d.store.listCustomers(seller.id)).map(c => c.name) }
    const cmd = parseCommand(`charge ${ctx.match ?? ''}`, ctxV)
    if (cmd.kind !== 'charge') return ctx.reply('Usage: /charge Maria 12 for 2 lattes')
    const p = await d.service.previewCharge(seller, cmd)
    if (isError(p)) return ctx.reply(p.error)
    const r = await d.service.charge(seller, p)
    return ctx.reply(
      `✅ Request sent: ${r.order.label} · ${fromNano(r.order.amountNano)} GRAM \`${r.order.code}\`\n${r.delivered ? 'Delivered on Telegram.' : `Not on Telegram: let them scan your /link QR or open ${r.links.page}`}`,
      { parse_mode: 'Markdown' },
    )
  })

  bot.callbackQuery(/^(remind|cancel):(\d+)$/, async ctx => {
    const seller = await sellerOf(ctx)
    if (!seller) return ctx.answerCallbackQuery()
    const [, action, id] = ctx.match
    if (action === 'remind') {
      const r = await d.service.remind(seller, [Number(id)])
      return ctx.answerCallbackQuery(r.reminded ? 'Reminder sent' : 'Customer not on Telegram')
    }
    const r = await d.service.cancel(seller, Number(id))
    return ctx.answerCallbackQuery(isError(r) ? r.error : `Cancelled ${r.label}`)
  })

  // Free text: onboarding steps.
  bot.on('message:text', async ctx => {
    if (ctx.chat.type !== 'private') return
    const st = await d.store.getBotStep(ctx.chat.id)
    if (!st) return ctx.reply('Send /help to see what I can do.')
    const text = ctx.message.text.trim()
    if (st.step === 'shop_name') {
      await d.store.setBotStep(ctx.chat.id, { step: 'wallet', name: text.slice(0, 40) })
      return ctx.reply(
        `Great, *${md(text.slice(0, 40))}*.\nNow send the wallet address you want to get paid into${d.network === 'testnet' ? ' (a *testnet* wallet for this demo)' : ': Telegram → Wallet → Receive → copy'}.`,
        { parse_mode: 'Markdown' },
      )
    }
    if (!isValidAddress(text)) return ctx.reply("That doesn't look like a TON address. Try again.")
    await d.store.setBotStep(ctx.chat.id, null)
    const seller = await d.store.createSeller(st.name, friendlyAddress(text, d.network), rawAddress(text), ctx.chat.id)
    await ctx.reply(`✅ ${seller.name} is ready. Watching \`${seller.address}\`${net}.\n\nNext: /timezone for your local day, /language if you won't speak English to the glasses, /link for your counter QR, /menu to add prices, /pair to connect your glasses.`, {
      parse_mode: 'Markdown',
    })
  })

  // ---------- customers ----------
  async function customerJoin(ctx: Context, sellerId: number) {
    const seller = await d.store.getSeller(sellerId)
    if (!seller || !ctx.chat || !ctx.from) return ctx.reply('Shop not found.')
    if (seller.tgChatId === ctx.chat.id) return ctx.reply("That's your own shop link. Share it with customers 🙂")
    const first = (ctx.from.first_name || 'Customer').trim()
    // Keep names unique per shop so "charge Maria" is never ambiguous.
    let name = first
    const clash = await d.store.findCustomer(seller.id, name)
    if (clash && clash.tgChatId !== ctx.chat.id) name = `${first} ${(ctx.from.last_name ?? ctx.from.username ?? String(ctx.from.id)).slice(0, 1).toUpperCase()}.`
    const customer = await d.store.upsertCustomer(seller.id, name, ctx.chat.id)
    await ctx.reply(`👋 You're connected to *${md(seller.name)}* as *${md(customer.name)}*.\nPayment requests and receipts will arrive here.`, { parse_mode: 'Markdown' })
    // Walk-in: offer the latest waiting order that isn't assigned to a named customer.
    const walkIn = (await d.store.waitingOrders(seller.id)).find(o => !o.customerId)
    if (walkIn) {
      await ctx.reply(`Is this yours?\n${d.out.requestText(seller, walkIn, false)}`, { parse_mode: 'Markdown', reply_markup: d.out.payKeyboard(walkIn) })
    }
  }

  bot.catch(err => d.log('[bot] error:', err.message))
  return bot
}
