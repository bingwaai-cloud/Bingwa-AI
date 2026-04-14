import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { db } from '../db.js'
import { logger } from '../utils/logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Template SQL is two directories up from src/services/
const TEMPLATE_PATH = path.join(__dirname, '../../db/migrations/002_tenant_schema_template.sql')

/**
 * Creates the PostgreSQL schema for a new tenant and runs all
 * per-tenant DDL (tables, indexes) from the migration template.
 *
 * This is DDL — it cannot run inside a Prisma transaction.
 * If it fails, the caller is responsible for rolling back the
 * public.tenants record that was already created.
 */
export async function createTenantSchema(schemaName: string): Promise<void> {
  let template: string

  try {
    template = await fs.readFile(TEMPLATE_PATH, 'utf-8')
  } catch (err) {
    throw new Error(`Could not read tenant schema template: ${String(err)}`)
  }

  // Replace all :schema_name placeholders with the actual schema name.
  // The schemaName has already been validated to match /^tenant_[0-9a-f_]{36}$/
  // by the time it reaches here, so direct interpolation is safe.
  const sql = template.replace(/:schema_name/g, schemaName)

  logger.info({ event: 'tenant_schema_creating', schemaName })

  // Prisma's extended query protocol does NOT support multiple statements per call.
  // We split on ";\n" and run each statement inside a single $transaction so they
  // all share the same connection — this makes SET LOCAL search_path persist.
  //
  // Important: strip leading comment lines from each chunk before filtering,
  // otherwise statements like "-- ─── Items\nCREATE TABLE items" get dropped.
  const statements = sql
    .split(/;\s*\n/)
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((s) => s.length > 0)

  try {
    await db.$transaction(
      async (tx) => {
        for (const statement of statements) {
          await tx.$executeRawUnsafe(statement)
        }
      },
      { timeout: 30_000 } // DDL can be slow on first run
    )
    logger.info({ event: 'tenant_schema_created', schemaName, statements: statements.length })
  } catch (err) {
    logger.error({ event: 'tenant_schema_creation_failed', schemaName, err })
    throw new Error(`Failed to create tenant schema ${schemaName}: ${String(err)}`)
  }
}

/**
 * Drops a tenant's schema entirely.
 * DANGER — only call this during a failed signup rollback (schema was just
 * created seconds ago and has no data).  Never call on a live tenant.
 */
export async function dropTenantSchema(schemaName: string): Promise<void> {
  logger.warn({ event: 'tenant_schema_dropping', schemaName })
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
  logger.warn({ event: 'tenant_schema_dropped', schemaName })
}
