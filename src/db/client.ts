import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { migrate as migrateNodePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';

import * as schema from './schema.js';

export type Schema = typeof schema;

/** Banco ou transação — os serviços aceitam os dois. */
export type Db =
  | PgDatabase<PgQueryResultHKT, Schema>
  | PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

export interface Database {
  db: PgDatabase<PgQueryResultHKT, Schema>;
  migrate: () => Promise<void>;
  close: () => Promise<void>;
  kind: 'postgres' | 'pglite';
}

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Cria a conexão a partir de DATABASE_URL:
 * - `postgres://…` / `postgresql://…` → PostgreSQL (pool do node-postgres);
 * - `pglite:memory` → PostgreSQL embutido em memória (testes);
 * - `pglite:<pasta>` → PostgreSQL embutido persistido em disco (desenvolvimento).
 */
export function createDatabase(url: string): Database {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const db = drizzleNodePg({ client: pool, schema, casing: 'snake_case' });
    return {
      db,
      kind: 'postgres',
      migrate: () => migrateNodePg(db, { migrationsFolder: MIGRATIONS_FOLDER }),
      close: () => pool.end(),
    };
  }
  if (url.startsWith('pglite:')) {
    const target = url.slice('pglite:'.length);
    let client: PGlite;
    if (target === 'memory' || target === '') {
      client = new PGlite();
    } else {
      mkdirSync(target, { recursive: true });
      client = new PGlite(target);
    }
    const db = drizzlePglite({ client, schema, casing: 'snake_case' });
    return {
      db,
      kind: 'pglite',
      migrate: () => migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER }),
      close: () => client.close(),
    };
  }
  throw new Error('DATABASE_URL deve começar com postgres://, postgresql:// ou pglite:');
}
