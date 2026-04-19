import { Prisma } from '@prisma/client'
import { db } from '../db.js'
import { logger } from '../utils/logger.js'

/**
 * Customers live in the per-tenant schema.
 * Soft-delete only — personal data can be hard-deleted on account closure (GDPR).
 */

export interface Customer {
  id: string
  tenantId: string
  phone: string | null
  name: string | null
  totalPurchases: number
  visitCount: number
  lastVisitedAt: Date | null
  optedInMarketing: boolean
  notes: string | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

const CUSTOMER_SELECT = `
  id::text,
  tenant_id::text        AS "tenantId",
  phone,
  name,
  total_purchases        AS "totalPurchases",
  visit_count            AS "visitCount",
  last_visited_at        AS "lastVisitedAt",
  opted_in_marketing     AS "optedInMarketing",
  notes,
  created_at             AS "createdAt",
  updated_at             AS "updatedAt",
  deleted_at             AS "deletedAt"
`

export interface CreateCustomerInput {
  tenantId: string
  phone?: string | null
  name?: string | null
  notes?: string | null
}

export async function createCustomer(
  schemaName: string,
  data: CreateCustomerInput
): Promise<Customer> {
  const phone = data.phone ?? null
  const name  = data.name  ?? null
  const notes = data.notes ?? null

  const rows = await db.$queryRaw<Customer[]>`
    INSERT INTO ${Prisma.raw(`"${schemaName}".customers`)}
      (tenant_id, phone, name, notes)
    VALUES
      (${data.tenantId}::uuid, ${phone}, ${name}, ${notes})
    RETURNING ${Prisma.raw(CUSTOMER_SELECT)}
  `
  const row = rows[0]
  if (!row) throw new Error('Customer insert returned no rows')
  return row
}

export async function findCustomerById(
  schemaName: string,
  tenantId: string,
  customerId: string
): Promise<Customer | null> {
  const rows = await db.$queryRaw<Customer[]>`
    SELECT ${Prisma.raw(CUSTOMER_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".customers`)}
    WHERE  id        = ${customerId}::uuid
    AND    tenant_id = ${tenantId}::uuid
    AND    deleted_at IS NULL
    LIMIT  1
  `
  return rows[0] ?? null
}

export async function findCustomerByPhone(
  schemaName: string,
  tenantId: string,
  phone: string
): Promise<Customer | null> {
  const rows = await db.$queryRaw<Customer[]>`
    SELECT ${Prisma.raw(CUSTOMER_SELECT)}
    FROM   ${Prisma.raw(`"${schemaName}".customers`)}
    WHERE  phone     = ${phone}
    AND    tenant_id = ${tenantId}::uuid
    AND    deleted_at IS NULL
    LIMIT  1
  `
  return rows[0] ?? null
}

export interface CustomerFilters {
  search?: string
  page?: number
  perPage?: number
}

export interface CustomerPage {
  customers: Customer[]
  total: number
  page: number
  perPage: number
}

export async function findCustomers(
  schemaName: string,
  tenantId: string,
  filters: CustomerFilters = {}
): Promise<CustomerPage> {
  const page    = Math.max(1, filters.page    ?? 1)
  const perPage = Math.min(100, Math.max(1, filters.perPage ?? 20))
  const offset  = (page - 1) * perPage

  let searchFilter = Prisma.sql``
  if (filters.search) {
    const pattern = `%${filters.search}%`
    searchFilter = Prisma.sql`AND (name ILIKE ${pattern} OR phone LIKE ${pattern})`
  }

  const [rows, countRows] = await Promise.all([
    db.$queryRaw<Customer[]>`
      SELECT ${Prisma.raw(CUSTOMER_SELECT)}
      FROM   ${Prisma.raw(`"${schemaName}".customers`)}
      WHERE  tenant_id  = ${tenantId}::uuid
      AND    deleted_at IS NULL
      ${searchFilter}
      ORDER  BY visit_count DESC, created_at DESC
      LIMIT  ${perPage}
      OFFSET ${offset}
    `,
    db.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(*) AS total
      FROM   ${Prisma.raw(`"${schemaName}".customers`)}
      WHERE  tenant_id  = ${tenantId}::uuid
      AND    deleted_at IS NULL
      ${searchFilter}
    `,
  ])

  return {
    customers: rows,
    total:     Number(countRows[0]?.total ?? 0),
    page,
    perPage,
  }
}

