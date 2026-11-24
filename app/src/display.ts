import {
  AudioInputSource,
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type { Card } from './format'
import { HERO_H, HERO_W, heroKey, renderHero } from './hero'

/** What the controller needs from the glasses. Faked in tests. */
export interface Display {
  card(c: Card): Promise<void>
  list(header: string, items: string[]): Promise<void>
  mic(on: boolean): Promise<boolean>
  exitDialog(): Promise<void>
}

export type Gesture =
  | { kind: 'tap' }
  | { kind: 'double' }
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'select'; index: number }
  | { kind: 'foreground'; on: boolean }
  | { kind: 'exit' }
  | { kind: 'audio'; pcm: Uint8Array }

// ---------- card layout (576 x 288) ----------
const ID = { statusL: 1, statusR: 2, body: 3, hint: 4, hero: 5, head: 6, list: 7 } as const
const NAME: Record<number, string> = { 1: 'statusL', 2: 'statusR', 3: 'body', 4: 'hint', 5: 'hero', 6: 'head', 7: 'list' }
const DIM = 2
const BRIGHT = 4

type TextSlot = { id: number; x: number; y: number; w: number; h: number; color: number; capture?: boolean; border?: boolean }

function slots(hasHero: boolean, boxed: boolean): TextSlot[] {
  return [
    // Tall enough for one line of the lens font: a shorter box shows a scroll bar.
    { id: ID.statusL, x: 8, y: 0, w: 372, h: 38, color: DIM },
    { id: ID.statusR, x: 384, y: 0, w: 184, h: 38, color: DIM },
    hasHero
      ? { id: ID.body, x: 300, y: 42, w: 268, h: 196, color: BRIGHT, capture: true, border: boxed }
      : { id: ID.body, x: 8, y: 42, w: 560, h: 196, color: BRIGHT, capture: true, border: boxed },
    { id: ID.hint, x: 8, y: 246, w: 560, h: 40, color: DIM },
  ]
}

const textOf = (c: Card): Record<number, string> => ({
  [ID.statusL]: c.status[0],
  [ID.statusR]: c.status[1],
  [ID.body]: [c.title ?? '', ...(c.title && c.lines?.length ? [''] : []), ...(c.lines ?? [])].join('\n'),
  [ID.hint]: c.hint ?? '',
})

const textBox = (t: TextSlot, content: string) =>
  new TextContainerProperty({
    xPosition: t.x,
    yPosition: t.y,
    width: t.w,
    height: t.h,
    borderWidth: t.border ? 1 : 0,
    borderColor: t.border ? 13 : 0,
    borderRadius: t.border ? 10 : 0,
    paddingLength: t.id === ID.body ? 10 : 2,
    containerID: t.id,
    containerName: NAME[t.id],
    content,
    textColor: t.color,
    isEventCapture: t.capture ? 1 : 0,
  })

const heroBox = () =>
  new ImageContainerProperty({ xPosition: 10, yPosition: 52, width: HERO_W, height: HERO_H, containerID: ID.hero, containerName: NAME[ID.hero] })

function page(c: Card) {
  const hasHero = !!c.hero
  const t = textOf(c)
  const texts = slots(hasHero, !!c.boxed).map(s => textBox(s, t[s.id]))
  const images = hasHero ? [heroBox()] : []
  return { containerTotalNum: texts.length + images.length, textObject: texts, imageObject: images }
}

export type HeroRenderer = (h: NonNullable<Card['hero']>) => Promise<Uint8Array>

/**
 * Bridge-backed display. Every bridge call goes through one promise chain:
 * the SDK docs warn that concurrent calls can break the BLE connection.
 * Same layout => only the changed texts are upgraded in place and the hero picture is
 * re-sent only when it changed (no flicker). A different layout => one page rebuild.
 */
export class GlassesDisplay implements Display {
  private queue: Promise<unknown> = Promise.resolve()
  private layout = ''
  private texts: Record<number, string> = {}
  private heroShown = ''

  private constructor(
    private bridge: EvenAppBridge,
    private render: HeroRenderer,
  ) {}

