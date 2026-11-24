// Deterministic voice grammar for the till. No LLM: for money, a fixed grammar is
// predictable, explainable, and never invents an amount. Anything it can't parse
// becomes { kind: 'unknown' } and nothing is sent.
//
//   charge [<name> | table <n>] <amount> [for [<qty>] <item>]
//   charge [<qty>] <item>                 (amount from the seller's menu)
//   repeat | remind [<name> | all] | cancel [last | <name>] | total | today

export type Command =
  | { kind: 'charge'; label: string | null; amount: number | null; item: string | null; qty: number }
  | { kind: 'repeat' }
  | { kind: 'remind'; target: string | 'all' | null }
  | { kind: 'cancel'; target: string | 'last' }
  | { kind: 'total' }
  | { kind: 'unknown'; text: string; reason?: 'fiat' }

export interface VoiceContext {
  menu: string[] // seller's menu item names, lowercase
  customers: string[] // known customer names
}

const UNITS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, a: 1, two: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
const FILLER = new Set([',', 'please', 'gram', 'grams', 'grm', 'gm', 'ton', 'tons', 'toncoin', 'to', 'the', 'him', 'her', 'them', 'and', 'now', 'just', 'okay', 'ok', 'uh', 'um', 'of',
  // articles/particles in the languages the typed aliases cover
  'el', 'la', 'los', 'las', 'le', 'les', 'l', 'der', 'die', 'das', 'den', 'dem', 'il', 'lo', 'gli', 'o', 'os', 'as',
  'de', 'del', 'du', 'des', 'da', 'do', 'het', 'al', 'au', 'aux', 'zum', 'zur', 'ke', 'di', 'pada'])
const VERB_ALIASES: Record<string, string> = {
  charge: 'charge', bill: 'charge', request: 'charge', invoice: 'charge', collect: 'charge',
  repeat: 'repeat', again: 'repeat', remind: 'remind', nudge: 'remind', cancel: 'cancel', void: 'cancel',
  total: 'total', today: 'total', summary: 'total',
}

/**
 * Amounts are in GRAM. If someone says a fiat currency we refuse instead of
 * silently charging "12 GRAM" for "12 dollars". (Words, plus symbols mapped in tokenize.)
 */
const FIAT = new Set([
  'dollar', 'dollars', 'buck', 'bucks', 'usd', 'euro', 'euros', 'eur', 'pound', 'pounds', 'quid', 'gbp',
  'naira', 'ngn', 'cedi', 'cedis', 'shilling', 'shillings', 'rand', 'lira', 'liras', 'reais', 'rupee', 'rupees',
  'peso', 'pesos', 'yen', 'yuan', 'rmb', 'dirham', 'dirhams', 'riyal', 'riyals', 'rupiah', 'ringgit', 'baht', 'dong',
  'franc', 'francs', 'hryvnia', 'ruble', 'rubles', 'roubles', 'zloty', 'kroner', 'krona', 'usdt', 'usdc', 'dolares', 'dolar',
])

/**
 * Typed commands in other languages: map common verbs and connector words to the
 * English grammar. (Spoken commands in other languages go through Whisper's
 * translation to English first; see understandSpeech in stt.ts.)
 * Keys are accent-free because tokenize strips diacritics.
 */
