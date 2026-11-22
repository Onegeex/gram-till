// GRAM (formerly Toncoin) has 9 decimals. All amounts are handled as bigint nanograms
// so we never compare floats when matching a payment to an order.

export const NANO = 1_000_000_000n

/** "12", "12.5", "0.1" -> nanograms. Throws on anything else. */
export function toNano(amount: string | number): bigint {
  const s = typeof amount === 'number' ? amount.toString() : amount.trim()
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error(`Invalid amount: ${amount}`)
  const [whole, frac = ''] = s.split('.')
  return BigInt(whole) * NANO + BigInt(frac.padEnd(9, '0'))
}

/** nanograms -> short human string: 15000000000n -> "15", 12500000000n -> "12.5" */
export function fromNano(nano: bigint | string): string {
  const n = typeof nano === 'string' ? BigInt(nano) : nano
  const whole = n / NANO
  // Display precision: 2 decimals, trailing zeros trimmed (enough for a till).
  const frac = (n % NANO).toString().padStart(9, '0').slice(0, 2).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

// Order codes go into the transfer comment. Short, unambiguous, easy to read aloud.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O/1/I/L

export function newOrderCode(rand: () => number = Math.random): string {
  let s = ''
  for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)]
  return `GT-${s}`
}

/** Find an order code anywhere in a free-text comment ("thanks! gt-7f3k" -> "GT-7F3K"). */
export function extractOrderCode(comment: string | null | undefined): string | null {
  if (!comment) return null
  const m = comment.toUpperCase().match(/GT-[A-Z0-9]{4}/)
  return m ? m[0] : null
}
