// Vercel Daemon: the always-on wallet watcher. Polls each seller's wallet (read-only),
// records payments, publishes live events (Postgres) and sends Telegram receipts.
import { createServer } from 'node:http'
import { config } from './config.js'
import { TillService, nullNotifier } from './service.js'
import { openStore } from './store/index.js'
import { TelegramOut } from './telegram.js'
import { makeClient } from './ton.js'
import { Watcher, toncenterFetcher } from './watcher.js'

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

if (!config.databaseUrl) {
  log('! DATABASE_URL is not set. The watcher needs the shared Postgres database; idling.')
}

let lastTick = Date.now()
// Liveness: unhealthy if the watcher loop hasn't completed a cycle in 5 minutes.
createServer((req, res) => {
  const healthy = Date.now() - lastTick < 5 * 60_000
  res.statusCode = req.url === '/health' ? (healthy ? 200 : 503) : 404
  res.end(healthy ? 'ok' : 'stale')
}).listen(8080)

if (config.databaseUrl) {
  const store = await openStore({ databaseUrl: config.databaseUrl })
  const service = new TillService(store, nullNotifier, config)
  const out = config.telegramBotToken ? new TelegramOut(config.telegramBotToken, store, service, config.network, log) : null
  const watcher = new Watcher(store, toncenterFetcher(makeClient(config.network, config.toncenterApiKey)), config.network, {
    intervalMs: config.pollIntervalMs,
    log,
    onPayment: out ? (id, p) => out.onPayment(id, p) : undefined,
    onTick: () => {
      lastTick = Date.now()
    },
  })
  watcher.start()
  log(`watcher running · network=${config.network} · telegram=${out ? 'on' : 'off'} · every ${config.pollIntervalMs} ms`)
  process.on('SIGTERM', async () => {
    log('SIGTERM: stopping watcher')
    watcher.stop()
    await store.close()
    process.exit(0)
  })
} else {
  setInterval(() => (lastTick = Date.now()), 60_000)
}
