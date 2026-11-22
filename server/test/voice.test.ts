import { describe, expect, it } from 'vitest'
import { parseCommand, wordsToNumbers, fuzzyPick } from '../src/voice.js'

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
