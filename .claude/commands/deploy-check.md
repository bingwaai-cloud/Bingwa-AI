# Command: /deploy-check

Run the full pre-deployment checklist before pushing to production.

## What to check automatically

### 1. TypeScript
Run: `npm run typecheck`
Must pass with zero errors.

### 2. Tests
Run: `npm test`
Must pass with zero failures.
Report: total tests, coverage percentage.

### 3. Security scan
Run: /security-check
Report any issues found.

### 4. Dependency audit
Run: `npm audit`
Fail if any HIGH or CRITICAL vulnerabilities found.

### 5. Environment variables
Check .env.example has ALL variables that code references via process.env
Report any undocumented env vars.

### 6. Lint
Run: `npm run lint`
Must pass with zero errors (warnings allowed).

### 7. Migration check
Check if any pending migrations exist.
Remind developer to run `npm run migrate:prod` before/during deploy.

### 8. Health endpoint
If server is running: GET /api/health → must return 200.

## Final output
```
✅ TypeScript: PASS
✅ Tests: 47 passed, 0 failed
✅ Security: No critical issues
✅ Audit: Clean
✅ Lint: Clean
⚠️  Migrations: 1 pending (run migrate:prod during deploy)
✅ Health: OK

READY TO DEPLOY ✅
```

Or:
```
❌ Tests: 3 failing — fix before deploying
DO NOT DEPLOY ❌
```
