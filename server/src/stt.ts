// Speech-to-text. The Even Hub SDK gives raw mic audio (PCM s16le, 16 kHz, mono);
// we wrap it as WAV and send it to an OpenAI-compatible transcription endpoint
// (default: Groq whisper-large-v3-turbo). Keys stay on this server.

export function pcmToWav(pcm: Uint8Array, sampleRate = 16000, channels = 1, bitsPerSample = 16): Uint8Array<ArrayBuffer> {
  const header = new ArrayBuffer(44)
  const v = new DataView(header)
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  const writeStr = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + pcm.byteLength, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, channels, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, byteRate, true)
  v.setUint16(32, (channels * bitsPerSample) / 8, true)
  v.setUint16(34, bitsPerSample, true)
  writeStr(36, 'data')
  v.setUint32(40, pcm.byteLength, true)
  const out = new Uint8Array(44 + pcm.byteLength)
  out.set(new Uint8Array(header), 0)
  out.set(pcm, 44)
  return out
}

export interface SttOptions {
  apiKey?: string
  baseUrl: string
  model: string
  /** Model for translating other languages to English (Groq: whisper-large-v3; turbo can't translate). */
  translateModel?: string
  /** Bias Whisper toward the words the seller actually uses. */
  prompt?: string
}

/** Languages Whisper can transcribe (ISO-639-1, plus a few Whisper-specific codes). */
export const WHISPER_LANGUAGES = new Set(
  ('en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue').split(' '),
)

export interface Heard {
  /** What was said, in the seller's language. */
  original: string
  /** English text the grammar parses (same as original for English). */
  english: string
  language: string
}

/**
 * English sellers: one fast transcription. Other languages: transcribe in that language
 * (for names and menu words) and translate to English (for the grammar) in parallel.
 * Telling Whisper the language matters for 1-3 second commands, where auto-detect is unreliable.
 */
export async function understandSpeech(pcm: Uint8Array, language: string, opts: SttOptions): Promise<Heard> {
  if (language === 'en') {
    const text = await transcribe(pcm, { ...opts, language: 'en' })
    return { original: text, english: text, language }
  }
  const [original, english] = await Promise.all([
    transcribe(pcm, { ...opts, language }),
    transcribe(pcm, { ...opts, model: opts.translateModel ?? 'whisper-large-v3', translate: true }),
  ])
  return { original, english, language }
}

export async function transcribe(pcm: Uint8Array, opts: SttOptions & { language?: string; translate?: boolean }): Promise<string> {
  if (!opts.apiKey) throw new Error('Voice needs GROQ_API_KEY on the server')
  if (pcm.byteLength < 16000) throw new Error('Too short: speak for at least half a second')
  const form = new FormData()
  form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'speech.wav')
  form.append('model', opts.model)
  // The translations endpoint only accepts "en"; transcriptions take the speaker's language.
  if (opts.translate) form.append('language', 'en')
  else if (opts.language) form.append('language', opts.language)
  form.append('response_format', 'json')
  form.append('temperature', '0')
  if (opts.prompt) form.append('prompt', opts.prompt)
  const res = await fetch(`${opts.baseUrl}/audio/${opts.translate ? 'translations' : 'transcriptions'}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`STT failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as { text?: string }
  return (json.text ?? '').trim()
}
