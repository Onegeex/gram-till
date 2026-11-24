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
  :root { color-scheme: light dark; --bg:#0f1512; --card:#18211c; --fg:#e8f5ec; --muted:#9bb5a4; --accent:#3ddc84; --warn:#f5c04a; }
  * { box-sizing: border-box } body { margin:0; font:16px/1.45 -apple-system, system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width: 420px; margin: 0 auto; padding: 20px 16px 40px; }
  .card { background:var(--card); border-radius:16px; padding:20px; }
  .shop { color:var(--muted); font-size:14px; } .amount { font-size:40px; font-weight:700; margin:4px 0; }
  .item { color:var(--muted); } .code { font-family: ui-monospace, monospace; letter-spacing: 1px; }
  .net { display:inline-block; background:var(--warn); color:#111; border-radius:6px; padding:2px 8px; font-size:12px; font-weight:700; margin-bottom:10px }
  .btn { display:block; width:100%; text-align:center; padding:14px; border-radius:12px; margin-top:10px; font-weight:600; text-decoration:none; border:0; font-size:16px; cursor:pointer }
  .primary { background:var(--accent); color:#06210f } .secondary { background:transparent; color:var(--fg); border:1px solid #2d3b33 }
  .qr { display:block; margin:16px auto 4px; border-radius:12px; background:#fff; padding:8px }
  .small { color:var(--muted); font-size:13px; text-align:center }
  #tc { display:flex; justify-content:center; margin-top:12px }
  .state { text-align:center; padding:28px 0 } .state .big { font-size:56px } .hidden { display:none }
  .err { color:#ff8a80; text-align:center; font-size:14px; margin-top:8px }
</style></head>
<body><main>
  <div class="card">
    ${info.network === 'testnet' ? '<span class="net">TESTNET · test coins only</span>' : ''}
    <div class="shop">${esc(info.shop)}</div>
    <div class="amount">${esc(info.amount)} GRAM</div>
    ${info.paidSoFar && info.total ? `<div class="small">Balance due · ${esc(info.paidSoFar)} of ${esc(info.total)} GRAM already received</div>` : ''}
    ${info.item ? `<div class="item">${esc(info.item)}</div>` : ''}
    <div class="small">Order <span class="code">${esc(info.code)}</span></div>

    <div id="paid" class="state ${info.status === 'paid' ? '' : 'hidden'}"><div class="big">✓</div><b>Paid. Thank you!</b><div class="small">Your receipt is in Telegram.</div></div>
    <div id="closed" class="state ${info.status === 'cancelled' || info.expired ? '' : 'hidden'}"><b>This request is ${info.status === 'cancelled' ? 'cancelled' : 'expired'}.</b><div class="small">Ask the seller for a new one.</div></div>

    <div id="pay" class="${info.status === 'waiting' && !info.expired ? '' : 'hidden'}">
      <div id="tc"></div>
      <button id="tcpay" class="btn primary hidden">Pay ${esc(info.amount)} GRAM</button>
      <a class="btn secondary" href="${esc(info.links.ton)}">Open in wallet app</a>
      <img class="qr" src="${qr}" width="240" height="240" alt="Payment QR code">
      <div class="small">Or scan with any TON wallet. The order code is filled in for you, so leave the comment as it is.</div>
      <div id="err" class="err"></div>
    </div>
  </div>
  <p class="small">Gram Till never holds your money. You pay the seller's wallet directly.</p>
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
