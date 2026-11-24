// Pure text builders for the 576×288 monochrome lens.
// Rules: one idea per card, ≤ 5 short lines (~32 chars), plain ASCII only:
// characters missing from the firmware font are silently skipped (verified in the
// simulator: "✓" does not render).

export interface TillSnapshot {
  seller: { name: string; address: string; network: 'testnet' | 'mainnet' }
  today: { total: string; paid: number; unmatched: number; waiting: number }
  waiting: WaitingOrder[]
  recent: { amount: string; result: string; label: string | null; comment: string | null; agoMin: number }[]
}

export interface WaitingOrder {
  id: number
  code: string
  label: string
  item: string | null
  amount: string
  status: string
  agoMin: number
  expired: boolean
}

export interface Confirm {
  id: string
  kind: 'charge' | 'cancel'
  label: string
  amount: string
  item: string | null
  reachable: boolean
  expiresInSec: number
}

export interface PaymentEvent {
  result: 'paid' | 'underpaid' | 'already_paid' | 'cancelled_order' | 'unmatched'
  amount: string
  label: string | null
  code: string | null
  item: string | null
  late: boolean
  comment: string | null
}

/** Fit a line to n chars, cutting at a word boundary (no ellipsis glyph: it may not be in the font). */
export const clip = (s: string, n: number) => {
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  const sp = cut.lastIndexOf(' ')
  return (sp > n / 2 ? cut.slice(0, sp) : cut).replace(/[\s,.;:(-]+$/, '')
}
const ago = (m: number) => (m < 1 ? 'now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`)

// ---------- lens cards ----------
//
// One layout for every screen, built for a glance:
//
//   +-------------------------------------------------------------+
//   | SHOP NAME (dim)                      STATE (dim)            |  status bar
//   | +-----------------------+   Title (brightest)               |
//   | | KICKER                |   detail line (medium)            |  hero image (big type,
//   | |   +15  GRAM           |   detail line (medium)            |  drawn as a picture) +
//   | +-----------------------+                                   |  text column
//   | TAP  send        2x TAP  cancel (dim)                       |  hint row
//   +-------------------------------------------------------------+
//
// Text stays plain ASCII (the lens font drops other glyphs); icons and big numbers
// live in the hero image, where anything can be drawn.

export type HeroIcon = 'check' | 'warn' | 'mic' | 'dots' | 'link' | 'coin' | 'cross'

export interface Hero {
  icon?: HeroIcon
  kicker?: string // small caps line above the number
  big?: string // the number / word, drawn large
  unit?: string // e.g. GRAM
  level?: number // 0..1, live mic level bar (listening)
}

export interface Card {
  status: [string, string] // left (shop), right (state)
  hero?: Hero
  title?: string // brightest line of the text column
  lines?: string[] // detail lines
  hint?: string // bottom row, dim
  boxed?: boolean // outline the text column (decisions and takeovers)
}

const SHOP = 26 // chars that fit the status bar's left box
const COL = 24 // chars per line in the text column next to the hero

const shop = (s: TillSnapshot | null | undefined) => clip((s?.seller.name ?? 'Gram Till').toUpperCase(), SHOP)
const net = (s: TillSnapshot | null | undefined) => (s?.seller.network === 'mainnet' ? '' : 'TESTNET  ')

/** Plain-text rendering of a card (companion log, tests, and a fallback if images fail). */
export function cardText(c: Card): string {
  const h = c.hero
  const heroLine = h ? [h.kicker, [h.big, h.unit].filter(Boolean).join(' ')].filter(Boolean).join('  ') : ''
  return [c.status.filter(Boolean).join('  |  '), heroLine, c.title ?? '', ...(c.lines ?? []), c.hint ?? ''].filter(Boolean).join('\n')
}

export function tillCard(s: TillSnapshot): Card {
  const last = s.recent.find(r => r.result === 'paid')
  return {
    status: [shop(s), `${net(s)}LIVE`],
    hero: { icon: 'coin', kicker: 'TODAY', big: s.today.total, unit: 'GRAM' },
    title: `${s.today.paid} paid`,
    lines: [
      s.today.waiting ? `${s.today.waiting} waiting` : 'Nothing waiting',
      last ? clip(`Last: ${last.label ?? 'Walk-in'} +${last.amount}`, COL) : 'No payments yet',
      last ? ago(last.agoMin) : '',
    ].filter(Boolean),
    hint: 'TAP  charge          SWIPE  menu',
  }
}

export function paymentCard(p: PaymentEvent, s?: TillSnapshot | null): Card {
  const who = clip(p.label ?? 'Walk-in', COL)
  const status: [string, string] = [shop(s), 'PAYMENT']
  switch (p.result) {
    case 'paid':
      return {
        status,
        hero: { icon: 'check', kicker: 'PAID', big: `+${p.amount}`, unit: 'GRAM' },
        title: who,
        lines: [p.item ? clip(p.item, COL) : '', p.code ?? '', p.late ? 'paid after expiry' : ''].filter(Boolean),
        hint: 'Receipt sent in Telegram',
        boxed: true,
      }
    case 'underpaid':
      return {
        status,
        hero: { icon: 'warn', kicker: 'SHORT', big: `+${p.amount}`, unit: 'GRAM' },
        title: who,
        lines: ['Paid too little', 'Order still waiting', p.code ?? ''].filter(Boolean),
        hint: 'They can top up from the same link',
        boxed: true,
      }
    case 'already_paid':
      return { status, hero: { icon: 'warn', kicker: 'EXTRA', big: `+${p.amount}`, unit: 'GRAM' }, title: who, lines: ['Already paid before', 'Details in Telegram'], hint: 'Refund from your wallet if needed', boxed: true }
    case 'cancelled_order':
      return { status, hero: { icon: 'warn', kicker: 'CANCELLED', big: `+${p.amount}`, unit: 'GRAM' }, title: who, lines: ['Paid a cancelled order', 'Details in Telegram'], hint: 'Refund from your wallet if needed', boxed: true }
    default:
      return {
        status,
        hero: { icon: 'coin', kicker: 'MONEY IN', big: `+${p.amount}`, unit: 'GRAM' },
        title: 'No order code',
        lines: p.comment ? [clip(`"${p.comment}"`, COL)] : ['Details in Telegram'],
        hint: 'Not counted as an order',
        boxed: true,
      }
  }
}

export function confirmCard(c: Confirm, s?: TillSnapshot | null, secondsLeft?: number): Card {
  const left = secondsLeft !== undefined ? `   ${Math.max(0, secondsLeft)}s` : ''
  if (c.kind === 'cancel') {
    return {
      status: [shop(s), 'CONFIRM'],
      hero: { icon: 'cross', kicker: 'CANCEL ORDER', big: c.amount, unit: 'GRAM' },
      title: clip(c.label, COL),
      lines: [c.item ? clip(c.item, COL) : ''].filter(Boolean),
      hint: `TAP  cancel it        2x TAP  keep${left}`,
      boxed: true,
    }
  }
  return {
    status: [shop(s), 'CONFIRM'],
    hero: { kicker: 'CHARGE', big: c.amount, unit: 'GRAM' },
    title: clip(c.label, COL),
    lines: [c.item ? clip(c.item, COL) : '', c.reachable ? 'Goes to their Telegram' : 'Show your counter QR'].filter(Boolean),
    hint: `TAP  send        2x TAP  cancel${left}`,
    boxed: true,
  }
}

/** A 0..1 level as a text meter: [#######.....] */
export const meter = (level: number, n = 14) => {
  const k = Math.round(Math.max(0, Math.min(1, level)) * n)
  return '[' + '#'.repeat(k) + '.'.repeat(n - k) + ']'
}

export function listeningCard(seconds: number, s?: TillSnapshot | null, level = 0, heard = false): Card {
  return {
    status: [shop(s), 'LISTENING'],
    hero: { icon: 'mic', kicker: heard ? 'GOT IT' : 'SPEAK NOW', level },
    title: 'One charge, e.g.',
    lines: ['"Charge Maria five"', '"Table 4, two lattes"'],
    hint: `${meter(level)}   pause to send   ${seconds}s`,
  }
}

export const thinkingCard = (transcript?: string, s?: TillSnapshot | null): Card => ({
  status: [shop(s), 'WORKING'],
  hero: { icon: 'dots', kicker: 'ONE SEC' },
  title: 'Heard',
  lines: transcript ? wrap(`"${transcript}"`, COL, 3) : ['...'],
})

/** Results and problems. Success gets a check; anything that needs another try gets a warning. */
export function messageCard(text: string, examples?: string[], s?: TillSnapshot | null): Card {
  const ex = (examples ?? []).slice(0, 2).map(e => clip(e, COL))
  const deliberate = /^(not sent|cancelled)/i.test(text) // the seller chose this: neutral, not an error
  const problem = !deliberate && (!!examples?.length || /\b(not|no|didn'?t|can'?t|couldn'?t|fail|failed|expired|timed out|unknown|error|say the|try)\b/i.test(text))
  return {
    status: [shop(s), problem ? 'TRY AGAIN' : 'DONE'],
    hero: problem ? { icon: 'warn', kicker: 'HMM' } : deliberate ? { icon: 'cross', kicker: 'OK' } : { icon: 'check', kicker: /^sent/i.test(text) ? 'SENT' : 'DONE' },
    title: wrap(text, COL, 3).join('\n'),
    lines: ex.length ? ['Try:', ...ex] : [],
  }
}

export const unpairedCard = (): Card => ({
  status: ['GRAM TILL', 'NOT CONNECTED'],
  hero: { icon: 'link', kicker: 'PAIR', big: '/pair' },
  title: 'Connect your till',
  lines: ['In Telegram: /pair', 'Enter the code in', 'Gram Till on your phone'],
})

export const offlineCard = (s?: TillSnapshot | null): Card => ({
  status: [shop(s), 'OFFLINE'],
  hero: { icon: 'dots', kicker: 'RECONNECTING' },
  title: 'Back in a moment',
  lines: ['Payments are still', 'recorded and sent', 'to your Telegram'],
})

/** Wrap text into up to `max` lines of `n` chars. */
export function wrap(text: string, n: number, max: number): string[] {
  const out: string[] = []
  let line = ''
  for (const w of text.split(/\s+/)) {
    if ((line + ' ' + w).trim().length > n) {
      if (line) out.push(line)
      line = w.slice(0, n)
    } else line = (line + ' ' + w).trim()
    if (out.length === max) break
  }
  if (line && out.length < max) out.push(line)
  return out
}

// ---------- list screens (itemName max 64 chars, max 20 items) ----------

export function menuItems(s: TillSnapshot | null, lastCharge: string | null): string[] {
  return [
    'Speak a charge',
    lastCharge ? clip(`Repeat: ${lastCharge}`, 40) : 'Repeat last charge',
    `Waiting orders (${s?.today.waiting ?? 0})`,
    'Remind all waiting',
    `Today: ${s?.today.total ?? '0'} GRAM`,
    'Back',
  ]
}

export function waitingItems(s: TillSnapshot): string[] {
  if (!s.waiting.length) return ['Nothing waiting', 'Back']
  return [
    ...s.waiting.slice(0, 18).map(o => clip(`${o.label}  ${o.amount} GRAM  ${o.expired ? 'expired' : ago(o.agoMin)}`, 40)),
    'Back',
  ]
}

export const orderActionItems = (o: WaitingOrder) => [clip(`Remind ${o.label}`, 40), 'Cancel this order', 'Back']
