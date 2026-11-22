# Gram Till

**A hands-free till for people who get paid in Telegram, on Even Realities G2 glasses.**

A payment lands in your Gram Wallet and **PAID +12 GRAM · Maria** appears in your glasses. Say *"charge table four, two lattes"*, tap once, and the customer gets a payment request in Telegram. No unlocking your phone mid-task, no card terminal, and no trusting payment screenshots.

**Who it's for:** anyone, anywhere, who sells face to face and gets paid in Telegram, often with their hands full: coffee carts, food trucks, market stalls, barbers, tour guides, couriers, event and merch tables. Telegram's built-in Gram Wallet works across borders, so a seller can take payment from a local regular or a visitor from another country without a card machine, a local bank account or a currency exchange.

Built for **Heads Up: Even Realities Hackathon** (DoraHacks) · Tracks: **02 Crypto & DeFi** (Gram Wallet) + **01 Messaging & News** (Telegram) · Special: Best Telegram integration.

---

## ⚠️ What existed before Nov 23, 2026 (rules disclosure)

The rules ask entrants to say what existed before build week. Honest timeline:

- **Nov 22 (before kickoff):** idea research, `PLAN.md`, and a **first working prototype** of both parts, built Nov 22 and visible in the git history with timestamps:
  - `server/`: TON payment watcher, order matching, voice grammar, API, customer pay page, Telegram bot (50 unit tests)
  - `app/`: glasses app (till, payment takeover, voice to confirm card, menu, waiting list), tested in the official Even Hub simulator (14 unit tests)
- **Nov 23–29 (build week):** everything after the Nov 22 commits, including live testnet and Telegram integration on real accounts, polish, deployment, packaging and the demo video. See `git log`.

