import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { Backend } from './backend'
import { mountCompanion, type Companion } from './companion'
import { TillController } from './controller'
import { GlassesDisplay, toGestures } from './display'
import { confirmCard, listeningCard, messageCard, offlineCard, paymentCard, thinkingCard, tillCard, unpairedCard, type Card, type TillSnapshot } from './format'

// Hosted (https, e.g. on Vercel) the API is on the same origin; in local dev it's the server on :8787.
const DEFAULT_SERVER =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ?? (location.protocol === 'https:' ? location.origin : 'http://localhost:8787')
const K_SERVER = 'gt_server'
const K_TOKEN = 'gt_token'

async function load(bridge: EvenAppBridge, key: string): Promise<string> {
  // Prefer the Even app's storage (survives WebView reloads); fall back to localStorage.
  const v = await bridge.getLocalStorage(key).catch(() => '')
  if (v) return v
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

async function save(bridge: EvenAppBridge, key: string, value: string) {
  await bridge.setLocalStorage(key, value).catch(() => false)
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage can be unavailable in some WebViews */
  }
}

/** ?gallery: step through every lens card with sample data (design review and screenshots). Tap = next. */
function galleryCards(): Card[] {
  const s: TillSnapshot = {
    seller: { name: 'Corner Coffee', address: 'x', network: 'testnet' },
    today: { total: '214', paid: 18, unmatched: 0, waiting: 2 },
    waiting: [],
    recent: [{ amount: '12', result: 'paid', label: 'Table 4', comment: 'GT-7F3K', agoMin: 2 }],
  }
  const c = { id: 'x', kind: 'charge' as const, label: 'Maria', amount: '5', item: null, reachable: true, expiresInSec: 20 }
  return [
    tillCard(s),
    listeningCard(6, s, 0.15),
    listeningCard(5, s, 0.8, true),
    thinkingCard('Charge Maria five.', s),
    confirmCard(c, s, 17),
    confirmCard({ ...c, label: 'Table 4', amount: '8', item: '2x latte', reachable: false }, s, 12),
    paymentCard({ result: 'paid', amount: '5', label: 'Maria', code: 'GT-7F3K', item: null, late: false, comment: 'GT-7F3K' }, s),
    paymentCard({ result: 'underpaid', amount: '3', label: 'Kenji', code: 'GT-9QX2', item: null, late: false, comment: 'GT-9QX2' }, s),
    paymentCard({ result: 'unmatched', amount: '20', label: null, code: null, item: null, late: false, comment: 'thanks!' }, s),
    messageCard('Sent to Maria on Telegram', undefined, s),
    messageCard('Say the amount in GRAM', ['"Charge Maria twelve"'], s),
    offlineCard(s),
    unpairedCard(),
  ]
}

async function main() {
  let companion: Companion | null = null
  const bridge = await waitForEvenAppBridge()
  if (new URLSearchParams(location.search).has('gallery')) {
    const cards = galleryCards()
    let i = 0
    const display = await GlassesDisplay.create(bridge, cards[0])
    bridge.onEvenHubEvent(e => {
      for (const g of toGestures(e)) {
        if (g.kind === 'tap' || g.kind === 'down') void display.card(cards[(i = (i + 1) % cards.length)])
        if (g.kind === 'up') void display.card(cards[(i = (i + cards.length - 1) % cards.length)])
      }
    })
    console.log('GRAM_TILL_GALLERY', cards.length)
    return
  }
  const display = await GlassesDisplay.create(bridge, unpairedCard())

  const backend = new Backend((await load(bridge, K_SERVER)) || DEFAULT_SERVER, (await load(bridge, K_TOKEN)) || null)
  const controller = new TillController(display, backend)
  controller.onTranscript = t => companion?.transcript(t)

  let closeStream: (() => void) | null = null

  async function connect(): Promise<boolean> {
    closeStream?.()
    closeStream = null
    if (!backend.token) {
      controller.setPaired(false)
      companion?.state({ paired: false, server: backend.baseUrl })
      return false
    }
    try {
      const snap = await backend.till()
      controller.setSnapshot(snap)
      controller.setOnline(true)
      controller.setPaired(true)
      companion?.state({ paired: true, server: backend.baseUrl, shop: snap.seller.name, network: snap.seller.network, snapshot: snap })
      closeStream = backend.stream({
        till: s => {
          controller.setSnapshot(s)
          companion?.state({ paired: true, server: backend.baseUrl, shop: s.seller.name, network: s.seller.network, snapshot: s })
        },
        payment: p => {
          controller.onPayment(p)
          companion?.payment(p)
        },
        status: online => {
          controller.setOnline(online)
          companion?.online(online)
        },
      })
      return true
    } catch (err) {
      if ((err as { status?: number }).status === 401) {
        backend.token = null
        await save(bridge, K_TOKEN, '')
        controller.setPaired(false)
        companion?.state({ paired: false, server: backend.baseUrl, error: 'Pairing expired. Send /pair to the bot again.' })
      } else {
        controller.setPaired(true)
        controller.setOnline(false)
        companion?.state({ paired: true, server: backend.baseUrl, error: `Can't reach ${backend.baseUrl}` })
        setTimeout(connect, 5000)
      }
      return false
    }
  }

  companion = mountCompanion({
    server: backend.baseUrl,
    async pair(server, code) {
      backend.baseUrl = server.trim().replace(/\/$/, '')
      await save(bridge, K_SERVER, backend.baseUrl)
      const r = await backend.pair(code.trim())
      backend.token = r.token
      await save(bridge, K_TOKEN, r.token)
      await connect()
    },
    async unpair() {
      backend.token = null
      await save(bridge, K_TOKEN, '')
      await connect()
    },
    typed: text => controller.typed(text),
  })

  const unsubscribe = bridge.onEvenHubEvent(event => {
    for (const g of toGestures(event)) {
      if (g.kind === 'exit') {
        closeStream?.()
        unsubscribe()
      }
      void controller.gesture(g)
    }
  })

  // Optional deep link for quick setup: index.html?server=https://…&pair=123456
  const params = new URLSearchParams(location.search)
  const urlServer = params.get('server')
  const urlCode = params.get('pair')
  // A pairing link always wins over a stored token (re-pairing a phone, or a stale token after a server reset).
  if (urlCode && /^\d{6}$/.test(urlCode)) {
    if (urlServer) {
      backend.baseUrl = urlServer.replace(/\/$/, '')
      await save(bridge, K_SERVER, backend.baseUrl)
    }
    try {
      const r = await backend.pair(urlCode)
      backend.token = r.token
      await save(bridge, K_TOKEN, r.token)
    } catch (err) {
      console.warn('URL pairing failed:', (err as Error).message)
    }
  }

  await connect()
  console.log('GRAM_TILL_READY')
}

main().catch(err => {
  console.error(err)
  document.getElementById('app')!.textContent = `Gram Till failed to start: ${(err as Error).message}`
})
