import { describe, expect, it } from 'vitest'
import { GlassesDisplay } from '../src/display'
import { confirmCard, tillCard, type Card, type TillSnapshot } from '../src/format'

/** Minimal fake bridge that records calls; behaviour of each method is configurable. */
function fakeBridge(o: { create?: number; upgrade?: boolean }) {
  const calls: string[] = []
  const bridge = {
    async createStartUpPageContainer(p: any) {
      calls.push(`create:${p.containerTotalNum}`)
      return o.create ?? 0
    },
    async rebuildPageContainer(p: any) {
      calls.push(`rebuild:${p.containerTotalNum}`)
      return true
    },
    async textContainerUpgrade(c: any) {
      calls.push(`upgrade:${c.containerName}=${c.content}`)
      return o.upgrade ?? true
    },
    async updateImageRawData(u: any) {
      calls.push(`image:${new TextDecoder().decode(u.imageData)}`)
      return 'success'
    },
  }
  return { bridge: bridge as any, calls }
}
const render = async (h: NonNullable<Card['hero']>) => new TextEncoder().encode(`${h.kicker}:${h.big ?? ''}`)

const snap: TillSnapshot = {
  seller: { name: 'Corner Coffee', address: 'x', network: 'testnet' },
  today: { total: '12', paid: 3, unmatched: 0, waiting: 1 },
  waiting: [],
  recent: [],
}
const charge = { id: 'c1', kind: 'charge' as const, label: 'Maria', amount: '5', item: null, reachable: true, expiresInSec: 20 }

describe('GlassesDisplay', () => {
  it('draws the startup card with its hero picture', async () => {
    const { bridge, calls } = fakeBridge({})
    await GlassesDisplay.create(bridge, tillCard(snap), render)
    expect(calls).toEqual(['create:5', 'image:TODAY:12'])
  })

  it('same layout: upgrades only the changed texts and skips an unchanged picture', async () => {
    const { bridge, calls } = fakeBridge({})
    const d = await GlassesDisplay.create(bridge, confirmCard(charge, snap, 19), render)
    calls.length = 0
    await d.card(confirmCard(charge, snap, 18)) // countdown tick
    expect(calls).toEqual(['upgrade:hint=TAP  send        2x TAP  cancel   18s'])
  })

  it('different layout: one rebuild, then the new picture', async () => {
    const { bridge, calls } = fakeBridge({})
    const d = await GlassesDisplay.create(bridge, tillCard(snap), render)
    calls.length = 0
    await d.card(confirmCard(charge, snap, 19))
    expect(calls).toEqual(['rebuild:5', 'image:CHARGE:5'])
  })

  it('rebuilds when the startup page is refused (e.g. WebView reloaded)', async () => {
    const { bridge, calls } = fakeBridge({ create: 1 })
    await GlassesDisplay.create(bridge, tillCard(snap), render)
    expect(calls.slice(0, 2)).toEqual(['create:5', 'rebuild:5'])
  })

  it('rebuilds when an upgrade fails because the page is gone ("container not found")', async () => {
    const { bridge, calls } = fakeBridge({ upgrade: false })
    const d = await GlassesDisplay.create(bridge, tillCard(snap), render)
    calls.length = 0
    await d.card(tillCard({ ...snap, today: { ...snap.today, paid: 4 } }))
    expect(calls[0]).toMatch(/^upgrade:body=/)
    expect(calls[1]).toBe('rebuild:5')
  })
})