const ALIASES: Record<string, string> = {
  // charge
  cobra: 'charge', cobrar: 'charge', cobre: 'charge', cobrale: 'charge', factura: 'charge', facture: 'charge',
  encaisse: 'charge', encaisser: 'charge', berechne: 'charge', kassiere: 'charge', kassieren: 'charge', addebita: 'charge', incassa: 'charge',
  tagih: 'charge', tagihkan: 'charge', tahsil: 'charge', reken: 'charge', afrekenen: 'charge', cobrem: 'charge',
  // remind
  recuerda: 'remind', recordar: 'remind', recordale: 'remind', lembra: 'remind', lembrar: 'remind', lembre: 'remind', rappelle: 'remind', relance: 'remind',
  erinnere: 'remind', erinnern: 'remind', ricorda: 'remind', sollecita: 'remind', hatirlat: 'remind', ingatkan: 'remind', herinner: 'remind',
  // cancel
  cancela: 'cancel', cancelar: 'cancel', cancele: 'cancel', anula: 'cancel', anular: 'cancel', annule: 'cancel', annuler: 'cancel',
  storniere: 'cancel', stornieren: 'cancel', storno: 'cancel', annulla: 'cancel', iptal: 'cancel', batal: 'cancel', batalkan: 'cancel', annuleer: 'cancel',
  // repeat
  repite: 'repeat', repetir: 'repeat', repete: 'repeat', wiederhole: 'repeat', nochmal: 'repeat', ripeti: 'repeat', tekrar: 'repeat', ulangi: 'repeat', herhaal: 'repeat',
  // total / today
  hoy: 'today', hoje: 'today', "aujourd'hui": 'today', heute: 'today', oggi: 'today', bugun: 'today', vandaag: 'today', totale: 'total', gesamt: 'total',
  toplam: 'total', jumlah: 'total', totaal: 'total',
  // table
  mesa: 'table', tisch: 'table', tavolo: 'table', masa: 'table', meja: 'table', tafel: 'table',
  // for
  para: 'for', pour: 'for', fur: 'for', icin: 'for', untuk: 'for', voor: 'for',
  // all / last
  todos: 'all', todas: 'all', tous: 'all', toutes: 'all', alle: 'all', tutti: 'all', hepsi: 'all', semua: 'all',
  ultimo: 'last', ultima: 'last', dernier: 'last', derniere: 'last', letzte: 'last', letzten: 'last', terakhir: 'last', laatste: 'last',
  // small numbers (quantities like "dos lattes")
  uno: 'one', una: 'one', uma: 'one', un: 'one', une: 'one', ein: 'one', eine: 'one', bir: 'one', satu: 'one', een: 'one',
  dos: 'two', dois: 'two', duas: 'two', deux: 'two', zwei: 'two', iki: 'two', dua: 'two', twee: 'two',
  tres: 'three', trois: 'three', drei: 'three', tre: 'three', uc: 'three', tiga: 'three', drie: 'three',
  cuatro: 'four', quatro: 'four', quatre: 'four', vier: 'four', quattro: 'four', dort: 'four', empat: 'four',
  cinco: 'five', cinq: 'five', funf: 'five', cinque: 'five', bes: 'five', vijf: 'five',
}

/** Strip accents so "último" == "ultimo" and "José" ~ "Jose". */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '')

/**
 * Rewrite spelled-out numbers into digits: "twenty five" -> "25",
 * "twelve point five" -> "12.5", "one hundred and fifty" -> "150".
 * "a"/"for" only count as numbers where a number is expected (handled by caller).
 */
