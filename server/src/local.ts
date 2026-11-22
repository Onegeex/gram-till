// Local / single-machine mode: API + wallet watcher + Telegram bot (long polling) in one process.
// Uses SQLite unless DATABASE_URL is set.
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { buildApi } from './api.js'
import { createBot, BOT_COMMANDS } from './bot.js'
import { config } from './config.js'
import { TillService, nullNotifier } from './service.js'
import { openStore } from './store/index.js'
import { TelegramOut } from './telegram.js'
import { makeClient } from './ton.js'
import { Watcher, toncenterFetcher } from './watcher.js'

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

if (!config.databaseUrl && config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })
const store = await openStore({ databaseUrl: config.databaseUrl, sqlitePath: config.dbPath })
const service = new TillService(store, nullNotifier, config)
const out = config.telegramBotToken ? new TelegramOut(config.telegramBotToken, store, service, config.network, log) : null
if (out) service.notifier = out.notifier()

const api = buildApi({
  store,
  service,
  stt: config.stt,
  publicUrl: config.publicUrl,
  devSimulate: config.devSimulate,
  voiceDebugDir: config.voiceDebugDir,
  log,
  onPayment: out ? (id, p) => out.onPayment(id, p) : undefined,
})

// Static files the pay page needs (on Vercel these come from the web service).
const app = new Hono()
const require = createRequire(import.meta.url)
const tcRoot = dirname(dirname(require.resolve('@tonconnect/ui')))
const tcBundle = readFileSync(join(tcRoot, 'dist', 'tonconnect-ui.min.js'))
const icon = readFileSync(new URL('../static/icon.png', import.meta.url))
app.get('/static/tonconnect-ui.min.js', c => c.body(tcBundle, 200, { 'Content-Type': 'text/javascript' }))
app.get('/static/icon.png', c => c.body(icon, 200, { 'Content-Type': 'image/png' }))
app.route('/', api)

serve({ fetch: app.fetch, port: config.port }, info => {
  log(`Gram Till server on :${info.port} · store=${store.kind} · network=${config.network} · public=${config.publicUrl}`)
  if (!config.toncenterApiKey) log('! TONCENTER_API_KEY not set: polling is rate-limited (get a key from @tonapibot)')
  if (!config.stt.apiKey) log('! GROQ_API_KEY not set: voice commands disabled (text commands still work)')
  if (config.devSimulate) log('! DEV_SIMULATE=1: /dev/pay/<code> fakes payments (testnet only)')
})

const watcher = new Watcher(store, toncenterFetcher(makeClient(config.network, config.toncenterApiKey)), config.network, {
  intervalMs: config.pollIntervalMs,
  log,
  onPayment: out ? (id, p) => out.onPayment(id, p) : undefined,
})
watcher.start()

if (config.telegramBotToken && out) {
  const bot = createBot({ token: config.telegramBotToken, store, service, out, network: config.network, publicUrl: config.publicUrl, defaultTimezone: config.timezone, log })
  await bot.api.deleteWebhook().catch(() => {}) // long polling and a webhook can't both be active
  await bot.api.setMyCommands(BOT_COMMANDS).catch(() => {})
  void bot.start({ onStart: me => log(`Telegram bot @${me.username} running (long polling)`) })
} else {
  log('! TELEGRAM_BOT_TOKEN not set: no bot (sellers cannot sign up or pair)')
}

const shutdown = async () => {
  watcher.stop()
  await store.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