export interface CustomerSegments {
  frequent:   Customer[]
  occasional: Customer[]
  lapsed:     Customer[]
}

/**
 * Segment customers by purchase behaviour:
 * - frequent:   5+ visits total AND visited in last 30 days
 * - occasional: 1-4 visits OR visited within last 90 days
 * - lapsed:     last visit > 30 days ago
 */
export async function findCustomerSegments(
  schemaName: string,
  tenantId: string
): Promise<CustomerSegments> {
  const now          = new Date()
  const thirtyDays   = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const ninetyDays   = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)

  const [frequent, occasional, lapsed] = await Promise.all([
    db.$queryRaw<Customer[]>`
      SELECT ${Prisma.raw(CUSTOMER_SELECT)}
      FROM   ${Prisma.raw(`"${schemaName}".customers`)}
      WHERE  tenant_id        = ${tenantId}::uuid
      AND    deleted_at       IS NULL
      AND    visit_count      >= 5
      AND    last_visited_at  >= ${thirtyDays}
      ORDER  BY visit_count DESC
    `,
    db.$queryRaw<Customer[]>`
      SELECT ${Prisma.raw(CUSTOMER_SELECT)}
      FROM   ${Prisma.raw(`"${schemaName}".customers`)}
      WHERE  tenant_id       = ${tenantId}::uuid
      AND    deleted_at      IS NULL
      AND    visit_count     BETWEEN 1 AND 4
      AND    (last_visited_at IS NULL OR last_visited_at >= ${ninetyDays})
      ORDER  BY last_visited_at DESC NULLS LAST
    `,
    db.$queryRaw<Customer[]>`
      SELECT ${Prisma.raw(CUSTOMER_SELECT)}
      FROM   ${Prisma.raw(`"${schemaName}".customers`)}
      WHERE  tenant_id       = ${tenantId}::uuid
      AND    deleted_at      IS NULL
      AND    last_visited_at IS NOT NULL
      AND    last_visited_at < ${thirtyDays}
      ORDER  BY last_visited_at DESC
    `,
  ])

  return { frequent, occasional, lapsed }
}

/**
 * Record a customer visit when they appear in a sale.
 * Bumps visit_count, total_purchases, and last_visited_at.
 * Updates name only if the caller supplies one and the stored name is null.
 */
export async function recordCustomerVisit(
  schemaName: string,
  customerId: string,
  tenantId: string,
  purchaseAmount: number,
  name: string | null
): Promise<void> {
  await db.$executeRaw`
    UPDATE ${Prisma.raw(`"${schemaName}".customers`)}
    SET    total_purchases = total_purchases + ${purchaseAmount},
           visit_count     = visit_count + 1,
           last_visited_at = NOW(),
           name            = COALESCE(name, ${name}),
           updated_at      = NOW()
    WHERE  id        = ${customerId}::uuid
    AND    tenant_id = ${tenantId}::uuid
    AND    deleted_at IS NULL
  `
}

/**
 * Opt a customer out of marketing broadcasts (STOP keyword handler).
 */
export async function optOutMarketing(
  schemaName: string,
  tenantId: string,
  phone: string
): Promise<void> {
  await db.$executeRaw`
    UPDATE ${Prisma.raw(`"${schemaName}".customers`)}
    SET    opted_in_marketing = false,
           updated_at         = NOW()
    WHERE  phone     = ${phone}
    AND    tenant_id = ${tenantId}::uuid
    AND    deleted_at IS NULL
  `
}

/**
 * Opt a customer back in to marketing broadcasts (START keyword handler).
 */
export async function optInMarketing(
  schemaName: string,
  tenantId: string,
  phone: string
): Promise<void> {
  await db.$executeRaw`
    UPDATE ${Prisma.raw(`"${schemaName}".customers`)}
    SET    opted_in_marketing = true,
           updated_at         = NOW()
    WHERE  phone     = ${phone}
    AND    tenant_id = ${tenantId}::uuid
    AND    deleted_at IS NULL
  `
}

/**
 * Return all opted-in phones for a marketing broadcast.
 */
