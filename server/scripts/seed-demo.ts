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
  store.createSeller("Mama T's Kitchen", parsed.toString({ testOnly: true, bounceable: false }), parsed.toRawString(), null)
for (const [item, price] of [['jollof', '12'], ['fried rice', '12'], ['suya', '5'], ['zobo', '2']] as const) store.setMenuItem(seller.id, item, toNano(price))
for (const name of ['Tunde', 'Bisi', 'Chidi']) store.upsertCustomer(seller.id, name, null)
console.log(`Seller #${seller.id}: ${seller.name} watching ${seller.address}`)
console.log(`Pairing code (10 min): ${store.createPairCode(seller.id)}`)
