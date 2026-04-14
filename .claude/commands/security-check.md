# Command: /security-check

Scan the codebase for common security issues before any commit.

## Check list

### 1. Tenant isolation
- Every repository function has tenantId parameter
- No findMany without tenantId in where clause
- No raw SQL without tenant schema prefix

### 2. Authentication
- Every route (except /webhook and /health) has auth middleware
- JWT verification on every protected route
- Refresh token rotation implemented

### 3. Input validation
- Every POST/PUT endpoint has Zod validation
- Phone numbers normalized before storage
- Currency values are integers (no floats)

### 4. Secrets
- No API keys in source code
- No hardcoded passwords or tokens
- All secrets in process.env
- .env never committed (check .gitignore)

### 5. SQL injection
- No string concatenation in queries
- Only Prisma parameterized queries
- No raw SQL unless absolutely necessary

### 6. WhatsApp webhook
- Verify Meta webhook signature on every request
- Rate limit: max 60 messages/minute per phone

### 7. MTN MoMo
- Never log payment credentials
- Verify callback authenticity
- Never trust client-reported payment amounts

## How to run
Scan each file and report issues with file path and line number.
Do not auto-fix security issues — report only and ask for confirmation.
