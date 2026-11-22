# Gram Till — Build Plan

**Hackathon:** Heads Up: Even Realities Hackathon (TVM Ventures × Daos Hub × Even Realities), DoraHacks

**Builder:** Abiola Omidiran, Lagos (solo, simulator only, no G2 hardware)

**Tracks entered:** 02 Crypto & DeFi (main, Gram Wallet) + 01 Messaging & News (Telegram). Also eligible for Best Telegram Integration.

**Apps used (all listed in those two tracks):** Gram Wallet (TON) · Telegram (Bot API)

> **Pre-build disclosure (rule: "say in your README what existed before Nov 23").**
> Before Nov 23 12:00 Dubai, only this plan, research notes and account setup existed. No app code.
> All code is written during build week, Nov 23–29, 2026.

---

## 1. Key dates (Lagos = UTC+1 · Dubai = UTC+4)

| Event | Dubai | Lagos |
|---|---|---|
| Kickoff + Even tech briefing, build starts | Nov 23, 12:00 | Nov 23, 09:00 |
| **Submission deadline** | Nov 29, 23:59 | **Nov 29, 20:59** |
| Judging, finalists announced | Nov 30 – Dec 1 | |
| Demo Day (remote allowed) | Dec 3, 14:00–18:00 | Dec 3, 11:00–15:00 |

Internal target: **submit by Nov 29, 18:00 Lagos** (3-hour buffer).

---

## 2. The pitch

**One line:** A hands-free till for people who get paid in Telegram. The payment lands and "Paid ✓" shows in your glasses. Say "charge fifteen" and the customer gets a Gram Wallet payment request.

**The everyday moment:** a food seller, barber, market trader, café worker or delivery rider takes payment in Telegram while their hands are busy. Today they stop, wipe their hands, unlock the phone and scroll to check whether money arrived, or they trust a screenshot. On G2 it takes a glance.

**Who it's for:** small sellers who already sell through Telegram (shop channels, groups and DMs). This is a large, real behaviour in Lagos and across emerging markets. With Gram Wallet now built into Telegram, a customer can pay without leaving the chat.

**Why now:** Telegram's native, non-custodial Gram Wallet is rolling out to its users. Telegram covers fees on 5 free transfers per day, so small payments cost the customer nothing. Sellers need a way to *receive* that payment without stopping work.

**Why it's unique (checked Nov 22):** of ~57 public repos for this hackathon, none uses Gram Wallet or TON. The ~10 crypto entries are all trading or price apps, and most use paper or mock data.

**Fit with the organizers:** TVM Ventures backs DeFi and PayFi built into Telegram on TON. Gram Till is PayFi inside Telegram, on glasses.

---

## 3. Read and write (20% of judging)

| | On the glasses | Input |
|---|---|---|
| **Read** | `+15 GRAM · Tunde · Order #7 ✓` takes over the lens for 4 s, then goes back to the Till card | none (it just appears while the app is open) |
| **Read** | Till card: `Today 214 GRAM · 18 paid · 2 waiting` | glance |
| **Write** | "Charge Tunde fifteen" / "charge table four, twelve for jollof" → confirm card → tap → the bot sends the payment request | 1 tap + short phrase |
| **Write** | One-tap presets on the Till card: *Repeat last charge* · *Send receipt* · *Remind waiting* | 1 tap |
| **Write** | Waiting list → tap an order → *Remind* / *Cancel* | swipe + tap |

Smart defaults: last amount, recent customers and the seller's menu items ("jollof" = 12 GRAM) are configured once in Telegram (`/menu`).

---

## 4. The Telegram side (second track + Telegram prize)