export function wordsToNumbers(tokens: string[]): string[] {
  const out: string[] = []
  let i = 0
  const isNumWord = (t: string) => t in UNITS || t in TENS || t === 'hundred' || t === 'thousand'
  while (i < tokens.length) {
    const t = tokens[i]
    // Leave "a"/"for" as words here; they are only numbers in narrow contexts.
    if (!isNumWord(t) || t === 'a' || t === 'for' || t === 'oh') {
      out.push(t)
      i++
      continue
    }
    // Grammar of one number: [units|teens|tens [units]] [hundred [and] ...] [thousand ...].
    // Two separate numbers said back-to-back ("table four twelve") must NOT merge into 16.
    let total = 0
    let current = 0
    let last: 'none' | 'unit' | 'teen' | 'tens' | 'hundred' | 'thousand' = 'none'
    while (i < tokens.length) {
      const w = tokens[i]
      const afterScale = last === 'none' || last === 'hundred' || last === 'thousand'
      if (w in UNITS && w !== 'a' && w !== 'for' && w !== 'oh') {
        const v = UNITS[w]
        if (v < 10 && (afterScale || last === 'tens')) { current += v; last = 'unit' }
        else if (v >= 10 && afterScale) { current += v; last = 'teen' }
        else break
      } else if (w in TENS) {
        if (!afterScale) break
        current += TENS[w]
        last = 'tens'
      } else if (w === 'hundred') {
        if (last === 'hundred' || last === 'thousand') break
        current = (current || 1) * 100
        last = 'hundred'
      } else if (w === 'thousand') {
        if (last === 'thousand') break
        total += (current || 1) * 1000
        current = 0
        last = 'thousand'
      } else if (w === 'and' && (last === 'hundred' || last === 'thousand') && i + 1 < tokens.length && isNumWord(tokens[i + 1]) && tokens[i + 1] !== 'a' && tokens[i + 1] !== 'for') {
        // "one hundred and fifty"
      } else break
      i++
    }
    let value = String(total + current)
    // Spoken prices: "twelve fifty" = 12.50, "four ninety nine" = 4.99. Only for a plain
    // 1-99 number followed directly by a tens word, and never right after "table".
    const prevTok = out[out.length - 1]
    if (total === 0 && current > 0 && current < 100 && last !== 'hundred' && tokens[i] in TENS && prevTok !== 'table') {
      let cents = TENS[tokens[i]]
      let j = i + 1
      if (tokens[j] in UNITS && UNITS[tokens[j]] > 0 && UNITS[tokens[j]] < 10 && tokens[j] !== 'a' && tokens[j] !== 'for') {
        cents += UNITS[tokens[j]]
        j++
      }
      value = `${current}.${String(cents).padStart(2, '0')}`
      i = j
      out.push(value)
      continue
    }
    // decimals: "point five" / "point two five"
    if (tokens[i] === 'point' && i + 1 < tokens.length) {
      let digits = ''
      let j = i + 1
      while (j < tokens.length && (/^\d$/.test(tokens[j]) || (tokens[j] in UNITS && UNITS[tokens[j]] < 10 && tokens[j] !== 'a' && tokens[j] !== 'for'))) {
        digits += /^\d$/.test(tokens[j]) ? tokens[j] : String(UNITS[tokens[j]])
        j++
      }
      if (digits) {
        value += '.' + digits
        i = j
      }
    }
    out.push(value)
  }
  // digit then "point" then digits ("12 point 5")
  const merged: string[] = []
  for (let k = 0; k < out.length; k++) {
    if (out[k] === 'point' && merged.length && isNum(merged[merged.length - 1]) && k + 1 < out.length && /^\d+$/.test(out[k + 1])) {
      merged[merged.length - 1] += '.' + out[k + 1]
      k++
    } else merged.push(out[k])
  }
  return merged
}

const isNum = (t: string) => /^\d+(\.\d+)?$/.test(t)

