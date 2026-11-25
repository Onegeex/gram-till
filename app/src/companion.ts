// Phone-side screen inside the Even app (the WebView). Everything the glasses can do,
// with the same look: a live mirror of the lens (with Send / Cancel when a charge is
// waiting for you), today's numbers, a typed charge box, waiting orders with remind /
// cancel, and the payment feed. Pairing lives here too.

import type { Card, HeroIcon, PaymentEvent, TillSnapshot, WaitingOrder } from './format'

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
  /** What the glasses show right now; `actionable` = a confirm card the phone can answer. */
  mirror(card: Card | { list: string; items: string[] }, screen: string): void
}

export interface CompanionHandlers {
  server: string
  pair(server: string, code: string): Promise<void>
  unpair(): Promise<void>
  typed(text: string): Promise<void>
  press(kind: 'tap' | 'double'): Promise<void>
  remind(orderId: number): Promise<{ ok: boolean; message: string }>
  cancel(orderId: number): Promise<unknown>
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const ago = (m: number) => (m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`)

// Same line icons as the lens hero (src/hero.ts), as SVG.
const ICON: Record<HeroIcon, string> = {
  check: '<circle cx="12" cy="12" r="9.5"/><path d="M7.5 12.4l3 3 6-6.4"/>',
  cross: '<circle cx="12" cy="12" r="9.5"/><path d="M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8"/>',
  warn: '<path d="M12 3.2l9.4 16.6H2.6z"/><path d="M12 9.6v4.6"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/>',
  coin: '<circle cx="12" cy="12" r="9.5"/><text x="12" y="16.3" text-anchor="middle" font-size="11.5" font-weight="800" fill="currentColor" stroke="none">G</text>',
  link: '<ellipse cx="9" cy="12" rx="5" ry="3.2" transform="rotate(-45 9 12)"/><ellipse cx="15" cy="12" rx="5" ry="3.2" transform="rotate(-45 15 12)"/>',
  dots: '<circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/>',
  mic: '<rect x="9" y="2.8" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.6 11a6.4 6.4 0 0 0 12.8 0M12 17.4v3.4M8.6 21h6.8"/>',
}
const icon = (i: HeroIcon, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[i]}</svg>`

const RESULT: Record<string, { icon: HeroIcon; label: string; tone: string }> = {
  paid: { icon: 'check', label: 'Paid', tone: 'ok' },
  underpaid: { icon: 'warn', label: 'Short payment', tone: 'warn' },
  already_paid: { icon: 'warn', label: 'Paid twice', tone: 'warn' },
  cancelled_order: { icon: 'warn', label: 'Paid a cancelled order', tone: 'warn' },
  unmatched: { icon: 'coin', label: 'No order code', tone: 'info' },
}

export function mountCompanion(h: CompanionHandlers): Companion {
  const root = document.getElementById('app')!
  root.innerHTML = `
  <header class="top">
    <div class="brand"><span class="logo">${icon('coin')}</span><span id="shopName">Gram Till</span></div>
    <span id="chip" class="chip">starting</span>
  </header>

  <section id="setup" class="hidden">
    <div class="panel hero-panel">
      <div class="kicker">${icon('link')} PAIR YOUR GLASSES</div>
      <h1>Connect your till</h1>
      <ol class="steps">
        <li><b>1</b><span>Open your shop bot in Telegram (e.g. <i>@GramTillBot</i>)</span></li>
        <li><b>2</b><span>Send <code>/pair</code>: you get a 6-digit code</span></li>
        <li><b>3</b><span>Enter it below</span></li>
      </ol>
      <input id="code" class="code" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code" aria-label="Pairing code">
      <button id="pairBtn" class="btn primary wide">Connect</button>
      <p id="err" class="err" role="alert"></p>
      <details class="adv"><summary>Server</summary><input id="server" autocomplete="off" spellcheck="false" aria-label="Server URL"></details>
    </div>
  </section>

  <section id="main" class="hidden">
    <div class="label">On your glasses</div>
    <div id="lens" class="lens" aria-live="polite"></div>
    <div id="lensActions" class="lens-actions hidden">
      <button id="sendBtn" class="btn primary">Send</button>
      <button id="cancelBtn" class="btn ghost">Cancel</button>
    </div>

    <div class="panel today">
      <div class="kicker">${icon('coin')} TODAY</div>
      <div class="total"><span id="total">0</span><small>GRAM</small></div>
      <div class="tiles">
        <div class="tile"><b id="nPaid">0</b><span>paid</span></div>
        <div class="tile"><b id="nWaiting">0</b><span>waiting</span></div>
        <div class="tile"><b id="nUnmatched">0</b><span>no code</span></div>
      </div>
    </div>

    <div class="panel">
      <div class="kicker">${icon('mic')} CHARGE</div>
      <form id="typeForm" class="charge">
        <input id="typeIn" placeholder="Maria 12  ·  table 4, 2 lattes" autocomplete="off" enterkeyhint="send" aria-label="Type a charge">
        <button class="btn primary" aria-label="Send charge">Charge</button>
      </form>
      <div class="chips">
        <button class="pill" data-cmd="repeat">Repeat last</button>
        <button class="pill" data-cmd="remind all">Remind all waiting</button>
      </div>
      <p id="heard" class="heard hidden"></p>
      <p class="hint">Same as speaking it on the glasses: you confirm before anything is sent.</p>
    </div>

    <div class="panel">
      <div class="row-head"><div class="kicker">${icon('dots')} WAITING</div><span id="waitCount" class="count"></span></div>
      <div id="waiting" class="list"></div>
    </div>

    <div class="panel">
      <div class="kicker">${icon('check')} ACTIVITY</div>
      <div id="feed" class="list"></div>
    </div>

    <details class="panel help">
      <summary>Glasses controls</summary>
      <div class="gestures">
        <div><b>Tap</b><span>speak a charge · send a confirm card</span></div>
        <div><b>Double-tap</b><span>cancel · go back</span></div>
        <div><b>Swipe</b><span>menu: repeat, waiting orders, remind</span></div>
      </div>
      <p class="hint">One charge per tap, e.g. "Charge Maria five" or "Charge table four, two lattes". Prices come from your menu (<code>/menu latte 4</code> in Telegram).</p>
    </details>

    <footer class="foot">
      <span id="addr" class="addr"></span>
      <button id="unpairBtn" class="link">Disconnect this phone</button>
    </footer>
  </section>
  <div id="toast" class="toast" role="status"></div>`

  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
  $<HTMLInputElement>('server').value = h.server
  let snapshot: TillSnapshot | undefined
  let live: PaymentEvent[] = []
  let toastTimer: ReturnType<typeof setTimeout> | undefined

  const toast = (text: string) => {
    const t = $('toast')
    t.textContent = text
    t.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600)
  }
  const setChip = (text: string, cls: string) => {
    const c = $('chip')
    c.textContent = text
    c.className = `chip ${cls}`
  }

  // ---------- setup ----------
  const doPair = async () => {
    $('err').textContent = ''
    const code = $<HTMLInputElement>('code').value.trim()
    if (!/^\d{6}$/.test(code)) return void ($('err').textContent = 'Enter the 6-digit code from the bot.')
    const b = $<HTMLButtonElement>('pairBtn')
    b.disabled = true
    b.textContent = 'Connecting…'
    try {
      await h.pair($<HTMLInputElement>('server').value, code)
    } catch (e) {
      $('err').textContent = (e as Error).message
    } finally {
      b.disabled = false
      b.textContent = 'Connect'
    }
  }
  $('pairBtn').onclick = doPair
  $('code').oninput = () => {
    const el = $<HTMLInputElement>('code')
    el.value = el.value.replace(/\D/g, '').slice(0, 6)
    if (el.value.length === 6) void doPair()
  }

  // ---------- actions ----------
  $('typeForm').onsubmit = ev => {
    ev.preventDefault()
    const input = $<HTMLInputElement>('typeIn')
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    input.blur()
    void h.typed(/^(charge|bill|remind|cancel|repeat|total|today)\b/i.test(text) ? text : `charge ${text}`)
  }
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-cmd]')) b.onclick = () => void h.typed(b.dataset.cmd!)
  $('sendBtn').onclick = () => void h.press('tap')
  $('cancelBtn').onclick = () => void h.press('double')
  $('unpairBtn').onclick = () => {
    if (confirm('Disconnect this phone from the till? You can pair again with /pair.')) void h.unpair()
  }

