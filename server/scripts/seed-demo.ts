// Seed a demo shop without Telegram (for simulator testing / recording).
// Usage: DB_PATH=./data/gramtill.db npx tsx scripts/seed-demo.ts <testnet-wallet-address>
import { Address } from '@ton/core'
import { Store } from '../src/db.js'
import { toNano } from '../src/money.js'

const addr = process.argv[2]
if (!addr) {
  console.error('Usage: npx tsx scripts/seed-demo.ts <wallet-address>')
  process.exit(1)
}
const store = new Store(process.env.DB_PATH ?? './data/gramtill.db')
const parsed = Address.parse(addr)
const seller =
  store.listSellers().find(s => s.addressRaw === parsed.toRawString()) ??
  store.createSeller('Corner Coffee', parsed.toString({ testOnly: true, bounceable: false }), parsed.toRawString(), null)
for (const [item, price] of [['latte', '4'], ['espresso', '3'], ['croissant', '3.5'], ['flat white', '4.5']] as const) store.setMenuItem(seller.id, item, toNano(price))
for (const name of ['Maria', 'Kenji', 'Aisha', 'Lucas']) store.upsertCustomer(seller.id, name, null)
console.log(`Seller #${seller.id}: ${seller.name} watching ${seller.address}`)
console.log(`Pairing code (10 min): ${store.createPairCode(seller.id)}`)
