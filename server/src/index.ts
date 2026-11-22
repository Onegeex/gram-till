import { serve } from '@hono/node-server'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildApi } from './api.js'
import { config } from './config.js'
import { Store } from './db.js'
import { TillBus } from './processor.js'
import { TillService, nullNotifier } from './service.js'
import { makeClient } from './ton.js'
import { Watcher, toncenterFetcher } from './watcher.js'
import { startBot } from './bot.js'

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })
const store = new Store(config.dbPath)
const bus = new TillBus()
const service = new TillService(store, bus, nullNotifier, config)

const watcher = new Watcher(store, bus, toncenterFetcher(makeClient(config.network, config.toncenterApiKey)), config.network, {
  intervalMs: config.pollIntervalMs,
  log,
})

const app = buildApi({ store, bus, service, stt: config.stt, publicUrl: config.publicUrl, devSimulate: config.devSimulate, log })

serve({ fetch: app.fetch, port: config.port }, info => {
  log(`Gram Till server on :${info.port} · network=${config.network} · public=${config.publicUrl}`)
  if (!config.toncenterApiKey) log('! TONCENTER_API_KEY not set: polling is rate-limited (get a key from @tonapibot)')
  if (!config.stt.apiKey) log('! GROQ_API_KEY not set: voice commands disabled (text commands still work)')
  if (config.devSimulate) log('! DEV_SIMULATE=1: /dev/pay/<code> fakes payments (testnet only)')
})

watcher.start()

if (config.telegramBotToken) {
  startBot({ token: config.telegramBotToken, store, bus, service, network: config.network, publicUrl: config.publicUrl, defaultTimezone: config.timezone, log })
    .then(notifier => {
      service.notifier = notifier
    })
    .catch(err => log('! Telegram bot failed to start:', (err as Error).message))
} else {
  log('! TELEGRAM_BOT_TOKEN not set: no bot (sellers cannot sign up or pair)')
}

const shutdown = () => {
  watcher.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
