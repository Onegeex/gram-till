import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { webhookCallback, type Bot } from 'grammy'
import { BOT_COMMANDS } from './bot.js'
import { fromNano } from './money.js'
import { renderPayPage } from './paypage.js'
import { processIncoming, type PaymentListener } from './processor.js'
import { isError, type ChargePreview, type TillService } from './service.js'
import type { PendingAction, Seller, StoredEvent, TillStore } from './store/index.js'
import { pcmToWav, understandSpeech, type SttOptions } from './stt.js'
import { EXAMPLES, parseCommand, reconcileWithOriginal } from './voice.js'

const CONFIRM_TTL_SEC = 20

export interface ApiDeps {
  store: TillStore
  service: TillService
  stt: SttOptions
  publicUrl: string
  devSimulate: boolean
  voiceDebugDir?: string
  log?: (...a: unknown[]) => void
  /** Telegram bot for webhook mode (Vercel). Locally the bot uses long polling instead. */
  bot?: Bot
  telegramWebhookSecret?: string
  /** Live updates: how often to check for new events, and when to end a stream (serverless limit). */
  sse?: { pollMs?: number; maxSec?: number }
  /** Receipts etc. for dev-simulated payments (the watcher calls this for real ones). */
  onPayment?: PaymentListener
}

type Env = { Variables: { seller: Seller } }

function toPending(p: ChargePreview): PendingAction {
  return {
    kind: 'charge',
    label: p.label,
    amountNano: p.amountNano.toString(),
    item: p.item,
    qty: p.qty,
    customerId: p.customer?.id ?? null,
    reachable: p.reachable,
  }
}

