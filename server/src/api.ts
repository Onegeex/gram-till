import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Seller, Store } from './db.js'
import { fromNano } from './money.js'
import { renderPayPage } from './paypage.js'
import { TillBus, processIncoming } from './processor.js'
import { isError, type ChargePreview, type TillService } from './service.js'
import { pcmToWav, understandSpeech, type SttOptions } from './stt.js'
import { EXAMPLES, parseCommand, reconcileWithOriginal } from './voice.js'

type Pending =
  | { kind: 'charge'; sellerId: number; preview: ChargePreview; expires: number }
  | { kind: 'cancel'; sellerId: number; orderId: number; expires: number }

const CONFIRM_TTL_MS = 20_000

export interface ApiDeps {
  store: Store
  bus: TillBus
  service: TillService
  stt: SttOptions
  publicUrl: string
  devSimulate: boolean
  voiceDebugDir?: string
  log?: (...a: unknown[]) => void
}

export function buildApi(d: ApiDeps) {
  const app = new Hono<{ Variables: { seller: Seller } }>()
  const pending = new Map<string, Pending>()
  const sweep = () => {
    const t = Date.now()
    for (const [k, v] of pending) if (v.expires < t) pending.delete(k)
  }

  // The glasses app is served from its own origin (dev server / packaged WebView).
  // Auth is a bearer token, never cookies, so a permissive CORS policy is safe.
  app.use('/api/*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST'] }))

  app.get('/health', c => c.json({ ok: true }))

  // ---------- pairing ----------
  app.post('/api/pair', async c => {
    const { code } = await c.req.json<{ code?: string }>().catch(() => ({ code: undefined }))
    if (!code || !/^\d{6}$/.test(code.trim())) return c.json({ error: 'Enter the 6-digit code from the Telegram bot (/pair)' }, 400)
    const r = d.store.redeemPairCode(code)
    if (!r) return c.json({ error: 'Code not valid or expired. Send /pair to the bot for a new one.' }, 401)
    return c.json({ token: r.token, seller: { name: r.seller.name, address: r.seller.address } })
  })

  // ---------- auth for everything below ----------
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/pair') return next()
    const header = c.req.header('Authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7) : c.req.query('token') // EventSource can't set headers
    const seller = d.store.sellerForToken(token)
    if (!seller) return c.json({ error: 'Not paired' }, 401)
    c.set('seller', seller)
    await next()
  })

  app.get('/api/till', c => c.json(d.service.snapshot(c.get('seller'))))

  // ---------- live updates (SSE) ----------
  app.get('/api/stream', c => {
    const seller = c.get('seller')
    return streamSSE(c, async stream => {
      let open = true
      const send = (event: string, data: unknown) =>
        open ? stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => { open = false }) : undefined
      await send('till', d.service.snapshot(seller))
      const unsubscribe = d.bus.subscribe(e => {
        if (e.sellerId !== seller.id) return
        if (e.type === 'payment') {
          send('payment', {
            result: e.result,
            amount: fromNano(e.payment.amountNano),
            label: e.order?.label ?? null,
            code: e.order?.code ?? null,
            item: e.order?.item ?? null,
            late: e.late,
            comment: e.payment.comment,
          })
        } else {
          send('order', { change: e.change, order: d.service.orderView(e.order) })
        }
        send('till', d.service.snapshot(seller))
      })
      stream.onAbort(() => {
        open = false
        unsubscribe()
      })
      while (open) {
        await stream.sleep(25_000)
        if (open) await stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => { open = false })
      }
      unsubscribe()
    })
  })

  // ---------- voice & text commands -> preview -> one-tap confirm ----------
  /**
   * @param transcript  text to parse (English, or a typed command in any supported language)
   * @param original    for non-English speech: what was actually said, used to recover names/menu words
   */
  async function interpret(c: Context<{ Variables: { seller: Seller } }>, transcript: string, original?: string) {
    const seller = c.get('seller')
    const ctx = { menu: d.store.listMenu(seller.id).map(m => m.item), customers: d.store.listCustomers(seller.id).map(x => x.name) }
    let cmd = parseCommand(transcript, ctx)
    if (original && original !== transcript) {
      // If the translation lost the verb, try the original words too (typed-language aliases).
      if (cmd.kind === 'unknown' && !cmd.reason) cmd = parseCommand(original, ctx)
      cmd = reconcileWithOriginal(cmd, original, ctx)
    }
    if (original) transcript = original
    sweep()
    switch (cmd.kind) {
      case 'charge':
      case 'repeat': {
        const p = cmd.kind === 'charge' ? d.service.previewCharge(seller, cmd) : d.service.previewRepeat(seller)
        if (isError(p)) return c.json({ transcript, action: 'error', message: p.error })
        const id = randomUUID()
        pending.set(id, { kind: 'charge', sellerId: seller.id, preview: p, expires: Date.now() + CONFIRM_TTL_MS })
        return c.json({
          transcript,
          action: 'confirm',
          confirm: {
            id,
            kind: 'charge',
            label: p.label,
            amount: fromNano(p.amountNano),
            item: p.item,
            reachable: p.reachable,
            expiresInSec: CONFIRM_TTL_MS / 1000,
          },
        })
      }
      case 'cancel': {
        const o = d.service.findWaiting(seller, cmd.target)
        if (!o) return c.json({ transcript, action: 'error', message: 'No waiting order to cancel' })
        const id = randomUUID()
        pending.set(id, { kind: 'cancel', sellerId: seller.id, orderId: o.id, expires: Date.now() + CONFIRM_TTL_MS })
        return c.json({
          transcript,
          action: 'confirm',
          confirm: { id, kind: 'cancel', label: o.label, amount: fromNano(o.amountNano), item: o.item, reachable: false, expiresInSec: CONFIRM_TTL_MS / 1000 },
        })
      }
      case 'remind': {
        // A reminder only re-sends the same request to the same customer, so it runs without a confirm step.
        const waiting = d.store.waitingOrders(seller.id)
        const targets = cmd.target === 'all' || cmd.target === null ? waiting : waiting.filter(o => o.label.toLowerCase() === cmd.target!.toLowerCase())
        if (!targets.length) return c.json({ transcript, action: 'error', message: 'No waiting orders to remind' })
        const r = await d.service.remind(seller, targets.map(o => o.id))
        return c.json({ transcript, action: 'done', message: `Reminded ${r.reminded}${r.unreachable ? ` · ${r.unreachable} not on Telegram` : ''}` })
      }
      case 'total': {
        const s = d.service.snapshot(seller)
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
      const vocab = [...d.store.listCustomers(seller.id).map(x => x.name), ...d.store.listMenu(seller.id).map(m => m.item)].slice(0, 40)
      const heard = await understandSpeech(pcm, seller.language, {
        ...d.stt,
        // The prompt only biases spelling (names, menu words); keep it short and in the seller's terms.
        prompt: seller.language === 'en' ? `Charge Maria twelve. Charge table four, two lattes. ${vocab.join(', ')}` : vocab.join(', '),
      })
      if (!heard.english && !heard.original) return c.json({ transcript: '', action: 'error', message: "Didn't hear anything", examples: EXAMPLES })
      return interpret(c, heard.english || heard.original, heard.language === 'en' ? undefined : heard.original)
    } catch (err) {
      d.log?.('[voice]', (err as Error).message)
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
    sweep()
    const p = pending.get(c.req.param('id'))
    pending.delete(c.req.param('id')) // one-shot either way
    if (!p || p.sellerId !== seller.id) return c.json({ error: 'This confirmation expired. Say it again.' }, 410)
    if (p.kind === 'charge') {
      const r = await d.service.charge(seller, p.preview)
      return c.json({
        ok: true,
        message: r.delivered ? `Sent to ${r.order.label} on Telegram` : 'Show the counter QR to pay',
        order: d.service.orderView(r.order),
        delivered: r.delivered,
        payUrl: r.links.page,
      })
    }
    const r = d.service.cancel(seller, p.orderId)
    if (isError(r)) return c.json({ error: r.error }, 409)
    return c.json({ ok: true, message: `Cancelled ${r.label}`, order: d.service.orderView(r) })
  })

  app.post('/api/discard/:id', c => {
    pending.delete(c.req.param('id'))
    return c.json({ ok: true })
  })

  // One-tap presets from the glasses (no voice).
  app.post('/api/repeat', c => interpret(c, 'repeat'))

  app.post('/api/orders/:id/remind', async c => {
    const r = await d.service.remind(c.get('seller'), [Number(c.req.param('id'))])
    return c.json({ ok: r.reminded > 0, message: r.reminded ? 'Reminder sent' : 'Customer not on Telegram' })
  })

  app.post('/api/orders/:id/cancel', c => {
    const r = d.service.cancel(c.get('seller'), Number(c.req.param('id')))
    if (isError(r)) return c.json({ error: r.error }, 409)
    return c.json({ ok: true, order: d.service.orderView(r) })
  })

  // ---------- customer pay page ----------
  app.get('/pay/:code', async c => {
    const info = d.service.payInfo(c.req.param('code'))
    if (!info) return c.text('Payment request not found', 404)
    return c.html(await renderPayPage(info, d.publicUrl))
  })

  app.get('/pay/:code/status', c => {
    const info = d.service.payInfo(c.req.param('code'))
    if (!info) return c.json({ error: 'not found' }, 404)
    return c.json({ status: info.status, expired: info.expired })
  })

  app.get('/tonconnect-manifest.json', c =>
    c.json({ url: d.publicUrl, name: 'Gram Till', iconUrl: `${d.publicUrl}/static/icon.png` }),
  )

  // The UMD bundle isn't in the package's "exports", so locate it via the package root.
  const require = createRequire(import.meta.url)
  const tcRoot = dirname(dirname(require.resolve('@tonconnect/ui'))) // .../@tonconnect/ui/lib/index.cjs -> package root
  const tcBundle = readFileSync(join(tcRoot, 'dist', 'tonconnect-ui.min.js'))
  app.get('/static/tonconnect-ui.min.js', c => c.body(tcBundle, 200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=86400' }))
  const icon = (() => {
    try {
      return readFileSync(new URL('../static/icon.png', import.meta.url))
    } catch {
      return null
    }
  })()
  app.get('/static/icon.png', c => (icon ? c.body(icon, 200, { 'Content-Type': 'image/png' }) : c.notFound()))

  // ---------- dev only: fake a payment without the chain (testnet + DEV_SIMULATE=1) ----------
  if (d.devSimulate) {
    app.post('/dev/pay/:code', async c => {
      const order = d.store.getOrderByCode(c.req.param('code'))
      if (!order) return c.json({ error: 'not found' }, 404)
      const { amount } = await c.req.json<{ amount?: string }>().catch(() => ({ amount: undefined }))
      const result = processIncoming(d.store, d.bus, order.sellerId, {
        txHash: `dev-${randomUUID()}`,
        from: null,
        amountNano: amount ? BigInt(Math.round(Number(amount) * 1e9)) : order.amountNano,
        comment: order.code,
        utime: Math.floor(Date.now() / 1000),
      })
      return c.json({ result, note: 'DEV SIMULATION, not a real transfer' })
    })
  }

  return app
}