**Open-source code and APIs used:** the official MIT-licensed [`even-realities/evenhub-templates`](https://github.com/even-realities/evenhub-templates) (`minimal` template, used as the starting structure of `app/`); the incoming-payment pattern from the official TON guidebook example ([`ton-org/docs-examples`](https://github.com/ton-org/docs-examples), invoice-based deposits); libraries listed in each `package.json` (`@evenrealities/even_hub_sdk`, `@ton/core`, `@ton/ton`, `@tonconnect/ui`, `grammy`, `hono`, `qrcode`). APIs: Toncenter, Telegram Bot API, Groq (Whisper speech-to-text).

---

## Screens (from the official Even Hub simulator)

| Till | Payment lands | Voice → confirm |
|---|---|---|
| ![Till](docs/screens/till.png) | ![Paid](docs/screens/paid.png) | ![Confirm](docs/screens/confirm.png) |
| **Menu** | **Waiting orders** | **Short payment, reported honestly** |
| ![Menu](docs/screens/menu.png) | ![Waiting](docs/screens/waiting.png) | ![Short](docs/screens/short-payment.png) |

Customer pay page (opens from the Telegram Pay button): [docs/screens/pay-page.png](docs/screens/pay-page.png)

## How it works

```
 G2 glasses ◄─BLE─► Even app (phone) ── WebView: app/  (Vite + TS + Even Hub SDK)
                                             │  HTTPS + SSE
                                             ▼
                              server/  (Node + TypeScript, Hono, SQLite)
             ┌────────────────┬─────────────┴────────────┬───────────────────┐
             ▼                ▼                          ▼                   ▼
     Toncenter (read-only:   Telegram Bot API       Whisper STT          Pay page /pay/<code>
     watch the seller's      (seller setup, pay     (Groq; mic PCM →     (TON Connect for Gram Wallet,
     Gram Wallet)            requests, receipts)    text)                ton:// link, QR)
```

1. The seller sets up a shop in the Telegram bot and gives the wallet address they get paid into (their Gram Wallet).
2. On the glasses: **tap → speak → tap**, e.g. *"charge Maria twelve"*. The server turns speech into a **confirm card**. **Tap = send**, double-tap = cancel. Nothing is sent without that tap.
3. The customer gets **"Pay 15 GRAM · Order GT-7F3K"** in Telegram, with a Pay button. It opens the pay page, which offers TON Connect (Gram Wallet, Tonkeeper…), a `ton://` link and a QR. The order code goes into the transfer comment automatically.
4. The server watches the seller's wallet (read-only). When a transfer arrives whose comment carries the order code and whose amount covers it, the order is **paid**. The glasses show **PAID +12 GRAM · Maria**, the customer gets a receipt, and the seller gets a Telegram DM (so nothing is missed while the glasses app is closed).
5. Transfers without a known code show as **"MONEY IN · No order code"**, and short payments show as **"SHORT PAYMENT"**. They are never counted as paid.

**Glasses controls:** tap = speak a charge · swipe = menu (repeat last, waiting orders, remind all, today's total) · double-tap = back / exit.

**Voice grammar** (deterministic, no LLM: for money, predictable beats clever):
`charge <name | table N> <amount> [for [qty] <item>]` · `charge [qty] <item>` (price from `/menu`) · `remind <name | all>` · `cancel last` · `repeat` · `total`

## Safety

- **No custody, no keys.** Gram Till never holds funds or private keys and never signs a transaction. It reads the seller's own wallet and creates payment links. Customers approve every payment in their own wallet.
- **Testnet by default** (`NETWORK=testnet`). `NETWORK=mainnet` only *watches* a real Gram Wallet; there is nothing to send with.
- **One-tap confirm on the glasses**, previews that expire after 20 s and can be used only once, and a `MAX_CHARGE_GRAM` cap against misheard amounts.
- **Pairing codes** (6 digits, 10 minutes, single use) instead of passwords. Google sign-in doesn't work in the Even WebView.
- **Secrets stay on the server** (`.env`, never committed). The glasses app only talks to your server.
- The lens shows first names and order codes only.

## Works anywhere

- **Any country, any time zone:** each seller sets `/timezone` in the bot (e.g. `Europe/Berlin`, `Asia/Jakarta`, `America/Sao_Paulo`), so "today" totals follow their local midnight.
- **Any customer on Telegram:** payment requests, receipts and the pay page work wherever Telegram does. Pay with Telegram's Gram Wallet over TON Connect, any TON wallet via the `ton://` link, or by scanning the QR.
- **Language:** the voice grammar is English for now. Whisper already transcribes many languages, so per-language grammar packs (Spanish, Portuguese, Arabic, Turkish, Indonesian…) are the next step.

---

## Run it (Mac)

**Needs:** Node.js **22.5+** (`brew install node` or nodejs.org), and for Telegram buttons an https URL (a free Cloudflare tunnel works).

```bash
# 1. Server
cd server
npm install
cp .env.example .env        # fill in TELEGRAM_BOT_TOKEN, TONCENTER_API_KEY, GROQ_API_KEY
npm start                   # http://localhost:8787

# 2. (for Telegram Pay buttons) public https URL in another terminal:
brew install cloudflared && cloudflared tunnel --url http://localhost:8787
#    → copy the https://….trycloudflare.com URL into PUBLIC_URL in server/.env, restart the server

# 3. Glasses app
cd ../app
npm install
npm run dev                 # http://localhost:5173
npm run simulate            # opens the Even Hub simulator (uses your Mac's microphone)
```

Then in Telegram: open your bot → **/start** → shop name → paste your **testnet** wallet address → **/timezone** (your zone) → **/pair**. Enter the code in the simulator's phone panel (Server: `http://localhost:8787`).

**Testnet wallets and coins:** create two wallets in Tonkeeper (testnet mode) or wallet.ton.org, one for the seller and one for the customer, and get test GRAM from [@testgiver_ton_bot](https://t.me/testgiver_ton_bot). Get a Toncenter key from [@tonapibot](https://t.me/tonapibot).

**No chain? UI-only mode:** set `DEV_SIMULATE=1` (testnet only). `POST /dev/pay/<order-code>` fakes a payment so you can work on the lens UI offline. Demo videos use real testnet transfers, not this.

**Seed a demo shop without Telegram:** `cd server && DB_PATH=./data/gramtill.db npm run seed -- <wallet-address>` prints a pairing code.

**Real glasses:** `npx evenhub qr --url http://<your-mac-ip>:5173`, scan it from the Even app (developer mode). Package with `npm run pack` (put your server URL in `app/app.json` → `permissions` → `network.whitelist` first).

## Tests

```bash
cd server && npm test      # 50 tests: amounts, order matching, TON parsing, watcher paging/cursor, voice grammar, API flow, pay page
cd app && npm test         # 14 tests: lens state machine, payment takeover rules, gestures
```

## Project layout

```
server/src/
  ton.ts         read-only TON: comment parsing, incoming-payment extraction, payment links
  watcher.ts     polls each seller's wallet; cursor-based, never replays history
  matcher.ts     payment → order decision (paid / underpaid / unmatched / duplicate…)
  processor.ts   applies a payment once (idempotent by tx hash) and publishes events
  voice.ts       deterministic voice grammar ("charge table four, two lattes")
  stt.ts         mic PCM → WAV → Whisper
  service.ts     till operations shared by the glasses API and the bot
  api.ts         REST + SSE + pay page + one-shot confirmations
  bot.ts         Telegram bot (grammY)
  db.ts          SQLite (node:sqlite, no native modules)
app/src/
  controller.ts  lens state machine (till, listening, confirm, payment takeover, menus)
  display.ts     Even Hub SDK wrapper (serialized bridge calls) + gesture normalisation
  format.ts      text for each lens card (576×288, ASCII only)
  companion.ts   phone screen: pairing + typed fallback
```

## License

MIT