- **Seller bot** (`@GramTillBot`, working name):
  - `/start` → set the receiving Gram Wallet address (paste, or connect via TON Connect)
  - `/pair` → 6-digit code for the glasses app (Google sign-in doesn't work in the WebView)
  - `/menu jollof 12`, `/customers`, `/today` (summary), `/export` (CSV of the day)
- **Customer flow** (no app install):
  - The customer opens the shop's link or scans the counter QR (`t.me/GramTillBot?start=shop_<id>`).
  - The bot sends **"Pay 15 GRAM — Order #7 · Mama T's Kitchen"** with a **[Pay with Gram Wallet]** button, which opens a `ton://transfer/<seller>?amount=…&text=GT-7&exp=…` link, or a TON Connect link as a fallback.
  - After payment, the customer automatically gets a **receipt** in the same chat.
- **Counter QR mode:** the QR always shows the seller's *latest* waiting order, for walk-in customers with no name.

---

## 5. Money safety (part of "Business potential & safety", 20%)

- **No custody, no keys.** Gram Till never holds funds or private keys. It only **watches** the seller's own wallet address (read-only) and **creates payment links**. The customer approves every payment in their own wallet.
- **Nothing in the app can move money**, including refunds. Refunds are handed back to the seller's own wallet as a pre-filled link they approve themselves.
- **Network guard:** demo and dev run on **TON testnet**. Mainnet is only ever **read-only watching**, behind an explicit `MODE=mainnet-readonly` flag.
- **Order matching:** each request carries a unique comment (`GT-7F3K`) and an expiry (`exp`). A payment counts as *Paid* only if the comment and amount match. Payments that don't match show as "Unmatched +3 GRAM", never as a fake "paid".
- **Privacy:** the lens shows only the first name and order number. No full Telegram handles are stored beyond what the seller adds. No message content is read; the bot only sees its own chats.
- **Secrets:** bot token, Toncenter key and STT key live on the backend in `.env`, never in the app or the repo. The app's `app.json` whitelists only our backend.
- No financial advice and no trading. It's payments acceptance only.

---

## 6. Architecture

```
 G2 glasses ◄─BLE─► Even App (phone) ── WebView: Gram Till (Vite + TS + Even Hub SDK)
                                              │  HTTPS + SSE (only whitelisted host)
                                              ▼
                               Backend (Node + TypeScript, Hono)
             ┌─────────────────┬──────────────┴───────────┬──────────────────┐
             ▼                 ▼                          ▼                  ▼
     Toncenter API v3     Telegram Bot API          STT: Whisper       SQLite: sellers,
     (testnet + mainnet   (grammY: seller cmds,     (Groq whisper-      orders, customers,
     read-only; tg-wallet customer requests,        large-v3-turbo)    menu, payments,
     contract supported)  receipts, inline btns)                       pairing codes
```

**Payment watcher:** poll the seller's address on Toncenter every 3–5 s (stream/WebSocket if available) → keep incoming transactions only → decode the text comment (opcode `0x00000000`) → match an open order by comment + amount (± fee tolerance) → mark it paid → push it to the glasses over SSE and send the Telegram receipt.

**Glasses app**

- `@evenrealities/even_hub_sdk`, starting from the official `evenhub-templates/minimal`, with the mic pattern from `asr`.
- Cards (one at a time, ≤ 5 short lines, 576 × 288 mono):
  1. **Till**: `TODAY 214 GRAM` · `18 paid · 2 waiting` · `Last: Tunde +15 ✓ 2m`
  2. **Paid! takeover** (4 s): `✓ +15 GRAM` · `Tunde · Order #7`
  3. **Waiting list** (list container): `#8 Table 4 · 12 · 3m`
  4. **Listening…** with a live transcript
  5. **Confirm charge**: `CHARGE TUNDE 15 GRAM` · `"jollof"` · `tap = send · 2×tap = cancel`
  6. **Sent**: `Request sent ✓ · waiting…`
- Gestures: swipe = move between cards · tap = select/confirm · double-tap = back/cancel (double-tap on Till = exit dialog).
- In-place updates via `textContainerUpgrade` (debounced ~150 ms). Lifecycle: pause on background, full refresh on foreground. While the glasses app is closed, Telegram notifies the seller instead (the bot DMs "Paid ✓"), so nothing is missed.

**Voice grammar (deterministic, no LLM needed):**

- `charge [<name>|table <n>] <amount> [for <item>]` · `charge <item>` (uses the menu price)
- `repeat` · `remind [<name>|all]` · `cancel <order>` · `today` / `total`
- Number words ("fifteen", "twelve fifty") and fuzzy matching of names and menu items.
- No match → "Didn't catch that" plus 2 example phrases. Nothing is sent.

**Endpoints:** `POST /pair` · `GET /till` · `GET /stream` (SSE) · `POST /voice` · `POST /orders` (preview) · `POST /orders/:id/send` · `POST /orders/:id/remind|cancel` · Telegram webhook.

**Hosting:** local backend + simulator for development. For judges, an always-on Node host (Render/Railway/Fly), since it needs long-running polling and the bot. README includes a one-command local setup.

---

## 7. Day-by-day schedule

| Day (Lagos) | Goal | Done when |
|---|---|---|
| **Sun Nov 22 (prep, no code)** | Accounts, wallets and tooling ready | Checklist in §10 complete |
| **Mon Nov 23** 09:00 kickoff | Scaffold + Till card on the simulator; backend skeleton; Toncenter testnet watcher | A testnet transfer to the seller address shows "+2 GRAM" on the simulator |
| **Tue Nov 24** | Orders: create → `ton://` link with comment/exp → match → Paid takeover; SSE; lifecycle | An order paid from a second testnet wallet flips to ✓ automatically |
| **Wed Nov 25** | Telegram bot: seller setup, /pair, customer start link, Pay button, receipts, counter QR | Customer pays from the bot message and gets a receipt; glasses show ✓ |
| **Thu Nov 26** | Voice: mic → Whisper → grammar → confirm → send; menu + customers | "Charge Tunde fifteen" → tap → Tunde's Telegram gets the request |
| **Fri Nov 27** | Waiting list, remind/cancel, presets, unmatched payments, `/today` and `/export`; **mainnet read-only mode** on the real Gram Wallet | A real Gram Wallet tip shows on the lens in read-only mode |
| **Sat Nov 28** | UX polish on 576 × 288, error states, deploy backend, README, `evenhub pack` → `.ehpk` | Fresh clone + README gives a working setup |
| **Sun Nov 29** | Record the ≤ 3-min video, description and feature requests. **Submit by 18:00** | Submitted on DoraHacks |

**Scope cut order if behind:** (1) `/export`, (2) counter QR mode, (3) the remind action, (4) mainnet read-only mode, falling back to a testnet-only demo.

---

## 8. Demo video script (≤ 3 min)

1. **0:00–0:20** A Lagos food seller with hands in the pot, and a customer saying "I don pay o!" On the phone today: unlock, scroll, check a screenshot.
2. **0:20–0:55** With Gram Till: "Charge table four, twelve for jollof" → confirm card → tap. The customer's Telegram gets "Pay 12 GRAM · Order #8" → they tap Pay in their wallet.
3. **0:55–1:25** "✓ +12 GRAM · Table 4" takes over the lens, the Till total ticks up, and a receipt appears in the customer's chat.
4. **1:25–1:55** Busy moment: a waiting list with 2 orders → remind with one tap. An unmatched tip shows honestly as "Unmatched".
5. **1:55–2:20** Real-world proof: read-only mode on a real Gram Wallet in Telegram. A 0.1 GRAM tip lands on the lens.
6. **2:20–2:45** Safety: no keys, no custody, read-only watching, every payment approved by the customer in their own wallet, testnet by default.
7. **2:45–3:00** Business: Telegram sellers across Africa and other emerging markets, a free tier plus a Pro tier (multi-staff, export, menus), and a path to the Even Hub catalogue.

---

## 9. Risks and fallbacks

| Risk | Fallback |
|---|---|
| Gram Wallet isn't enabled on Abiola's Telegram yet | Demo with TON testnet wallets (wallet.ton.org / Tonkeeper testnet). Gram Wallet compatibility is shown through Toncenter's tg-wallet contract support and the TON Connect deep links Gram Wallet accepts |
| `ton://` link doesn't open Gram Wallet | Use a TON Connect deep link (documented for Telegram Money) or a QR code |
| Testnet faucet limits (2 GRAM/claim, 1 per hour) | Claim several times Mon–Thu; demo amounts of 0.1–2 GRAM |
| Toncenter rate limits | Free API key via @tonapibot; back off and cache; a second provider as fallback |
| STT accuracy with accents | Short fixed grammar, number normalisation, menu shortcuts, one-tap presets as backup |
| A judge asks "who pays in GRAM?" | Answer: Telegram's built-in wallet makes it the default money in the chat; USDT on TON is the same flow (jetton transfer), a planned next step |

---

## 10. Today's prep checklist (no code)

- [ ] Register on DoraHacks; fill *"How did you hear about this hackathon?"*
- [ ] **Check Gram Wallet:** in Telegram, look for *Wallet / Money* in Settings. If it's there, note your address and send yourself a `ton://transfer/<your-address>?amount=100000000&text=test` link to see whether tapping it opens Gram Wallet.
- [ ] Install Node.js LTS on the Mac, then `npm i -g @evenrealities/evenhub-cli @evenrealities/evenhub-simulator` and confirm the simulator launches.
- [ ] Create **two testnet wallets** (seller + customer) in wallet.ton.org or Tonkeeper (testnet mode).
- [ ] Claim testnet GRAM from **@testgiver_ton_bot** for both wallets (repeat hourly when you can).
- [ ] Get a **testnet Toncenter API key** from @tonapibot.
- [ ] Telegram: create the bot with **@BotFather** and save the token.
- [ ] Create a **Groq** account and API key (Whisper STT).
- [ ] Sign in to the **Even Hub** developer account (hub.evenrealities.com) for packaging later.
- [ ] Create an empty public GitHub repo `gram-till` (only this plan before Nov 23).
- [ ] Set an alarm for kickoff: **Mon 09:00 Lagos**.

---

## 11. Feature requests to submit (draft)

1. Gram Wallet / Telegram Money: a **testnet mode** for developers.
2. Gram Wallet: a documented **payment-request link** (amount + comment + expiry) that opens directly in Telegram's wallet from any chat.
3. Telegram Bot API: a **"payment received" update** for Gram Wallet transfers to a bot-linked address, so bots don't need to poll a chain API.
4. Even Hub: a **background notification channel**, so a plugin can show a one-line "Paid ✓" when it isn't in the foreground.
5. Even Hub: **built-in STT** for plugins.

---

## 12. Judging alignment

| Criterion | Weight | How Gram Till scores |
|---|---|---|
| Usefulness on G2 | 25% | Hands-busy, everyday moment; glance replaces unlock-and-scroll |
| Read and write | 20% | Paid ✓ at a glance; "charge fifteen" + one tap; presets |
| Technical execution | 20% | Real TON testnet payments end to end, real Gram Wallet read-only, real Telegram bot; clean README |
| UX for display and voice | 15% | One card, ≤ 5 lines, short fixed phrases, takeover only for payments |
| Business potential and safety | 20% | PayFi in Telegram (TVM thesis), an emerging-market seller base, no custody or keys |
