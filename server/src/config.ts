import type { Network } from './ton.js'

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

const network = (env('NETWORK', 'testnet') as Network)
if (network !== 'testnet' && network !== 'mainnet') throw new Error(`NETWORK must be "testnet" or "mainnet", got "${network}"`)

export const config = {
  port: Number(env('PORT', '8787')),
  /** Public base URL of this server, used in payment-page links sent over Telegram. */
  publicUrl: (env('PUBLIC_URL', `http://localhost:${env('PORT', '8787')}`) as string).replace(/\/$/, ''),
  /**
   * testnet (default): full demo with test GRAM.
   * mainnet: watch a real Gram Wallet. Gram Till is read-only either way: it never
   * signs or sends transactions, it only reads the wallet and creates payment links.
   */
  network,
  toncenterApiKey: env('TONCENTER_API_KEY'),
  telegramBotToken: env('TELEGRAM_BOT_TOKEN'),
  stt: {
    apiKey: env('GROQ_API_KEY') ?? env('STT_API_KEY'),
    baseUrl: env('STT_BASE_URL', 'https://api.groq.com/openai/v1') as string,
    model: env('STT_MODEL', 'whisper-large-v3-turbo') as string,
  },
  dbPath: env('DB_PATH', './data/gramtill.db') as string,
  /** Default for sellers who haven't set /timezone in the bot. */
  timezone: env('TILL_TIMEZONE', 'UTC') as string,
  orderTtlMinutes: Number(env('ORDER_TTL_MINUTES', '30')),
  /** Largest single charge allowed from voice/glasses, in GRAM. Guards against misheard amounts. */
  maxChargeGram: Number(env('MAX_CHARGE_GRAM', '500')),
  /** Dev-only fake payment endpoint for UI work without the chain. Refused on mainnet. */
  devSimulate: env('DEV_SIMULATE', '0') === '1' && network === 'testnet',
  pollIntervalMs: Number(env('POLL_INTERVAL_MS', '4000')),
}

export type Config = typeof config
