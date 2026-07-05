# PROMPT WP-21b — Backend gap-fill for the web views (then re-point the web)

```
ROLE: Implement ONE backend work package in the Gezi AI repo (Node/Express/TS
strict/Prisma/Postgres row-level RLS, multi-tenant Uganda ERP). The web read-only
views (WP-20/21) are wired to existing endpoints but several backend gaps leave
screens degraded or aggregating partial data. Fill the real gaps, then re-point
the web views to the new endpoints. NO new vendors, NO 2FA (that's WP-22).

BINDING (read first): CLAUDE.md, .claude/rules/api-design.md (envelope,
pagination, ≤90-day range filters), .claude/rules/multi-tenant.md (every query
tenant-scoped via withTenant; RLS), .claude/rules/testing.md.

PROCESS (B1): plan ≤8 lines (endpoints, files, tests) → WAIT for my OK →
implement in small commits → npm run typecheck && npm test (real output) →
report. HARD RULES: money = integer UGX; every query tenant-scoped; no
$executeRawUnsafe; repository pattern; Zod on every input; no business logic in
channels/. Done = tests green, not "should work".

────────────────────────────────────────────────────────────────────────────
SCOPE — backend endpoints (no DB migration needed; these are query additions):

1. INVENTORY pagination + search (api-design.md violation today: handleListItems
   returns ALL items unbounded).
   - GET /api/v1/inventory?page=&perPage=&search=&sortBy=&sortOrder=
   - Paginate (default perPage 20, max 100) with meta {total, page, perPage}.
   - Optional ?search= : tenant-scoped name match. Use the SAME matching policy as
     the rest of the app — pg_trgm / ILIKE on name_normalized, NOT substring-
     contains (CLAUDE.md lesson). Keep lowStockCount in meta.
   - Update listItems() repo signature; keep it backward-compatible or update all
     callers (echoBot etc.) — run typecheck to catch them.

2. CUSTOMERS purchase history (missing endpoint → web drill-down is dead).
   - GET /api/v1/customers/:id/purchases?page=&perPage=&from=&to=
   - Returns that customer's sales (tenant-scoped, paginated, ≤90-day range cap
     like other list endpoints). Validate :id is a uuid + belongs to tenant.

3. REPORTS aggregation (Reports currently client-aggregates paginated lists →
   partial/incorrect totals at volume). Add SERVER-side aggregation:
   - GET /api/v1/sales/summary?from=&to=&groupBy=day|week|month
   - GET /api/v1/purchases/summary?from=&to=&groupBy=day|week|month
   - Each returns typed buckets {periodStart, totalUgx (int), count} +
     grand totals. Tenant-scoped, ≤90-day range enforced, integer UGX only.
   - These let the web Reports page request aggregates instead of fetching every
     page of raw rows.

4. (Optional, only if cheap) inventory last-sold: include lastSoldAt per item in
   the inventory payload via a correlated latest-sale lookup. If it adds notable
   query cost, SKIP and flag — do not ship an N+1.

────────────────────────────────────────────────────────────────────────────
THEN — re-point the web views (web/, small follow-up, same session):
- Inventory page: use server pagination + the search param (remove the local-
  pagination stopgap); keep graceful empty/blank states.
- Customers page: wire the drill-down to GET /customers/:id/purchases (remove the
  "backend gap" placeholder).
- Reports page: consume /sales/summary + /purchases/summary instead of client-
  aggregating raw lists. Charts stay lazy-loaded; bundle stays ≤200KB gz.
- All strings via i18n; web calls /api/v1 only (channel-thin).

────────────────────────────────────────────────────────────────────────────
TESTS (required):
- Integration: each new/changed endpoint — happy path + pagination + ≤90-day
  range rejection + cross-tenant denial (tenant A cannot read tenant B's
  customer purchases / inventory / summaries), both via API and repository.
- Summary correctness: a seeded multi-day dataset aggregates to the right
  per-bucket and grand totals (integer UGX).
- Web: inventory pagination/search, customers drill-down, reports reads summary.

GATE: npm run typecheck && npx tsc -p tsconfig.test.json --noEmit && (fresh DB)
npm test -- --runInBand ; grep -rn executeRawUnsafe backend/src (empty).
In web/: npm run typecheck && npm run test && npm run build (bundle ≤200KB gz).

DONE report: each new endpoint with its route + a cross-tenant denial test green;
confirm inventory is now backend-paginated; Reports reads server aggregates (no
client-side full-list aggregation left); web bundle size; full test totals.
Commit per coherent step; branch wp-21b-gapfill; push branch + open for review.
NOTE explicitly: 2FA and requireRole RBAC are NOT in this WP (WP-22).
```
