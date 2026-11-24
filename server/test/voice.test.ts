import { describe, expect, it } from 'vitest'
import { parseCommand, wordsToNumbers, fuzzyPick, reconcileWithOriginal } from '../src/voice.js'

const ctx = { menu: ['jollof', 'fried rice', 'suya', 'zobo'], customers: ['Tunde', 'Bisi Adeyemi', 'Chidi'] }
const p = (t: string) => parseCommand(t, ctx)

describe('wordsToNumbers', () => {
  it.each([
    ['twenty five', '25'],
    ['one hundred and fifty', '150'],
    ['two thousand five hundred', '2500'],
    ['twelve point five', '12.5'],
    ['0 point 5', '0.5'],
    ['four twelve', '4 12'],
    ['fifteen', '15'],
  ])('%s -> %s', (input, out) => {
    expect(wordsToNumbers(input.split(' ')).join(' ')).toBe(out)
  })
})

describe('parseCommand: charge', () => {
  it('name + spoken amount', () => {
    expect(p('Charge Tunde fifteen')).toEqual({ kind: 'charge', label: 'Tunde', amount: 15, item: null, qty: 1 })
  })
  it('digits from STT, trailing punctuation', () => {
    expect(p('Charge Tunde 15.')).toEqual({ kind: 'charge', label: 'Tunde', amount: 15, item: null, qty: 1 })
  })
  it('table + amount + item', () => {
    expect(p('Charge table four, twelve for jollof')).toEqual({ kind: 'charge', label: 'Table 4', amount: 12, item: 'jollof', qty: 1 })
  })
  it('"table for" misheard as "four"', () => {
    expect(p('charge table for 12')).toMatchObject({ label: 'Table 4', amount: 12 })
  })
  it('menu item only (price from menu)', () => {
    expect(p('charge jollof')).toEqual({ kind: 'charge', label: null, amount: null, item: 'jollof', qty: 1 })
  })
  it('quantity + menu item', () => {
    expect(p('charge two jollof')).toEqual({ kind: 'charge', label: null, amount: null, item: 'jollof', qty: 2 })
  })
  it('name + "for two suya"', () => {
    expect(p('charge Chidi for two suya')).toEqual({ kind: 'charge', label: 'Chidi', amount: null, item: 'suya', qty: 2 })
  })
  it('name + quantity + menu item', () => {
    expect(p('charge Bisi two zobo')).toEqual({ kind: 'charge', label: 'Bisi Adeyemi', amount: null, item: 'zobo', qty: 2 })
    expect(p('charge Tunde 3 suya')).toEqual({ kind: 'charge', label: 'Tunde', amount: null, item: 'suya', qty: 3 })
  })
  it('name + menu item + explicit price', () => {
    expect(p('charge Tunde jollof 15')).toEqual({ kind: 'charge', label: 'Tunde', amount: 15, item: 'jollof', qty: 1 })
  })
  it('plural menu items ("two lattes")', () => {
    const intl = { menu: ['latte', 'espresso', 'flat white'], customers: ['Maria', 'Kenji', 'Aisha'] }
    expect(parseCommand('charge table four, two lattes', intl)).toEqual({ kind: 'charge', label: 'Table 4', amount: null, item: 'latte', qty: 2 })
    expect(parseCommand('charge Kenji three espressos', intl)).toEqual({ kind: 'charge', label: 'Kenji', amount: null, item: 'espresso', qty: 3 })
    expect(parseCommand('charge Aisha two flat whites', intl)).toEqual({ kind: 'charge', label: 'Aisha', amount: null, item: 'flat white', qty: 2 })
  })
  it('two-word menu item', () => {
    expect(p('charge Chidi two fried rice')).toEqual({ kind: 'charge', label: 'Chidi', amount: null, item: 'fried rice', qty: 2 })
  })
  it('fuzzy customer name from STT misspelling', () => {
    expect(p('charge Bisi Adeyem 20 grams')).toMatchObject({ label: 'Bisi Adeyemi', amount: 20 })
  })
  it('unknown name is title-cased', () => {
    expect(p('charge mama kemi 8')).toMatchObject({ label: 'Mama Kemi', amount: 8 })
  })
  it('walk-in amount only', () => {
    expect(p('charge 7.5')).toEqual({ kind: 'charge', label: null, amount: 7.5, item: null, qty: 1 })
  })
  it('decimal spoken', () => {
    expect(p('bill Tunde twelve point five')).toMatchObject({ label: 'Tunde', amount: 12.5 })
  })
  it('rejects charge with no amount and no menu item', () => {
    expect(p('charge Tunde').kind).toBe('unknown')
  })
  it('rejects absurd amounts', () => {
    expect(p('charge Tunde 5000000').kind).toBe('unknown')
  })
})