  static async create(bridge: EvenAppBridge, initial: Card, render: HeroRenderer = renderHero): Promise<GlassesDisplay> {
    const d = new GlassesDisplay(bridge, render)
    const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page(initial)))
    if (r !== 0) {
      // The startup page can only be created once per session (e.g. the WebView reloaded), or the
      // host refused it. Draw our page with a rebuild instead of leaving the lens blank.
      console.warn('createStartUpPageContainer returned', r, '- rebuilding the page instead')
      const ok = await bridge.rebuildPageContainer(new RebuildPageContainer(page(initial))).catch(() => false)
      if (!ok) console.error('rebuildPageContainer also failed; the lens may stay blank until the next screen change')
    }
    d.layout = layoutKey(initial)
    d.texts = textOf(initial)
    await d.sendHero(initial)
    return d
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(err => console.error('[display]', err))
    return next
  }

  card(c: Card) {
    return this.run(async () => {
      const key = layoutKey(c)
      const want = textOf(c)
      if (key !== this.layout) return this.rebuild(c)
      for (const id of [ID.statusL, ID.statusR, ID.body, ID.hint]) {
        if (want[id] === this.texts[id]) continue
        const ok = await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: NAME[id], content: want[id] })).catch(() => false)
        // "container N not found": the page isn't there (lost or never created). Rebuild it.
        if (ok === false) return this.rebuild(c)
        this.texts[id] = want[id]
      }
      await this.sendHero(c)
    })
  }

  private async rebuild(c: Card) {
    await this.bridge.rebuildPageContainer(new RebuildPageContainer(page(c)))
    this.layout = layoutKey(c)
    this.texts = textOf(c)
    this.heroShown = ''
    await this.sendHero(c)
  }

  private async sendHero(c: Card) {
    if (!c.hero) return
    const key = heroKey(c.hero)
    if (key === this.heroShown) return
    try {
      const png = await this.render(c.hero)
      const r = await this.bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: ID.hero, containerName: NAME[ID.hero], imageData: png }))
      if (String(r) !== 'success' && String(r) !== '0') console.warn('hero image not shown:', r)
      this.heroShown = key
    } catch (err) {
      console.warn('hero image failed:', (err as Error).message)
    }
  }

  list(header: string, items: string[]) {
    return this.run(async () => {
      const head = new TextContainerProperty({
        xPosition: 8,
        yPosition: 0,
        width: 560,
        height: 38,
        borderWidth: 0,
        paddingLength: 4,
        containerID: ID.head,
        containerName: NAME[ID.head],
        content: header,
        textColor: DIM,
        isEventCapture: 0,
      })
      const list = new ListContainerProperty({
        xPosition: 0,
        yPosition: 40,
        width: 576,
        height: 248,
        borderWidth: 0,
        paddingLength: 4,
        containerID: ID.list,
        containerName: NAME[ID.list],
        isEventCapture: 1,
        itemContainer: new ListItemContainerProperty({
          itemCount: Math.min(items.length, 20),
          itemWidth: 0,
          isItemSelectBorderEn: 1,
          itemName: items.slice(0, 20).map(i => i.slice(0, 63)),
        }),
      })
      await this.bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: 2, textObject: [head], listObject: [list] }))
      this.layout = 'list'
      this.texts = {}
      this.heroShown = ''
    })
  }

  mic(on: boolean) {
    return this.run(() => this.bridge.audioControl(on, AudioInputSource.Glasses))
  }

  exitDialog() {
    return this.run(async () => {
      await this.bridge.shutDownPageContainer(1)
    })
  }
}

const layoutKey = (c: Card) => `card|${c.hero ? 'hero' : 'wide'}|${c.boxed ? 'boxed' : ''}`

/**
 * Normalise SDK events into gestures.
 * - CLICK_EVENT is 0 and protobuf drops zero values, so a tap arrives with eventType undefined;
 *   resolve the default only inside an envelope that is present.
 * - Taps on text containers come as sysEvent; scrolls as textEvent; list taps as listEvent.
 * - Double tap is checked first, in every envelope.
 */
export function toGestures(event: EvenHubEvent): Gesture[] {
  const out: Gesture[] = []
  if (event.audioEvent?.audioPcm) out.push({ kind: 'audio', pcm: event.audioEvent.audioPcm })
  const typeOf = (env?: { eventType?: OsEventTypeList }) => (env ? env.eventType ?? OsEventTypeList.CLICK_EVENT : null)
  const sys = typeOf(event.sysEvent)
  const txt = typeOf(event.textEvent)
  const lst = typeOf(event.listEvent)

  if (sys === OsEventTypeList.DOUBLE_CLICK_EVENT || txt === OsEventTypeList.DOUBLE_CLICK_EVENT || lst === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    out.push({ kind: 'double' })
    return out
  }
  if (sys === OsEventTypeList.FOREGROUND_ENTER_EVENT) out.push({ kind: 'foreground', on: true })
  else if (sys === OsEventTypeList.FOREGROUND_EXIT_EVENT) out.push({ kind: 'foreground', on: false })
  else if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) out.push({ kind: 'exit' })
  else if (lst === OsEventTypeList.CLICK_EVENT) out.push({ kind: 'select', index: event.listEvent?.currentSelectItemIndex ?? 0 })
  else if (txt === OsEventTypeList.SCROLL_TOP_EVENT) out.push({ kind: 'up' })
  else if (txt === OsEventTypeList.SCROLL_BOTTOM_EVENT) out.push({ kind: 'down' })
  else if (sys === OsEventTypeList.CLICK_EVENT || txt === OsEventTypeList.CLICK_EVENT) out.push({ kind: 'tap' })
  return out
}
