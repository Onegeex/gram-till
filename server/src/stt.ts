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
  /** Bias Whisper toward the words the seller actually uses. */
  prompt?: string
}

export async function transcribe(pcm: Uint8Array, opts: SttOptions): Promise<string> {
  if (!opts.apiKey) throw new Error('Speech-to-text is not configured (set GROQ_API_KEY)')
  if (pcm.byteLength < 16000) throw new Error('Too short: hold and speak for at least half a second')
  const form = new FormData()
  form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'speech.wav')
  form.append('model', opts.model)
  form.append('language', 'en')
  form.append('response_format', 'json')
  form.append('temperature', '0')
  if (opts.prompt) form.append('prompt', opts.prompt)
  const res = await fetch(`${opts.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`STT failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as { text?: string }
  return (json.text ?? '').trim()
}