export async function findOptedInPhones(
  schemaName: string,
  tenantId: string
): Promise<string[]> {
  const rows = await db.$queryRaw<{ phone: string }[]>`
    SELECT phone
    FROM   ${Prisma.raw(`"${schemaName}".customers`)}
    WHERE  tenant_id          = ${tenantId}::uuid
    AND    deleted_at         IS NULL
    AND    opted_in_marketing = true
    AND    phone              IS NOT NULL
  `
  return rows.map(r => r.phone)
}

export async function softDeleteCustomer(
  schemaName: string,
  tenantId: string,
  customerId: string
): Promise<Customer | null> {
  const rows = await db.$queryRaw<Customer[]>`
    UPDATE ${Prisma.raw(`"${schemaName}".customers`)}
    SET    deleted_at = NOW(),
           updated_at = NOW()
    WHERE  id        = ${customerId}::uuid
    AND    tenant_id = ${tenantId}::uuid
    AND    deleted_at IS NULL
    RETURNING ${Prisma.raw(CUSTOMER_SELECT)}
  `
  return rows[0] ?? null
}

export async function updateCustomer(
  schemaName: string,
  tenantId: string,
  customerId: string,
  data: {
    name?:             string
    phone?:            string
    notes?:            string
    optedInMarketing?: boolean
  }
): Promise<Customer | null> {
  const setClauses: string[] = ['updated_at = NOW()']
  const values: unknown[]    = []
  let paramIdx = 1

  if (data.name !== undefined) {
    setClauses.push(`name = $${paramIdx++}`)
    values.push(data.name)
  }
  if (data.phone !== undefined) {
    setClauses.push(`phone = $${paramIdx++}`)
    values.push(data.phone)
  }
  if (data.notes !== undefined) {
    setClauses.push(`notes = $${paramIdx++}`)
    values.push(data.notes)
  }
  if (data.optedInMarketing !== undefined) {
    setClauses.push(`opted_in_marketing = $${paramIdx++}`)
    values.push(data.optedInMarketing)
  }

  const sql = `
    UPDATE "${schemaName}".customers
    SET    ${setClauses.join(', ')}
    WHERE  id        = $${paramIdx++}::uuid
    AND    tenant_id = $${paramIdx++}::uuid
    AND    deleted_at IS NULL
    RETURNING
      id::text,
      tenant_id::text        AS "tenantId",
      phone,
      name,
      total_purchases        AS "totalPurchases",
      visit_count            AS "visitCount",
      last_visited_at        AS "lastVisitedAt",
      opted_in_marketing     AS "optedInMarketing",
      notes,
      created_at             AS "createdAt",
      updated_at             AS "updatedAt",
      deleted_at             AS "deletedAt"
  `
  values.push(customerId, tenantId)

  const rows = await db.$queryRawUnsafe<Customer[]>(sql, ...values)
  return rows[0] ?? null
}

// ── Audit log (shared pattern) ─────────────────────────────────────────────────

export interface AuditLogEntry {
  tenantId:    string
  userPhone?:  string | null
  action:      string
  entityType?: string | null
  entityId?:   string | null
  oldValue?:   object | null
  newValue?:   object | null
  source?:     string | null
}

export async function insertAuditLog(
  schemaName: string,
  entry: AuditLogEntry
): Promise<void> {
  try {
    const userPhone  = entry.userPhone  ?? null
    const entityType = entry.entityType ?? null
    const entityId   = entry.entityId   ?? null
    const oldValue   = entry.oldValue   != null ? JSON.stringify(entry.oldValue) : null
    const newValue   = entry.newValue   != null ? JSON.stringify(entry.newValue) : null
    const source     = entry.source     ?? null

    await db.$executeRaw`
      INSERT INTO ${Prisma.raw(`"${schemaName}".audit_log`)}
        (tenant_id, user_phone, action, entity_type, entity_id, old_value, new_value, source)
      VALUES
        (${entry.tenantId}::uuid, ${userPhone}, ${entry.action},
         ${entityType}, ${entityId}::uuid,
         ${oldValue}::jsonb, ${newValue}::jsonb, ${source})
    `
  } catch (err) {
    logger.error({ event: 'audit_log_failed', action: entry.action, err })
  }
}
