// Customer-facing payment page: /pay/<code>.
// Opened from the Telegram "Pay" button (inside Telegram's browser / as a Mini App)
// or by scanning the counter QR. It offers three ways to pay, all non-custodial:
//   1. TON Connect: connect Gram Wallet / Tonkeeper and approve the pre-filled transfer
//   2. ton:// deep link (opens the wallet app's send screen)
//   3. QR code of the same link (pay from another phone)
// The page then polls the order and flips to "Paid ✓" when the watcher sees the transfer.

import { beginCell } from '@ton/core'
import QRCode from 'qrcode'

export interface PayInfo {
  shop: string
  code: string
  item: string | null
  amount: string
  amountNano: string
  /** Full order amount, and what earlier part-payments covered (null when none). */
  total?: string
  paidSoFar?: string | null
  status: string
  expired: boolean
  address: string
  network: 'testnet' | 'mainnet'
  links: { page: string; ton: string; tonkeeper: string }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Text-comment payload (op 0 + text) as base64 BOC, for TON Connect sendTransaction. */
export function commentPayload(text: string): string {
  return beginCell().storeUint(0, 32).storeStringTail(text).endCell().toBoc().toString('base64')
}

export async function renderPayPage(info: PayInfo, publicUrl: string): Promise<string> {
  const qr = await QRCode.toDataURL(info.links.ton, { margin: 1, width: 240, errorCorrectionLevel: 'M' })
  const tx = {
    address: info.address,
    amount: info.amountNano,
    payload: commentPayload(info.code),
    network: info.network === 'testnet' ? '-3' : '-239',
  }
  const title = `Pay ${info.amount} GRAM · ${info.shop}`
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="/static/tonconnect-ui.min.js"></script>
<style>
  :root { --bg:#0b0f0d; --card:#121915; --card2:#18211b; --line:#1f2a24; --fg:#e9f3ec; --muted:#93a89b; --dim:#62756a; --accent:#3ddc84; --warn:#ffcf5c; --danger:#ff7a7a; }
  * { box-sizing: border-box } body { margin:0; font:16px/1.45 -apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif; background:var(--bg); color:var(--fg); -webkit-text-size-adjust:100% }
  main { max-width: 440px; margin: 0 auto; padding: max(18px, env(safe-area-inset-top)) 16px calc(32px + env(safe-area-inset-bottom)); }
  .ic { width:1.1em; height:1.1em; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; vertical-align:-.18em; flex:none }
  .top { display:flex; align-items:center; justify-content:space-between; margin:2px 2px 14px }
  .brand { display:flex; align-items:center; gap:10px; font-weight:700; font-size:16px; min-width:0 }
  .brand span:last-child { white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
  .logo { display:grid; place-items:center; width:32px; height:32px; border-radius:10px; background:#0f2418; color:var(--accent); font-size:18px; flex:none }
  .net { font-size:12px; font-weight:700; color:var(--warn); border:1px solid #4a3d12; border-radius:99px; padding:3px 10px; white-space:nowrap }
  .card { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:20px }
  .kicker { font-size:12px; font-weight:700; letter-spacing:1.4px; color:var(--muted) }
  .amount { display:flex; align-items:baseline; gap:8px; font-size:56px; font-weight:800; letter-spacing:-1.5px; line-height:1; margin:10px 0 6px }
  .amount small { font-size:18px; font-weight:700; color:var(--muted); letter-spacing:0 }
  .balance { color:var(--warn); font-size:14px; margin:6px 0 0 }
  .rows { margin:14px 0 4px; border-top:1px solid var(--line) }
  .row { display:flex; justify-content:space-between; gap:12px; padding:10px 0; border-bottom:1px solid var(--line); font-size:14px }
  .row span:first-child { color:var(--muted) } .code { font-family: ui-monospace, SFMono-Regular, monospace; letter-spacing:1px }
  .btn { display:flex; align-items:center; justify-content:center; gap:8px; width:100%; padding:15px; border-radius:14px; margin-top:12px; font-weight:650; text-decoration:none; border:0; font-size:16px; cursor:pointer; font-family:inherit }
  .primary { background:var(--accent); color:#04210f } .secondary { background:var(--card2); color:var(--fg); border:1px solid var(--line) }
  .btn:active { transform:scale(.985) }
  #tc { display:flex; justify-content:center; margin-top:16px }
  details.qrbox { margin-top:14px; border:1px solid var(--line); border-radius:14px; padding:12px 14px; background:var(--card2) }
  details.qrbox summary { cursor:pointer; color:var(--muted); font-size:14px; font-weight:600; list-style:none; display:flex; align-items:center; gap:8px }
  details.qrbox summary::-webkit-details-marker { display:none }
  .qr { display:block; margin:14px auto 6px; border-radius:12px; background:#fff; padding:8px }
  .small { color:var(--muted); font-size:13px; text-align:center }
  .state { text-align:center; padding:26px 0 10px }
  .badge { display:grid; place-items:center; width:76px; height:76px; margin:0 auto 14px; border-radius:50%; font-size:40px }
  .badge.ok { background:#10261a; color:var(--accent); box-shadow:0 0 0 8px rgba(61,220,132,.07), 0 0 40px rgba(61,220,132,.25) }
  .badge.no { background:#2a1717; color:var(--danger) }
  .state b { display:block; font-size:20px; margin-bottom:4px }
  .hidden { display:none !important }
  .err { color:var(--danger); text-align:center; font-size:14px; margin-top:10px; min-height:1em }
  .trust { display:flex; gap:10px; align-items:flex-start; color:var(--dim); font-size:13px; margin:16px 6px 0 }
  .trust .ic { color:var(--accent); margin-top:2px }
</style></head>
<body><main>
  <header class="top">
    <div class="brand"><span class="logo"><svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><text x="12" y="16.3" text-anchor="middle" font-size="11.5" font-weight="800" fill="currentColor" stroke="none">G</text></svg></span><span>${esc(info.shop)}</span></div>
    ${info.network === 'testnet' ? '<span class="net">TESTNET · test coins</span>' : ''}
  </header>

  <div class="card">
    <div class="kicker">PAY ${esc(info.shop.toUpperCase())}</div>
    <div class="amount">${esc(info.amount)}<small>GRAM</small></div>
    ${info.paidSoFar && info.total ? `<p class="balance">Balance due · ${esc(info.paidSoFar)} of ${esc(info.total)} GRAM already received</p>` : ''}
    <div class="rows">
      ${info.item ? `<div class="row"><span>For</span><span>${esc(info.item)}</span></div>` : ''}
      <div class="row"><span>Order</span><span class="code">${esc(info.code)}</span></div>
    </div>

    <div id="paid" class="state ${info.status === 'paid' ? '' : 'hidden'}">
      <div class="badge ok"><svg class="ic" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
      <b>Paid. Thank you!</b><div class="small">Your receipt is in Telegram.</div>
    </div>
    <div id="closed" class="state ${info.status === 'cancelled' || info.expired ? '' : 'hidden'}">
      <div class="badge no"><svg class="ic" viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></div>
      <b>This request is ${info.status === 'cancelled' ? 'cancelled' : 'expired'}.</b><div class="small">Ask the seller for a new one.</div>
    </div>

    <div id="pay" class="${info.status === 'waiting' && !info.expired ? '' : 'hidden'}">
      <div id="tc"></div>
      <button id="tcpay" class="btn primary hidden">Pay ${esc(info.amount)} GRAM</button>
      <a class="btn secondary" href="${esc(info.links.ton)}"><svg class="ic" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M16 12.5h2M3 10h18"/></svg>Open in wallet app</a>
      <details class="qrbox">
        <summary><svg class="ic" viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2"/></svg>Paying from another phone? Show QR</summary>
        <img class="qr" src="${qr}" width="240" height="240" alt="Payment QR code">
        <div class="small">Scan with any TON wallet. The order code is filled in for you, so leave the comment as it is.</div>
      </details>
      <div id="err" class="err"></div>
    </div>
  </div>
  <p class="trust"><svg class="ic" viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg><span>You pay ${esc(info.shop)}'s wallet directly. Gram Till never holds your money, and the seller sees "Paid" the moment it lands.</span></p>
</main>
<script>
  const TX = ${JSON.stringify(tx)};
  const CODE = ${JSON.stringify(info.code)};
  try { window.Telegram && Telegram.WebApp && (Telegram.WebApp.ready(), Telegram.WebApp.expand()); } catch (e) {}

  function show(id) { for (const x of ['paid','closed','pay']) document.getElementById(x).classList.toggle('hidden', x !== id); }

  // TON Connect (Gram Wallet in Telegram, Tonkeeper, etc.)
  try {
    const ui = new TON_CONNECT_UI.TonConnectUI({
      manifestUrl: ${JSON.stringify(publicUrl + '/tonconnect-manifest.json')},
      buttonRootId: 'tc',
    });
    const btn = document.getElementById('tcpay');
    ui.onStatusChange(w => btn.classList.toggle('hidden', !w));
    btn.onclick = async () => {
      document.getElementById('err').textContent = '';
      try {
        await ui.sendTransaction({
          validUntil: Math.floor(Date.now() / 1000) + 300,
          network: TX.network,
          messages: [{ address: TX.address, amount: TX.amount, payload: TX.payload }],
        });
        btn.textContent = 'Sent, waiting for confirmation…';
      } catch (e) {
        document.getElementById('err').textContent = 'Payment not sent: ' + (e && e.message ? e.message : e);
      }
    };
  } catch (e) { console.warn('TON Connect unavailable', e); }

  // Poll status until paid/closed.
  async function poll() {
    try {
      const r = await fetch('/pay/' + CODE + '/status', { cache: 'no-store' });
      if (r.ok) {
        const s = await r.json();
        if (s.status === 'paid') { show('paid'); try { Telegram.WebApp.HapticFeedback.notificationOccurred('success') } catch (e) {} return; }
        if (s.status === 'cancelled' || s.expired) { show('closed'); return; }
        if (s.due && s.due !== ${JSON.stringify(info.amount)}) { location.reload(); return; } // a part-payment arrived
      }
    } catch (e) {}
    setTimeout(poll, 3000);
  }
  poll();
</script>
</body></html>`
}