  $('waiting').onclick = async ev => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]')
    if (!b) return
    const id = Number(b.dataset.id)
    if (b.dataset.act === 'remind') {
      b.disabled = true
      try {
        toast((await h.remind(id)).message)
      } catch (e) {
        toast((e as Error).message)
      }
      b.disabled = false
    } else if (b.dataset.act === 'cancel') {
      // Two-step: the first press arms the button.
      if (!b.classList.contains('armed')) {
        b.classList.add('armed')
        b.textContent = 'Tap again to cancel'
        setTimeout(() => {
          b.classList.remove('armed')
          b.textContent = 'Cancel'
        }, 3000)
        return
      }
      b.disabled = true
      try {
        await h.cancel(id)
        toast('Order cancelled')
      } catch (e) {
        toast((e as Error).message)
      }
    }
  }

  // ---------- rendering ----------
  const renderWaiting = (orders: WaitingOrder[]) => {
    $('waitCount').textContent = orders.length ? String(orders.length) : ''
    $('waiting').innerHTML = orders.length
      ? orders
          .map(
            o => `<div class="item">
        <div class="who"><b>${esc(o.label)}</b><span>${esc([o.item, o.code, o.expired ? 'expired' : ago(o.agoMin)].filter(Boolean).join(' · '))}</span></div>
        <div class="amt">${esc(o.amount)}<small>GRAM</small></div>
        <div class="acts"><button class="pill" data-act="remind" data-id="${o.id}">Remind</button><button class="pill danger" data-act="cancel" data-id="${o.id}">Cancel</button></div>
      </div>`,
          )
          .join('')
      : `<div class="empty">Nothing waiting. New charges show up here until they're paid.</div>`
  }

  const renderFeed = () => {
    const rows = [
      ...live.map(p => ({ result: p.result, amount: p.amount, label: p.label, note: p.code ?? p.comment, when: 'just now' })),
      ...(snapshot?.recent ?? []).map(r => ({ result: r.result, amount: r.amount, label: r.label, note: r.comment, when: ago(r.agoMin) })),
    ].slice(0, 12)
    $('feed').innerHTML = rows.length
      ? rows
          .map(r => {
            const k = RESULT[r.result] ?? RESULT.unmatched
            return `<div class="item ${k.tone}">
          ${icon(k.icon, 'feed-ic')}
          <div class="who"><b>${esc(r.label ?? (r.result === 'unmatched' ? 'Money in' : 'Walk-in'))}</b><span>${esc([k.label, r.note, r.when].filter(Boolean).join(' · '))}</span></div>
          <div class="amt">+${esc(r.amount)}<small>GRAM</small></div>
        </div>`
          })
          .join('')
      : `<div class="empty">No payments yet today. They appear here, on your glasses and in Telegram the moment they land.</div>`
  }

  const renderLens = (c: Card | { list: string; items: string[] }, screen: string) => {
    const lens = $('lens')
    if ('list' in c) {
      lens.className = 'lens list'
      lens.innerHTML = `<div class="l-status"><span>${esc(c.list)}</span></div><ul>${c.items.map((i, k) => `<li class="${k === 0 ? 'sel' : ''}">${esc(i)}</li>`).join('')}</ul>`
    } else {
      const hero = c.hero
      lens.className = `lens ${c.boxed ? 'boxed' : ''} ${hero ? '' : 'wide'}`
      lens.innerHTML = `
        <div class="l-status"><span>${esc(c.status[0])}</span><span>${esc(c.status[1])}</span></div>
        <div class="l-body">
          ${
            hero
              ? `<div class="l-hero ${hero.big ? '' : 'iconic'}">
                  <div class="l-kicker">${hero.icon && hero.big ? icon(hero.icon) : ''}${esc(hero.kicker ?? '')}</div>
                  ${hero.big ? `<div class="l-big">${esc(hero.big)}${hero.unit ? `<small>${esc(hero.unit)}</small>` : ''}</div>` : hero.icon ? `<div class="l-icon ${hero.icon === 'mic' && (hero.level ?? 0) > 0.3 ? 'loud' : ''}">${icon(hero.icon)}</div>` : ''}
                </div>`
              : ''
          }
          <div class="l-col">${c.title ? `<div class="l-title">${esc(c.title).replace(/\n/g, '<br>')}</div>` : ''}${(c.lines ?? []).map(l => `<div>${esc(l)}</div>`).join('')}</div>
        </div>
        <div class="l-hint">${esc(c.hint ?? '')}</div>`
    }
    const confirmable = screen === 'confirm'
    $('lensActions').classList.toggle('hidden', !confirmable)
    if (confirmable && !('list' in c)) {
      const m = (c.hint ?? '').match(/(\d+)s$/)
      $('sendBtn').textContent = c.hero?.kicker === 'CANCEL ORDER' ? 'Cancel order' : `Send${m ? ` · ${m[1]}s` : ''}`
      $('cancelBtn').textContent = c.hero?.kicker === 'CANCEL ORDER' ? 'Keep it' : 'Cancel'
    }
  }

  return {
    state(s) {
      $('setup').classList.toggle('hidden', s.paired)
      $('main').classList.toggle('hidden', !s.paired)
      if (s.error) {
        $('err').textContent = s.error
        if (s.paired) toast(s.error)
      }
      if (!s.paired) {
        $('shopName').textContent = 'Gram Till'
        return setChip('not connected', 'off')
      }
      setChip(s.network === 'mainnet' ? 'live' : 'live · testnet', 'on')
      if (s.shop) $('shopName').textContent = s.shop
      if (s.snapshot) {
        snapshot = s.snapshot
        // Live events already counted in the snapshot's recent list: drop them from the local feed.
        live = live.slice(0, Math.max(0, live.length - s.snapshot.recent.length))
        $('total').textContent = s.snapshot.today.total
        $('nPaid').textContent = String(s.snapshot.today.paid)
        $('nWaiting').textContent = String(s.snapshot.today.waiting)
        $('nUnmatched').textContent = String(s.snapshot.today.unmatched)
        const a = s.snapshot.seller.address
        $('addr').textContent = `${s.network === 'mainnet' ? '' : 'Testnet · '}paid into ${a.slice(0, 6)}…${a.slice(-6)}`
        renderWaiting(s.snapshot.waiting)
        renderFeed()
      }
    },
    online(on) {
      setChip(on ? (snapshot?.seller.network === 'mainnet' ? 'live' : 'live · testnet') : 'reconnecting', on ? 'on' : 'warn')
    },
    payment(p) {
      live = [p, ...live].slice(0, 12)
      renderFeed()
      if (p.result === 'paid') toast(`+${p.amount} GRAM from ${p.label ?? 'walk-in'}`)
    },
    transcript(t) {
      const el = $('heard')
      el.classList.remove('hidden')
      el.textContent = `Heard: “${t}”`
    },
    mirror: renderLens,
  }
}
