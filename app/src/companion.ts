// Phone-side screen inside the Even app (the WebView). The glasses show the till;
// this page handles pairing and offers a typed fallback for noisy places.

import type { PaymentEvent, TillSnapshot } from './format'

export interface CompanionState {
  paired: boolean
  server: string
  shop?: string
  network?: 'testnet' | 'mainnet'
  snapshot?: TillSnapshot
  error?: string
}

export interface Companion {
  state(s: CompanionState): void
  online(on: boolean): void
  payment(p: PaymentEvent): void
  transcript(t: string): void
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function mountCompanion(h: {
  server: string
  pair(server: string, code: string): Promise<void>
  unpair(): Promise<void>
  typed(text: string): Promise<void>
}): Companion {
  const root = document.getElementById('app')!
  root.innerHTML = `
    <header><b>Gram Till</b> <span id="chip" class="chip">starting</span></header>
    <section id="setup" class="card hidden">
      <h2>Connect your till</h2>
      <p class="muted">In Telegram, open your Gram Till bot and send <b>/pair</b>. Enter the 6-digit code here.</p>
      <label>Server <input id="server" autocomplete="off" spellcheck="false"></label>
      <label>Pairing code <input id="code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code"></label>
      <button id="pairBtn">Connect</button>
      <p id="err" class="err"></p>
    </section>
    <section id="main" class="card hidden">
      <div class="muted" id="shop"></div>
      <div class="big" id="total">-</div>
      <div class="muted" id="counts"></div>
      <div id="events" class="events"></div>
      <form id="typeForm">
        <input id="typeIn" placeholder="Type a charge: Maria 12 for 2 lattes" autocomplete="off">
        <button>Send</button>
      </form>
      <p class="muted small">On the glasses: <b>tap</b> to speak a charge, <b>swipe</b> for the menu, <b>double-tap</b> to go back.</p>
      <p class="muted small" id="heard"></p>
      <button id="unpairBtn" class="link">Disconnect this phone</button>
    </section>`

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const serverIn = $<HTMLInputElement>('server')
  serverIn.value = h.server
  const setChip = (text: string, cls: string) => {
    const c = $('chip')
    c.textContent = text
    c.className = `chip ${cls}`
  }

  $('pairBtn').onclick = async () => {
    $('err').textContent = ''
    const code = $<HTMLInputElement>('code').value
    if (!/^\d{6}$/.test(code.trim())) {
      $('err').textContent = 'Enter the 6-digit code from the bot.'
      return
    }
    try {
      await h.pair(serverIn.value, code)
    } catch (e) {
      $('err').textContent = (e as Error).message
    }
  }

  $('typeForm').onsubmit = ev => {
    ev.preventDefault()
    const input = $<HTMLInputElement>('typeIn')
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    void h.typed(/^(charge|bill|remind|cancel|repeat|total|today)\b/i.test(text) ? text : `charge ${text}`)
  }
  $('unpairBtn').onclick = () => void h.unpair()

  const log = (html: string) => {
    const el = document.createElement('div')
    el.innerHTML = html
    $('events').prepend(el)
    while ($('events').children.length > 6) $('events').lastChild!.remove()
  }

  return {
    state(s) {
      $('setup').classList.toggle('hidden', s.paired)
      $('main').classList.toggle('hidden', !s.paired)
      if (s.error) $('err').textContent = s.error
      if (!s.paired) return setChip('not connected', 'off')
      setChip(s.network === 'testnet' ? 'live · testnet' : 'live', 'on')
      if (s.shop) $('shop').textContent = s.shop
      if (s.snapshot) {
        $('total').textContent = `${s.snapshot.today.total} GRAM today`
        $('counts').textContent = `${s.snapshot.today.paid} paid · ${s.snapshot.today.waiting} waiting · ${s.snapshot.today.unmatched} unmatched`
      }
    },
    online(on) {
      setChip(on ? 'live' : 'reconnecting', on ? 'on' : 'warn')
    },
    payment(p) {
      const who = esc(p.label ?? 'Walk-in')
      log(p.result === 'paid' ? `✅ <b>+${esc(p.amount)} GRAM</b> · ${who} · ${esc(p.code ?? '')}` : `⚠️ +${esc(p.amount)} GRAM (${esc(p.result.replace('_', ' '))})`)
    },
    transcript(t) {
      $('heard').textContent = `Heard: "${t}"`
    },
  }
}