describe('parseCommand: other verbs', () => {
  it('remind', () => {
    expect(p('remind all')).toEqual({ kind: 'remind', target: 'all' })
    expect(p('remind Tunde please')).toEqual({ kind: 'remind', target: 'Tunde' })
    expect(p('remind')).toEqual({ kind: 'remind', target: null })
  })
  it('cancel', () => {
    expect(p('cancel last')).toEqual({ kind: 'cancel', target: 'last' })
    expect(p('cancel that')).toEqual({ kind: 'cancel', target: 'last' })
    expect(p('cancel Chidi order')).toEqual({ kind: 'cancel', target: 'Chidi' })
  })
  it('repeat / total', () => {
    expect(p('repeat')).toEqual({ kind: 'repeat' })
    expect(p("what's the total today")).toEqual({ kind: 'total' })
  })
  it('unrelated speech is unknown', () => {
    expect(p('hello how are you').kind).toBe('unknown')
  })
})

describe('fuzzyPick', () => {
  it('matches close names only', () => {
    expect(fuzzyPick('jolof', ['jollof', 'suya'])).toBe('jollof')
    expect(fuzzyPick('pizza', ['jollof', 'suya'])).toBeNull()
  })
})

describe('worldwide: typed commands in other languages', () => {
  const intl = { menu: ['latte', 'espresso', 'cafe com leite', 'croissant', 'pound cake'], customers: ['María', 'Kenji', 'Aisha', 'Oleg', 'José'] }
  const q = (t: string) => parseCommand(t, intl)
  it.each([
    ['cobra María 12', { label: 'María', amount: 12 }], // Spanish
    ['cobrar mesa 4 dos latte', { label: 'Table 4', item: 'latte', qty: 2 }], // Spanish
    ['cobra José 3 cafe com leite', { label: 'José', item: 'cafe com leite', qty: 3 }], // Portuguese
    ['encaisse Aisha 7,50', { label: 'Aisha', amount: 7.5 }], // French, decimal comma
    ['kassiere Tisch 2 zwei espresso', { label: 'Table 2', item: 'espresso', qty: 2 }], // German
    ['addebita Kenji 9', { label: 'Kenji', amount: 9 }], // Italian
    ['tahsil Oleg 15', { label: 'Oleg', amount: 15 }], // Turkish
    ['tagih meja 3 untuk dua croissant', { label: 'Table 3', item: 'croissant', qty: 2 }], // Indonesian
  ])('%s', (text, expected) => {
    expect(q(text)).toMatchObject({ kind: 'charge', ...expected })
  })
  it('remind / cancel / total in other languages', () => {
    expect(q('recuerda a todos')).toEqual({ kind: 'remind', target: 'all' })
    expect(q('rappelle Aisha')).toEqual({ kind: 'remind', target: 'Aisha' })
    expect(q('cancela el último')).toEqual({ kind: 'cancel', target: 'last' })
    expect(q('annuler dernier')).toEqual({ kind: 'cancel', target: 'last' })
    expect(q('total de hoy')).toEqual({ kind: 'total' })
  })
  it('keeps non-Latin names', () => {
    expect(parseCommand('charge Олег 5', intl)).toMatchObject({ label: 'Олег', amount: 5 })
    expect(parseCommand('charge 健二 5', intl)).toMatchObject({ label: '健二', amount: 5 })
  })
  it('matches names regardless of accents', () => {
    expect(q('charge Maria 4')).toMatchObject({ label: 'María' })
    expect(q('charge jose 4')).toMatchObject({ label: 'José' })
  })
})

