import type { TillStore } from './types.js'

export * from './types.js'

/**
 * DATABASE_URL (or POSTGRES_URL, as Vercel's Neon integration names it) → Postgres.
 * Otherwise a local SQLite file (or ':memory:').
 */
export async function openStore(opts: { databaseUrl?: string; sqlitePath?: string }): Promise<TillStore> {
  if (opts.databaseUrl) {
    const { PgStore } = await import('./pg.js')
    const store = new PgStore(opts.databaseUrl)
    await store.migrate()
    return store
  }
  const { SqliteStore } = await import('./sqlite.js')
  return new SqliteStore(opts.sqlitePath ?? ':memory:')
}
