import { Address } from '@ton/core'
import type { TillStore } from '../src/store/index.js'
import { SqliteStore } from '../src/store/sqlite.js'
import { PgStore } from '../src/store/pg.js'

/**
 * Every test runs against SQLite by default. Set TEST_DATABASE_URL to run the same suite
 * against Postgres (each store gets a fresh schema, so tests stay independent).
 */
let schemaSeq = 0
export async function makeStore(): Promise<TillStore> {
  const url = process.env.TEST_DATABASE_URL
  if (!url) return new SqliteStore(':memory:')
  const schema = `t_${process.pid}_${Date.now()}_${schemaSeq++}`
  const admin = new PgStore(url)
  await admin.sql.unsafe(`CREATE SCHEMA ${schema}`)
  await admin.close()
  const u = new URL(url)
  u.searchParams.set('options', `-c search_path=${schema}`)
  const store = new PgStore(u.toString())
  await store.migrate()
  return store
}

export const ADDR = 'EQD2NmD_lH5f5u1Kj3KfGyTvhZSX0Eg6qp2a5IQUKXxOG21n'
export const rawOf = (a: string) => Address.parse(a).toRawString()