describe('worldwide: amounts', () => {
  it('spoken prices like "twelve fifty"', () => {
    expect(p('charge Tunde twelve fifty')).toMatchObject({ amount: 12.5 })
    expect(p('charge Tunde four ninety nine')).toMatchObject({ amount: 4.99 })
    expect(p('charge twenty five')).toMatchObject({ amount: 25 }) // still a normal number
  })
  it('does not merge a table number with the amount', () => {
    expect(p('charge table four twenty')).toMatchObject({ label: 'Table 4', amount: 20 })
    expect(p('charge table four, twenty')).toMatchObject({ label: 'Table 4', amount: 20 })
  })
  it('decimal comma and thousands separators', () => {
    expect(p('charge Tunde 12,50')).toMatchObject({ amount: 12.5 })
    expect(p('charge Tunde 1,000')).toMatchObject({ amount: 1000 })
  })
  it('refuses fiat amounts instead of charging them as GRAM', () => {
    for (const t of ['charge Tunde 12 dollars', 'charge Tunde $12', 'charge Tunde €5', 'charge Tunde 500 naira', 'charge Tunde 20 euros', 'cobra María 10 pesos', 'charge Tunde 5 usdt']) {
      expect(p(t)).toMatchObject({ kind: 'unknown', reason: 'fiat' })
    }
  })
  it('a menu item containing a currency word is not refused', () => {
    expect(parseCommand('charge Kenji two pound cake', { menu: ['pound cake'], customers: ['Kenji'] })).toMatchObject({ item: 'pound cake', qty: 2 })
  })
})

describe('reconcileWithOriginal (spoken non-English)', () => {
  const ctx = { menu: ['cafe com leite', 'pao de queijo'], customers: ['João', 'Ana'] }
  it('recovers menu items and names lost in translation', () => {
    // Said (pt): "Cobra o João dois café com leite" -> Whisper translation: "Charge John two coffees with milk"
    const english = parseCommand('Charge John two coffees with milk', ctx)
    const fixed = reconcileWithOriginal(english, 'Cobra o João dois café com leite', ctx)
    expect(fixed).toMatchObject({ kind: 'charge', label: 'João', item: 'cafe com leite' })
  })
  it('keeps the parsed amount and table labels', () => {
    const english = parseCommand('Charge table 3, 8', ctx)
    expect(reconcileWithOriginal(english, 'Cobra mesa três, oito', ctx)).toMatchObject({ label: 'Table 3', amount: 8 })
  })
})

describe('speech-to-text homophones', () => {
  const ctx = { menu: ['latte'], customers: [] as string[] }
  it('reads "table for" as table 4', () => {
    expect(parseCommand('Charge table for two lattes.', ctx)).toMatchObject({ kind: 'charge', label: 'Table 4', item: 'latte', qty: 2 })
    expect(parseCommand('Charge table for, twelve.', ctx)).toMatchObject({ kind: 'charge', label: 'Table 4', amount: 12 })
  })
  it('keeps an unpriced item after a table instead of charging the bare number', () => {
    expect(parseCommand('Charge table for two lattes.', { menu: [], customers: [] })).toMatchObject({ kind: 'charge', label: 'Table 4', item: 'lattes', qty: 2, amount: null })
  })
  it('reads a final "too" as two, but keeps "for" in "for two lattes"', () => {
    expect(parseCommand('Charge Abiola too.', ctx)).toMatchObject({ kind: 'charge', label: 'Abiola', amount: 2 })
    expect(parseCommand('Charge Maria for two lattes', ctx)).toMatchObject({ kind: 'charge', label: 'Maria', item: 'latte', qty: 2 })
  })
})

describe('accented speech', () => {
  const ctx = { menu: ['latte'], customers: ['Abiola', 'Maria'] }
  it('understands a mangled "charge" as the first word', () => {
    expect(parseCommand('Chá, Abiola, one.', ctx)).toMatchObject({ kind: 'charge', label: 'Abiola', amount: 1 })
    expect(parseCommand('Charj Maria twelve', ctx)).toMatchObject({ kind: 'charge', label: 'Maria', amount: 12 })
    expect(parseCommand('Shaj table four 5', ctx)).toMatchObject({ kind: 'charge', label: 'Table 4', amount: 5 })
    expect(parseCommand('Remaind all', ctx)).toMatchObject({ kind: 'remind', target: 'all' })
  })
  it('matches a misheard name to a known one', () => {
    expect(parseCommand('Charge Nabiola one', ctx)).toMatchObject({ kind: 'charge', label: 'Abiola', amount: 1 })
  })
  it('never turns a name or random first word into a command', () => {
    expect(parseCommand('Chad twelve', { menu: [], customers: [] }).kind).toBe('charge') // close enough to "charge"; the confirm card shows it
    expect(parseCommand('Maria twelve', ctx).kind).toBe('unknown')
    expect(parseCommand('cancer', ctx).kind).toBe('unknown')
  })
})

