import {
  AudioInputSource,
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'

/** What the controller needs from the glasses. Faked in tests. */
export interface Display {
  text(content: string): Promise<void>
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

// Container ids
const MAIN = { id: 1, name: 'main' }
const HEAD = { id: 2, name: 'head' }
const LIST = { id: 3, name: 'list' }

const textMain = (content: string) =>
  new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 8,
    containerID: MAIN.id,
    containerName: MAIN.name,
    content,
    isEventCapture: 1,
  })

/**
 * Bridge-backed display. Every bridge call goes through one promise chain:
 * the SDK docs warn that concurrent calls can break the BLE connection.
 * Text-to-text updates use the fast in-place upgrade; layout changes rebuild the page.
 */
export class GlassesDisplay implements Display {
  private queue: Promise<unknown> = Promise.resolve()
  private layout: 'text' | 'list' = 'text'
  private lastText = ''

  private constructor(private bridge: EvenAppBridge) {}

  static async create(bridge: EvenAppBridge, initial: string): Promise<GlassesDisplay> {
    const d = new GlassesDisplay(bridge)
    const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [textMain(initial)] }))
    if (r !== 0) {
      // The startup page can only be created once per session (e.g. the WebView reloaded), or the
      // host refused it. Draw our page with a rebuild instead of leaving the lens blank.
      console.warn('createStartUpPageContainer returned', r, '- rebuilding the page instead')
      const ok = await bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: 1, textObject: [textMain(initial)] })).catch(() => false)
      if (!ok) console.error('rebuildPageContainer also failed; the lens may stay blank until the next screen change')
    }
    d.lastText = initial
    return d
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(err => console.error('[display]', err))
    return next
  }

  text(content: string) {
    return this.run(async () => {
      if (this.layout === 'text') {
        if (content === this.lastText) return
        const ok = await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: MAIN.id, containerName: MAIN.name, content })).catch(() => false)
        // "container 1 not found": the page isn't there (lost or never created). Rebuild it.
        if (ok === false) await this.bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: 1, textObject: [textMain(content)] }))
      } else {
        await this.bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: 1, textObject: [textMain(content)] }))
        this.layout = 'text'
      }
      this.lastText = content
    })
  }

  list(header: string, items: string[]) {
    return this.run(async () => {
      const head = new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 40,
        borderWidth: 0,
        paddingLength: 6,
        containerID: HEAD.id,
        containerName: HEAD.name,
        content: header,
        isEventCapture: 0,
      })
      const list = new ListContainerProperty({
        xPosition: 0,
        yPosition: 44,
        width: 576,
        height: 244,
        borderWidth: 0,
        paddingLength: 4,
        containerID: LIST.id,
        containerName: LIST.name,
        isEventCapture: 1,
        itemContainer: new ListItemContainerProperty({
          itemCount: Math.min(items.length, 20),
          itemWidth: 0,
          isItemSelectBorderEn: 1,
          itemName: items.slice(0, 20).map(i => i.slice(0, 64)),
        }),
      })
      await this.bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: 2, textObject: [head], listObject: [list] }))
      this.layout = 'list'
      this.lastText = ''
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
