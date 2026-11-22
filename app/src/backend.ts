import type { Confirm, PaymentEvent, TillSnapshot } from './format'

export interface InterpretResult {
  transcript: string
  action: 'confirm' | 'done' | 'error'
  confirm?: Confirm
  message?: string
  examples?: string[]
}

export class Backend {
  constructor(
    public baseUrl: string,
    public token: string | null,
  ) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.baseUrl.replace(/\/$/, '') + path, {
      ...init,
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(init.body && !(init.body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok) throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { status: res.status })
    return json as T
  }

  pair(code: string) {
    return this.req<{ token: string; seller: { name: string; address: string } }>('/api/pair', { method: 'POST', body: JSON.stringify({ code }) })
  }
  till() {
    return this.req<TillSnapshot>('/api/till')
  }
  voice(pcm: Uint8Array) {
    return this.req<InterpretResult>('/api/voice', { method: 'POST', body: pcm as BodyInit, headers: { 'Content-Type': 'application/octet-stream' } })
  }
  command(text: string) {
    return this.req<InterpretResult>('/api/command', { method: 'POST', body: JSON.stringify({ text }) })
  }
  repeat() {
    return this.req<InterpretResult>('/api/repeat', { method: 'POST' })
  }
  confirm(id: string) {
    return this.req<{ ok: boolean; message: string }>(`/api/confirm/${id}`, { method: 'POST' })
  }
  discard(id: string) {
    return this.req<{ ok: boolean }>(`/api/discard/${id}`, { method: 'POST' }).catch(() => ({ ok: false }))
  }
  remind(orderId: number) {
    return this.req<{ ok: boolean; message: string }>(`/api/orders/${orderId}/remind`, { method: 'POST' })
  }
  cancel(orderId: number) {
    return this.req<{ ok: boolean }>(`/api/orders/${orderId}/cancel`, { method: 'POST' })
  }

  /** Live updates. EventSource reconnects on its own; we surface open/closed for the UI. */
  stream(handlers: {
    till: (s: TillSnapshot) => void
    payment: (p: PaymentEvent) => void
    status: (online: boolean) => void
  }): () => void {
    const es = new EventSource(`${this.baseUrl.replace(/\/$/, '')}/api/stream?token=${encodeURIComponent(this.token ?? '')}`)
    es.addEventListener('till', e => handlers.till(JSON.parse((e as MessageEvent).data)))
    es.addEventListener('payment', e => handlers.payment(JSON.parse((e as MessageEvent).data)))
    es.onopen = () => handlers.status(true)
    es.onerror = () => handlers.status(false)
    return () => es.close()
  }
}