export function tokenize(text: string): string[] {
  return fold(text.toLowerCase())
    .replace(/\$|us\$/g, ' dollar ')
    .replace(/€/g, ' euro ')
    .replace(/£/g, ' pound ')
    .replace(/₦/g, ' naira ')
    .replace(/[¥₹₺₽₩฿]/g, ' yen ') // any other currency symbol: refuse like fiat
    .replace(/(\d),(\d{3})(?!\d)/g, '$1$2') // 1,000 -> 1000
    .replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2') // 12,50 -> 12.50 (decimal comma)
    .replace(/,/g, ' , ') // a comma separates numbers: "table four, twelve"
    .replace(/[^\p{L}\p{N}.,\s'-]/gu, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ') // keep decimal points only
    .split(/\s+/)
    .filter(Boolean)
    .map(t => ALIASES[t] ?? t)
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

/** Best fuzzy match for a spoken phrase among known names (STT often misspells names). */
export function fuzzyPick(phrase: string, options: string[]): string | null {
  const p = fold(phrase.toLowerCase().trim())
  if (!p) return null
  let best: { opt: string; score: number } | null = null
  for (const opt of options) {
    const o = fold(opt.toLowerCase())
    if (o === p) return opt
    const d = levenshtein(p, o)
    const tolerance = o.length <= 4 ? 1 : 2
    const score = o.startsWith(p) || p.startsWith(o) ? 0.5 : d
    if (score <= tolerance && (!best || score < best.score)) best = { opt, score }
  }
  return best?.opt ?? null
}

const titleCase = (s: string) => s.replace(/(^|\s)(\p{L})/gu, (_, sp, c) => sp + c.toUpperCase())

export function parseCommand(text: string, ctx: VoiceContext): Command {
  const raw = tokenize(text)
  const verbIdx = raw.findIndex(t => t in VERB_ALIASES)
  if (verbIdx === -1) return { kind: 'unknown', text }
  const verb = VERB_ALIASES[raw[verbIdx]]
  if (verb === 'charge') {
    const menuWords = new Set(ctx.menu.flatMap(m => tokenize(m)))
    if (raw.some(t => FIAT.has(t) && !menuWords.has(t))) return { kind: 'unknown', text, reason: 'fiat' }
  }
  let rest = wordsToNumbers(raw.slice(verbIdx + 1))

  if (verb === 'total') return { kind: 'total' }
  if (verb === 'repeat') return { kind: 'repeat' }

  if (verb === 'remind') {
    const words = rest.filter(t => !FILLER.has(t))
    if (!words.length) return { kind: 'remind', target: null }
    if (words.includes('all') || words.includes('everyone') || words.includes('everybody')) return { kind: 'remind', target: 'all' }
    return { kind: 'remind', target: resolveLabel(words, ctx) }
  }

  if (verb === 'cancel') {
    const words = rest.filter(t => !FILLER.has(t) && t !== 'order')
    if (!words.length || words[0] === 'last' || words[0] === 'that' || words[0] === 'it') return { kind: 'cancel', target: 'last' }
    return { kind: 'cancel', target: resolveLabel(words, ctx) }
  }

  // ---- charge ----
  // Speech-to-text homophones for numbers. Only where a number is the only sensible reading:
  // right after "table" ("table for two lattes" = table 4), and a final "too"/"to" ("charge Abiola too").
  const HOMOPHONE: Record<string, string> = { for: '4', fore: '4', to: '2', too: '2', tree: '3', free: '3', ate: '8', won: '1' }
  rest = rest.map((t, i) => (i > 0 && (rest[i - 1] === 'table' || rest[i - 1] === 'tables') && HOMOPHONE[t] ? HOMOPHONE[t] : t))
  if (rest.length > 1 && (rest[rest.length - 1] === 'too' || rest[rest.length - 1] === 'to') && !rest.some(isNum)) rest = [...rest.slice(0, -1), '2']

  // Split off "for <qty?> <item>" suffix.
  let item: string | null = null
  let qty = 1
  const forIdx = rest.lastIndexOf('for')
  if (forIdx !== -1 && forIdx < rest.length - 1) {
    let itemWords = rest.slice(forIdx + 1).filter(t => !FILLER.has(t))
    if (itemWords.length && (isNum(itemWords[0]) || itemWords[0] === 'a')) {
      qty = itemWords[0] === 'a' ? 1 : Math.max(1, Math.round(Number(itemWords[0])))
      itemWords = itemWords.slice(1)
    }
    if (itemWords.length) {
      item = fuzzyPick(itemWords.join(' '), ctx.menu) ?? itemWords.join(' ')
      rest = rest.slice(0, forIdx)
    }
  }

  // "table <n>" label
  let label: string | null = null
  const tableIdx = rest.findIndex(t => t === 'table' || t === 'tables')
  if (tableIdx !== -1) {
    const n = rest[tableIdx + 1]
    const num = n
    if (num && /^\d+$/.test(num)) {
      label = `Table ${num}`
      rest = [...rest.slice(0, tableIdx), ...rest.slice(tableIdx + 2)]
    }
  }

  // Amount = last number left; words before it are the name (or a menu item).
  const words = rest.filter(t => !FILLER.has(t))
  let amount: number | null = null
  const lastNum = [...words].reverse().find(isNum)
  let nameWords = words
  if (lastNum !== undefined) {
    const idx = words.lastIndexOf(lastNum)
    amount = Number(lastNum)
    nameWords = words.slice(0, idx).concat(words.slice(idx + 1)).filter(t => !isNum(t))
  }

  if (!item && nameWords.length > 1) {
    // "charge Bisi two zobo": a menu item at the end of the phrase, with the number just before it as quantity.
    for (let k = nameWords.length - 1; k >= 1; k--) {
      const suffix = nameWords.slice(-k).join(' ')
      const asItem = ctx.menu.find(m => m === suffix) ?? fuzzyPick(suffix, ctx.menu)
      if (!asItem) continue
      const itemStart = words.indexOf(nameWords[nameWords.length - k])
      const numIdx = lastNum !== undefined ? words.lastIndexOf(lastNum) : -1
      if (numIdx === itemStart - 1 && amount !== null && Number.isInteger(amount) && amount <= 20) {
        qty = amount
        amount = null
      }
      item = asItem
      nameWords = nameWords.slice(0, -k)
      break
    }
  }

  if (!item && nameWords.length) {
    // "charge jollof" / "charge two jollof": the "name" is really a menu item.
    const asItem = fuzzyPick(nameWords.join(' '), ctx.menu)
    if (asItem && !fuzzyPick(nameWords.join(' '), ctx.customers)) {
      item = asItem
      if (amount !== null && Number.isInteger(amount) && amount <= 20 && words.indexOf(String(amount)) < words.indexOf(nameWords[0])) {
        qty = amount // "two jollof" -> qty 2, price from menu
        amount = null
      }
      nameWords = []
    }
  }

  if (!label && nameWords.length) label = resolveLabel(nameWords, ctx)
  if (amount === null && !item) return { kind: 'unknown', text }
  if (amount !== null && (!(amount > 0) || amount > 1_000_000)) return { kind: 'unknown', text }
  return { kind: 'charge', label, amount, item, qty }
}

function resolveLabel(words: string[], ctx: VoiceContext): string {
  const phrase = words.join(' ')
  return fuzzyPick(phrase, ctx.customers) ?? titleCase(phrase)
}

/**
 * For non-English speech we parse Whisper's English translation, but translation can
 * mangle names and the seller's own menu words ("café com leite" -> "coffee with milk").
 * Re-resolve the customer and menu item against what was actually said.
 */
export function reconcileWithOriginal(cmd: Command, original: string, ctx: VoiceContext): Command {
  if (cmd.kind !== 'charge' && cmd.kind !== 'remind' && cmd.kind !== 'cancel') return cmd
  const toks = tokenize(original).filter(t => t !== ',')
  const grams = (n: number) => toks.slice(0, Math.max(0, toks.length - n + 1)).map((_, i) => toks.slice(i, i + n).join(' '))
  const findIn = (options: string[]) => {
    for (const n of [3, 2, 1]) for (const g of grams(n)) {
      const exact = options.find(o => fold(o.toLowerCase()) === g)
      if (exact) return exact
    }
    for (const n of [3, 2, 1]) for (const g of grams(n)) {
      if (g.length < 3) continue
      const hit = fuzzyPick(g, options)
      if (hit) return hit
    }
    return null
  }
  const known = (x: string | null) => !!x && ctx.customers.some(c => c.toLowerCase() === x.toLowerCase())
  if (cmd.kind === 'charge') {
    const out = { ...cmd }
    if (!known(out.label) && !(out.label ?? '').startsWith('Table ')) out.label = findIn(ctx.customers) ?? out.label
    if (!out.item || !ctx.menu.includes(out.item)) {
      const recovered = findIn(ctx.menu)
      if (recovered) {
        out.item = recovered
        // "dois café com leite" -> translation "two coffees with milk" was parsed as amount 2.
        // If that number sits right before the item in the original words, it's a quantity.
        const nums = wordsToNumbers(toks)
        const first = tokenize(recovered)[0]
        const at = nums.findIndex(t => fold(t) === first || fuzzyPick(t, [first]) !== null)
        if (out.amount !== null && Number.isInteger(out.amount) && out.amount <= 20 && at > 0 && nums[at - 1] === String(out.amount)) {
          out.qty = out.amount
          out.amount = null
        }
        // The translated label may have absorbed the item words ("John Coffees With Milk").
        if (out.label && !known(out.label) && !out.label.startsWith('Table ')) out.label = null
      }
    }
    return out
  }
  if (typeof cmd.target === 'string' && cmd.target !== 'all' && cmd.target !== 'last' && !known(cmd.target)) {
    return { ...cmd, target: findIn(ctx.customers) ?? cmd.target } as Command
  }
  return cmd
}

/** Example phrases shown on the lens when a command isn't understood. */
export const EXAMPLES = ['"Charge Maria twelve"', '"Charge table four, two lattes"', '"Remind all"']
