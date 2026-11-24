import { afterEach, describe, expect, it, vi } from 'vitest'
import { Address } from '@ton/core'
import { buildApi } from '../src/api.js'
import { toNano } from '../src/money.js'
import { makeStore } from './helpers.js'
import { TillService, nullNotifier } from '../src/service.js'

const ADDR = 'EQD2NmD_lH5f5u1Kj3KfGyTvhZSX0Eg6qp2a5IQUKXxOG21n'

/** Fake Whisper: answers by endpoint and by the language field the server sends. */
function mockWhisper(answers: { transcriptions: Record<string, string>; translation?: string }) {
  const calls: { path: string; language: string | null; model: string | null }[] = []
  const prompts: (string | null)[] = []
  const real = globalThis.fetch
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (!u.startsWith('https://stt.test')) return real(url as any, init)
    const form = init!.body as FormData
    const path = u.endsWith('/translations') ? 'translations' : 'transcriptions'
    const language = form.get('language') as string | null
    calls.push({ path, language, model: form.get('model') as string | null })
    prompts.push(form.get('prompt') as string | null)
    const text = path === 'translations' ? answers.translation ?? '' : answers.transcriptions[language ?? ''] ?? ''
    return new Response(JSON.stringify({ text }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return Object.defineProperty(calls, "prompts", { value: prompts, enumerable: false }) as typeof calls & { prompts: (string | null)[] }
}

afterEach(() => vi.unstubAllGlobals())

async function setup(language: string) {
  const store = await makeStore()
  const service = new TillService(store, nullNotifier, { network: 'testnet', publicUrl: 'https://till.example', timezone: 'UTC', orderTtlMinutes: 30, maxChargeGram: 500 })
  const app = buildApi({
    store, service, publicUrl: 'https://till.example', devSimulate: false,
    stt: { apiKey: 'k', baseUrl: 'https://stt.test', model: 'whisper-large-v3-turbo', translateModel: 'whisper-large-v3' },
  })
  const seller = await store.createSeller('Padaria Central', ADDR, Address.parse(ADDR).toRawString(), 1)
  await store.updateSellerLanguage(seller.id, language)
  await store.upsertCustomer(seller.id, 'João', null)
  await store.upsertCustomer(seller.id, 'Maria', null)
  await store.setMenuItem(seller.id, 'café com leite', toNano('3'))
  await store.setMenuItem(seller.id, 'latte', toNano('4'))
  const code = await store.createPairCode(seller.id)
  const { token } = (await (await app.request('/api/pair', { method: 'POST', body: JSON.stringify({ code }), headers: { 'Content-Type': 'application/json' } })).json()) as any
  const voice = async () =>
    (await (await app.request('/api/voice', { method: 'POST', body: new Uint8Array(32000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' } })).json()) as any
  return { voice, store, seller }
}

describe('/api/voice', () => {
  it('hints Whisper with the seller\'s own names (incl. recent walk-ins) and no example sentences', async () => {
    const calls = mockWhisper({ transcriptions: { en: 'Charge Abiola two.' } })
    const { voice, store, seller } = await setup('en')
    await store.createOrder({ sellerId: seller.id, label: 'Abiola', amountNano: toNano('1') })
    const r = await voice()
    expect(calls.prompts[0]).toContain('Abiola')
    expect(calls.prompts[0]).toContain('latte')
    expect(calls.prompts[0]).not.toMatch(/table four|charge maria/i)
    expect(r.confirm).toMatchObject({ label: 'Abiola', amount: '2' })
  })

  it('English seller: one fast transcription', async () => {
    const calls = mockWhisper({ transcriptions: { en: 'Charge Maria, two lattes.' } })
    const { voice } = await setup('en')
    const r = await voice()
    expect(calls).toEqual([{ path: 'transcriptions', language: 'en', model: 'whisper-large-v3-turbo' }])
    expect(r.confirm).toMatchObject({ label: 'Maria', amount: '8', item: '2× latte' })
  })

  it('Portuguese seller: transcribe + translate in parallel, names and menu words recovered', async () => {
    const calls = mockWhisper({
      transcriptions: { pt: 'Cobra o João dois café com leite.' },
      translation: 'Charge John two coffees with milk.',
    })
    const { voice } = await setup('pt')
    const r = await voice()
    expect(calls.map(c => c.path).sort()).toEqual(['transcriptions', 'translations'])
    expect(calls.find(c => c.path === 'transcriptions')).toMatchObject({ language: 'pt' })
    expect(calls.find(c => c.path === 'translations')).toMatchObject({ language: 'en', model: 'whisper-large-v3' })
    expect(r.transcript).toBe('Cobra o João dois café com leite.') // phone shows what was actually said
    expect(r.confirm).toMatchObject({ label: 'João', amount: '6', item: '2× café com leite' })
  })

  it('refuses fiat amounts with a clear message', async () => {
    mockWhisper({ transcriptions: { en: 'Charge Maria 12 dollars' } })
    const { voice } = await setup('en')
    expect(await voice()).toMatchObject({ action: 'error', message: 'Say the amount in GRAM' })
  })

  it('reports a missing STT key instead of crashing', async () => {
    const { voice } = await setup('en')
    mockWhisper({ transcriptions: {} })
    expect((await voice()).action).toBe('error')
  })
})