export function buildApi(d: ApiDeps) {
  const app = new Hono<Env>()
  const log = d.log ?? (() => {})

  // The glasses app is served from its own origin (dev server / packaged WebView).
  // Auth is a bearer token, never cookies, so a permissive CORS policy is safe.
  app.use('/api/*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID'], allowMethods: ['GET', 'POST'] }))

  app.get('/health', c => c.json({ ok: true, store: d.store.kind }))
  app.get('/api/health', c => c.json({ ok: true, store: d.store.kind }))
  // Public info for the landing page (bot link, network).
  app.get('/api/info', async c => {
    let bot: string | null = null
    if (d.bot) {
      try {
        if (!d.bot.isInited()) await d.bot.init()
        bot = d.bot.botInfo.username
      } catch {
        bot = null
      }
    }
    return c.json({ bot, network: d.service.network })
  })

  // ---------- pairing ----------
  app.post('/api/pair', async c => {
    const { code } = await c.req.json<{ code?: string }>().catch(() => ({ code: undefined }))
    if (!code || !/^\d{6}$/.test(code.trim())) return c.json({ error: 'Enter the 6-digit code from the Telegram bot (/pair)' }, 400)
    const r = await d.store.redeemPairCode(code)
    if (!r) return c.json({ error: 'Code not valid or expired. Send /pair to the bot for a new one.' }, 401)
    return c.json({ token: r.token, seller: { name: r.seller.name, address: r.seller.address } })
  })

  // ---------- auth for everything below ----------
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/pair' || c.req.path === '/api/health' || c.req.path === '/api/info') return next()
    const header = c.req.header('Authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7) : c.req.query('token') // EventSource can't set headers
    const seller = await d.store.sellerForToken(token)
    if (!seller) return c.json({ error: 'Not paired' }, 401)
    c.set('seller', seller)
    await next()
  })

  app.get('/api/till', async c => c.json(await d.service.snapshot(c.get('seller'))))

  // ---------- live updates (SSE) ----------
  // Events come from the store, so the watcher can run in another process (a Vercel Daemon)
  // and any API instance can stream them. On serverless the stream ends before the function
  // limit; EventSource reconnects with Last-Event-ID and nothing is missed.
  app.get('/api/stream', c => {
    const seller = c.get('seller')
    const pollMs = d.sse?.pollMs ?? 700
    const maxMs = (d.sse?.maxSec ?? 0) * 1000
    const resumeFrom = Number(c.req.header('Last-Event-ID') ?? c.req.query('lastEventId') ?? NaN)
    return streamSSE(c, async stream => {
      let open = true
      stream.onAbort(() => {
        open = false
      })
      const started = Date.now()
      let lastId = Number.isFinite(resumeFrom) ? resumeFrom : await d.store.latestEventId(seller.id)
      const send = async (event: string, data: unknown, id?: number) => {
        if (!open) return
        await stream.writeSSE({ event, data: JSON.stringify(data), id: id === undefined ? undefined : String(id), retry: 1500 }).catch(() => {
          open = false
        })
      }
      await send('till', await d.service.snapshot(seller), lastId)
      let lastPing = Date.now()
      while (open && (!maxMs || Date.now() - started < maxMs)) {
        await stream.sleep(pollMs)
        if (!open) break
        let events: StoredEvent[] = []
        try {
          events = await d.store.eventsSince(seller.id, lastId)
        } catch (err) {
          log('[sse] poll failed:', (err as Error).message)
        }
        for (const e of events) {
          lastId = e.id
          if (e.payload.type === 'payment') {
            const { type: _t, ...payment } = e.payload
            await send('payment', payment, e.id)
          } else {
            const o = await d.store.getOrder(e.payload.orderId)
            if (o) await send('order', { change: e.payload.change, order: d.service.orderView(o) }, e.id)
          }
        }
        if (events.length) await send('till', await d.service.snapshot(seller), lastId)
        if (Date.now() - lastPing > 20_000) {
          await stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => {
            open = false
          })
          lastPing = Date.now()
        }
      }
    })
  })

  // ---------- voice & text commands -> preview -> one-tap confirm ----------
  /**
   * @param transcript  text to parse (English, or a typed command in any supported language)
   * @param original    for non-English speech: what was actually said, used to recover names/menu words
   */
  async function interpret(c: Context<Env>, transcript: string, original?: string) {
    const seller = c.get('seller')
    const [menu, customers] = await Promise.all([d.store.listMenu(seller.id), d.store.listCustomers(seller.id)])
    const ctx = { menu: menu.map(m => m.item), customers: customers.map(x => x.name) }
    let cmd = parseCommand(transcript, ctx)
    if (original && original !== transcript) {
      // If the translation lost the verb, try the original words too (typed-language aliases).
      if (cmd.kind === 'unknown' && !cmd.reason) cmd = parseCommand(original, ctx)
      cmd = reconcileWithOriginal(cmd, original, ctx)
    }
    if (original) transcript = original
    switch (cmd.kind) {
      case 'charge':
      case 'repeat': {
        const p = cmd.kind === 'charge' ? await d.service.previewCharge(seller, cmd) : await d.service.previewRepeat(seller)
        if (isError(p)) return c.json({ transcript, action: 'error', message: p.error })
        const id = randomUUID()
        await d.store.putPending(id, seller.id, toPending(p), CONFIRM_TTL_SEC)
        return c.json({
          transcript,
          action: 'confirm',
          confirm: { id, kind: 'charge', label: p.label, amount: fromNano(p.amountNano), item: p.item, reachable: p.reachable, expiresInSec: CONFIRM_TTL_SEC },
        })
      }
      case 'cancel': {
        const o = await d.service.findWaiting(seller, cmd.target)
        if (!o) return c.json({ transcript, action: 'error', message: 'No waiting order to cancel' })
        const id = randomUUID()
        await d.store.putPending(id, seller.id, { kind: 'cancel', orderId: o.id }, CONFIRM_TTL_SEC)
        return c.json({
          transcript,
          action: 'confirm',
          confirm: { id, kind: 'cancel', label: o.label, amount: fromNano(o.amountNano), item: o.item, reachable: false, expiresInSec: CONFIRM_TTL_SEC },
        })
      }
      case 'remind': {
        // A reminder only re-sends the same request to the same customer, so it runs without a confirm step.
        const waiting = await d.store.waitingOrders(seller.id)
        const targets = cmd.target === 'all' || cmd.target === null ? waiting : waiting.filter(o => o.label.toLowerCase() === cmd.target!.toLowerCase())
        if (!targets.length) return c.json({ transcript, action: 'error', message: 'No waiting orders to remind' })
        const r = await d.service.remind(seller, targets.map(o => o.id))
        return c.json({ transcript, action: 'done', message: `Reminded ${r.reminded}${r.unreachable ? ` · ${r.unreachable} not on Telegram` : ''}` })
      }
      case 'total': {
        const s = await d.service.snapshot(seller)
        return c.json({ transcript, action: 'done', message: `Today ${s.today.total} GRAM · ${s.today.paid} paid · ${s.today.waiting} waiting` })
      }
      default:
        if (cmd.reason === 'fiat') return c.json({ transcript, action: 'error', message: 'Say the amount in GRAM', examples: ['"Charge Maria twelve"'] })
        return c.json({ transcript, action: 'error', message: "Didn't catch that", examples: EXAMPLES })
    }
  }

  app.post('/api/voice', async c => {
    const pcm = new Uint8Array(await c.req.arrayBuffer())
    if (d.voiceDebugDir) writeFileSync(join(d.voiceDebugDir, 'last-voice.wav'), pcmToWav(pcm))
    try {
      const seller = c.get('seller')
      const [customers, menu] = await Promise.all([d.store.listCustomers(seller.id), d.store.listMenu(seller.id)])
      const vocab = [...customers.map(x => x.name), ...menu.map(m => m.item)].slice(0, 40)
      const heard = await understandSpeech(pcm, seller.language, {
        ...d.stt,
        // The prompt only biases spelling (names, menu words); keep it short and in the seller's terms.
        prompt: seller.language === 'en' ? `Charge Maria twelve. Charge table four, two lattes. ${vocab.join(', ')}` : vocab.join(', '),
      })
      if (!heard.english && !heard.original) return c.json({ transcript: '', action: 'error', message: "Didn't hear anything", examples: EXAMPLES })
      return interpret(c, heard.english || heard.original, heard.language === 'en' ? undefined : heard.original)
    } catch (err) {
      log('[voice]', (err as Error).message)
      return c.json({ transcript: '', action: 'error', message: (err as Error).message }, 200)
    }
  })

  app.post('/api/command', async c => {
    const { text } = await c.req.json<{ text?: string }>().catch(() => ({ text: '' }))
    if (!text?.trim()) return c.json({ error: 'text required' }, 400)
    return interpret(c, text.trim())
  })

  app.post('/api/confirm/:id', async c => {
    const seller = c.get('seller')
    const p = await d.store.takePending(c.req.param('id'), seller.id) // one-shot either way
    if (!p) return c.json({ error: 'This confirmation expired. Say it again.' }, 410)
    if (p.kind === 'charge') {
      const customer = p.customerId ? await d.store.getCustomer(p.customerId) : null
      const r = await d.service.charge(seller, {
        label: p.label,
        amountNano: BigInt(p.amountNano),
        item: p.item,
        qty: p.qty,
        customer,
        reachable: p.reachable,
      })
      return c.json({
        ok: true,
        message: r.delivered ? `Sent to ${r.order.label} on Telegram` : 'Show the counter QR to pay',
        order: d.service.orderView(r.order),
        delivered: r.delivered,
        payUrl: r.links.page,
      })
    }
    const r = await d.service.cancel(seller, p.orderId)
    if (isError(r)) return c.json({ error: r.error }, 409)
    return c.json({ ok: true, message: `Cancelled ${r.label}`, order: d.service.orderView(r) })
  })

  app.post('/api/discard/:id', async c => {
    await d.store.dropPending(c.req.param('id'))
    return c.json({ ok: true })
  })

  // One-tap presets from the glasses (no voice).
  app.post('/api/repeat', c => interpret(c, 'repeat'))

  app.post('/api/orders/:id/remind', async c => {
    const r = await d.service.remind(c.get('seller'), [Number(c.req.param('id'))])
    return c.json({ ok: r.reminded > 0, message: r.reminded ? 'Reminder sent' : 'Customer not on Telegram' })
  })

  app.post('/api/orders/:id/cancel', async c => {
    const r = await d.service.cancel(c.get('seller'), Number(c.req.param('id')))
    if (isError(r)) return c.json({ error: r.error }, 409)
    return c.json({ ok: true, order: d.service.orderView(r) })
  })

  // ---------- customer pay page ----------
  app.get('/pay/:code', async c => {
    const info = await d.service.payInfo(c.req.param('code'))
    if (!info) return c.text('Payment request not found', 404)
    return c.html(await renderPayPage(info, d.publicUrl))
  })

  app.get('/pay/:code/status', async c => {
    const info = await d.service.payInfo(c.req.param('code'))
    if (!info) return c.json({ error: 'not found' }, 404)
    return c.json({ status: info.status, expired: info.expired })
  })

  app.get('/tonconnect-manifest.json', c => c.json({ url: d.publicUrl, name: 'Gram Till', iconUrl: `${d.publicUrl}/static/icon.png` }))

  // ---------- Telegram (webhook mode) ----------
  if (d.bot) {
    const handle = webhookCallback(d.bot, 'hono', { secretToken: d.telegramWebhookSecret })
    app.post('/telegram/webhook', c => handle(c))
    // One-time setup after deploy: points Telegram at this server and registers the command menu.
    app.post('/telegram/setup', async c => {
      if (!d.telegramWebhookSecret || c.req.query('secret') !== d.telegramWebhookSecret) return c.json({ error: 'forbidden' }, 403)
      await d.bot!.api.setWebhook(`${d.publicUrl}/telegram/webhook`, {
        secret_token: d.telegramWebhookSecret,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
      })
      await d.bot!.api.setMyCommands(BOT_COMMANDS)
      const me = await d.bot!.api.getMe()
      return c.json({ ok: true, bot: `@${me.username}`, webhook: `${d.publicUrl}/telegram/webhook` })
    })
  }

  // ---------- dev only: fake a payment without the chain (testnet + DEV_SIMULATE=1) ----------
  if (d.devSimulate) {
    app.post('/dev/pay/:code', async c => {
      const order = await d.store.getOrderByCode(c.req.param('code'))
      if (!order) return c.json({ error: 'not found' }, 404)
      const { amount } = await c.req.json<{ amount?: string }>().catch(() => ({ amount: undefined }))
      const done = await processIncoming(d.store, order.sellerId, {
        txHash: `dev-${randomUUID()}`,
        from: null,
        amountNano: amount ? BigInt(Math.round(Number(amount) * 1e9)) : order.amountNano,
        comment: order.code,
        utime: Math.floor(Date.now() / 1000),
      })
      if (done) await d.onPayment?.(order.sellerId, done)
      return c.json({ result: done?.result ?? 'duplicate', note: 'DEV SIMULATION, not a real transfer' })
    })
  }

  return app
}
