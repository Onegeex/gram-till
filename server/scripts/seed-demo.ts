// Seed a demo shop without Telegram (for simulator testing / recording).
// Usage: DB_PATH=./data/gramtill.db npx tsx scripts/seed-demo.ts <testnet-wallet-address>
// (or DATABASE_URL=postgres://… to seed the Postgres database instead)
import { Address } from '@ton/core'
import { toNano } from '../src/money.js'
import { openStore } from '../src/store/index.js'

const addr = process.argv[2]
if (!addr) {
  console.error('Usage: npx tsx scripts/seed-demo.ts <wallet-address>')
  process.exit(1)
}
const store = await openStore({ databaseUrl: process.env.DATABASE_URL ?? process.env.POSTGRES_URL, sqlitePath: process.env.DB_PATH ?? './data/gramtill.db' })
await store.migrate()
const parsed = Address.parse(addr)
const seller =
  (await store.listSellers()).find(s => s.addressRaw === parsed.toRawString()) ??
  (await store.createSeller('Corner Coffee', parsed.toString({ testOnly: true, bounceable: false }), parsed.toRawString(), null))
for (const [item, price] of [['latte', '4'], ['espresso', '3'], ['croissant', '3.5'], ['flat white', '4.5']] as const) await store.setMenuItem(seller.id, item, toNano(price))
for (const name of ['Maria', 'Kenji', 'Aisha', 'Lucas']) await store.upsertCustomer(seller.id, name, null)
console.log(`Seller #${seller.id}: ${seller.name} watching ${seller.address}`)
console.log(`Pairing code (10 min): ${await store.createPairCode(seller.id)}`)
await store.close()
