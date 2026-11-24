import { describe, expect, it } from 'vitest'
import { GlassesDisplay } from '../src/display'

/** Minimal fake bridge that records calls; behaviour of each method is configurable. */
function fakeBridge(o: { create?: number; upgrade?: boolean }) {
  const calls: string[] = []
  const bridge = {
    async createStartUpPageContainer() {
      calls.push('create')
      return o.create ?? 0
    },
    async rebuildPageContainer(c: any) {
      calls.push(`rebuild:${c.textObject?.[0]?.content ?? ''}`)
      return true
    },
    async textContainerUpgrade(c: any) {
      calls.push(`upgrade:${c.content}`)
      return o.upgrade ?? true
    },
  }
  return { bridge: bridge as any, calls }
}

describe('GlassesDisplay keeps the lens drawn', () => {
  it('uses the fast in-place upgrade normally', async () => {
    const { bridge, calls } = fakeBridge({})
    const d = await GlassesDisplay.create(bridge, 'A')
    await d.text('B')
    expect(calls).toEqual(['create', 'upgrade:B'])
  })

  it('rebuilds when the startup page is refused (e.g. WebView reloaded)', async () => {
    const { bridge, calls } = fakeBridge({ create: 1 })
    await GlassesDisplay.create(bridge, 'A')
    expect(calls).toEqual(['create', 'rebuild:A'])
  })

  it('rebuilds when an upgrade fails because the page is gone ("container 1 not found")', async () => {
    const { bridge, calls } = fakeBridge({ upgrade: false })
    const d = await GlassesDisplay.create(bridge, 'A')
    await d.text('B')
    expect(calls).toEqual(['create', 'upgrade:B', 'rebuild:B'])
  })
})
