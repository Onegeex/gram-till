// Vercel entry: the API runs as a Vercel Function (Hono). The wallet watcher runs separately
// as a Vercel Daemon (src/worker.ts); they share state through Postgres.
import { Hono } from 'hono'
import { buildApi } from './api.js'
import { createBot } from './bot.js'
import { config } from './config.js'
import { TillService, nullNotifier } from './service.js'
import { openStore } from './store/index.js'
import { TelegramOut } from './telegram.js'

async function init() {
  const store = await openStore({ databaseUrl: config.databaseUrl, sqlitePath: config.onVercel ? ':memory:' : config.dbPath })
  if (config.onVercel && store.kind !== 'pg') console.warn('! No DATABASE_URL: using a throwaway in-memory store (connect Neon in the Vercel dashboard)')
  const service = new TillService(store, nullNotifier, config)
  let bot
  if (config.telegramBotToken) {
    const out = new TelegramOut(config.telegramBotToken, store, service, config.network)
    service.notifier = out.notifier()
    bot = createBot({ token: config.telegramBotToken, store, service, out, network: config.network, publicUrl: config.publicUrl, defaultTimezone: config.timezone, log: console.log })
  }
  return buildApi({
    store,
    service,
    stt: config.stt,
    publicUrl: config.publicUrl,
    devSimulate: config.devSimulate,
    log: console.log,
    bot,
    telegramWebhookSecret: config.telegramWebhookSecret,
    sse: { maxSec: config.sseMaxSec, pollMs: 1500 },
  })
}

let api: ReturnType<typeof buildApi> | null = null
let starting: Promise<ReturnType<typeof buildApi>> | null = null
const ready = () => (api ? Promise.resolve(api) : (starting ??= init().then(a => (api = a))))

const app = new Hono()
app.all('*', async c => (await ready()).fetch(c.req.raw))

export default app
