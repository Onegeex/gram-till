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
const clip = (s: string, n: number) => {
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  const sp = cut.lastIndexOf(' ')
  return (sp > n / 2 ? cut.slice(0, sp) : cut).replace(/[\s,.;:(-]+$/, '')
}
const ago = (m: number) => (m < 1 ? 'now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`)

export function tillCard(s: TillSnapshot): string {
  const last = s.recent.find(r => r.result === 'paid')
  const lines = [
    clip(`GRAM TILL${s.seller.network === 'testnet' ? ' (test)' : ''}  ${s.seller.name}`, 34),
    `TODAY  ${s.today.total} GRAM`,
    `${s.today.paid} paid  |  ${s.today.waiting} waiting`,
    last ? clip(`Last: ${last.label ?? 'Walk-in'} +${last.amount}  ${ago(last.agoMin)}`, 34) : 'No payments yet today',
    'tap: speak  |  swipe: menu',
  ]
  return lines.join('\n')
}

export function paymentCard(p: PaymentEvent): string {
  switch (p.result) {
    case 'paid':
      return [`PAID`, `+${p.amount} GRAM`, clip(`${p.label ?? 'Walk-in'}  ${p.code ?? ''}`, 34), p.item ? clip(p.item, 34) : '', p.late ? '(paid after expiry)' : '']
        .filter(Boolean)
        .join('\n')
    case 'underpaid':
      return ['SHORT PAYMENT', `+${p.amount} GRAM only`, clip(`${p.label ?? ''}  ${p.code ?? ''}`, 34), 'Order still waiting']
        .join('\n')
    case 'already_paid':
      return ['EXTRA PAYMENT', `+${p.amount} GRAM`, clip(`${p.label ?? ''} already paid`, 34), 'Details in Telegram'].join('\n')
    case 'cancelled_order':
      return ['PAID A CANCELLED ORDER', `+${p.amount} GRAM`, clip(`${p.label ?? ''}  ${p.code ?? ''}`, 34), 'Details in Telegram'].join('\n')
    default:
      return ['MONEY IN', `+${p.amount} GRAM`, 'No order code', p.comment ? clip(`"${p.comment}"`, 34) : 'Details in Telegram'].join('\n')
  }
}

export function confirmCard(c: Confirm): string {
  if (c.kind === 'cancel') {
    return ['CANCEL ORDER?', clip(`${c.label}  ${c.amount} GRAM`, 34), c.item ? clip(c.item, 34) : '', '', 'tap = cancel it  |  2x tap = keep'].join('\n')
  }
  return [
    clip(`CHARGE ${c.label}`, 34),
    `${c.amount} GRAM`,
    c.item ? clip(c.item, 34) : '',
    c.reachable ? '-> sends in their Telegram' : '-> show your counter QR',
    'tap = SEND  |  2x tap = cancel',
  ].join('\n')
}

export function listeningCard(seconds: number): string {
  return ['LISTENING...', 'e.g. "Charge Maria twelve"', '"Charge table 4, two lattes"', '', `just pause when done  |  ${seconds}s`].join('\n')
}

export const thinkingCard = (transcript?: string) =>
  ['...', transcript ? clip(`"${transcript}"`, 34) : 'Working on it'].join('\n')

export function messageCard(text: string, examples?: string[]): string {
  const ex = (examples ?? []).slice(0, 2).map(e => clip(e, 34))
  return [clip(text, 34), ...(ex.length ? ['Try:', ...ex] : [])].join('\n')
}

export const unpairedCard = () =>
  ['GRAM TILL', 'Not connected yet.', 'In Telegram, send /pair to', 'the bot, then enter the code', 'in Gram Till on your phone.'].join('\n')

export const offlineCard = (name?: string) =>
  ['GRAM TILL' + (name ? `  ${name}` : ''), 'Reconnecting...', 'Payments are still recorded', 'and sent to your Telegram.'].join('\n')

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
