# Rule: Multi-tenant Data Isolation

## This rule is non-negotiable. Every query must filter by tenant.

## Pattern: tenant middleware
Every authenticated request must have req.tenantId set by middleware.

```typescript
// middleware/tenant.ts
export async function tenantMiddleware(
  req: Request, res: Response, next: NextFunction
) {
  const tenantId = req.user?.tenantId
  if (!tenantId) return res.status(403).json({ error: 'No tenant' })
  
  // Set schema for this request
  await db.$executeRaw`SET search_path TO ${tenantId}, public`
  req.tenantId = tenantId
  next()
}
```

## Pattern: repository always filters tenant
```typescript
// CORRECT
async findSales(tenantId: string, date: Date): Promise<Sale[]> {
  return db.sale.findMany({
    where: { tenantId, createdAt: { gte: date } }
  })
}

// WRONG — never do this
async findSales(date: Date): Promise<Sale[]> {
  return db.sale.findMany({ where: { createdAt: { gte: date } } })
}
```

## Schema creation on signup
```typescript
async function createTenantSchema(tenantId: string) {
  const schemaName = `tenant_${tenantId.replace(/-/g, '_')}`
  await db.$executeRaw`CREATE SCHEMA IF NOT EXISTS ${schemaName}`
  // Run all per-tenant migrations in new schema
  await runTenantMigrations(schemaName)
  return schemaName
}
```

## WhatsApp to tenant resolution
```typescript
async function getTenantFromPhone(phone: string): Promise<Tenant | null> {
  // Check if phone belongs to a registered user of any tenant
  return db.tenant.findFirst({
    where: { ownerPhone: phone }
    // Later: also check tenant.users table for multi-user
  })
}
```

## Rules Claude must follow
1. Never write a repository function without tenantId parameter
2. Never use findMany without a where clause containing tenantId
3. Never access public schema data from tenant context without explicit join
4. Never store one tenant's data in another tenant's schema
5. Always validate tenantId is a valid UUID before using in queries
