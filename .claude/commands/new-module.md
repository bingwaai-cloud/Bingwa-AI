# Command: /new-module

Scaffold a complete new ERP module for Bingwa AI.

## Usage
/new-module [module-name]
Example: /new-module suppliers

## What to generate

### 1. Route file
`backend/src/routes/[module].routes.ts`
- GET /api/[module] — list
- GET /api/[module]/:id — single
- POST /api/[module] — create
- PUT /api/[module]/:id — update
- DELETE /api/[module]/:id — soft delete

### 2. Controller file
`backend/src/controllers/[module].controller.ts`
- One function per route
- Input validation with Zod
- Call service layer only, no business logic here
- Standard response format:
  ```typescript
  res.json({ success: true, data: result })
  res.status(400).json({ success: false, error: message })
  ```

### 3. Service file
`backend/src/services/[module].service.ts`
- All business logic lives here
- Calls repository only for data access
- Handles audit logging
- Returns typed results

### 4. Repository file
`backend/src/repositories/[module].repository.ts`
- All database queries
- Always filter by tenantId
- Use Prisma client
- No business logic

### 5. Types file
`backend/src/types/[module].types.ts`
- Zod schemas for input validation
- TypeScript interfaces for data shapes
- Export inferred types from Zod schemas

### 6. Test file
`backend/tests/[module].test.ts`
- At least 5 test cases
- Test happy path
- Test validation errors
- Test tenant isolation
- Use Jest + Supertest

### 7. Migration file
`backend/db/migrations/[NNN]_add_[module]_table.sql`
- Numbered sequentially
- Always include: id, tenant_id, created_at, updated_at, deleted_at

## Standard patterns to follow
- See existing sales module as reference
- Always add to audit_log on create/update/delete
- Always soft delete (set deleted_at, never DELETE FROM)
- Always validate tenant owns the resource before update/delete
