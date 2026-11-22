import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { Backend } from './backend'
import { mountCompanion, type Companion } from './companion'
import { TillController } from './controller'
import { GlassesDisplay, toGestures } from './display'
import { unpairedCard } from './format'

const DEFAULT_SERVER = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? 'http://localhost:8787'
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

async function main() {
  let companion: Companion | null = null
  const bridge = await waitForEvenAppBridge()
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
  if (!backend.token && urlCode && /^\d{6}$/.test(urlCode)) {
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
