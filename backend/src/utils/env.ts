/**
 * Validates environment variables at startup.
 *
 * Hard-required (always): DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET.
 * Process exits immediately if any are missing; server cannot function without them.
 *
 * Soft-required: ANTHROPIC_API_KEY, WhatsApp Meta defaults, API_URL.
 * These warn but do not stop the server so health checks can still report status.
 *
 * Conditional-required: selected providers must be fully configured.
 */
export function validateEnv(): void {
  const isRailway = Boolean(
    process.env['RAILWAY_PROJECT_ID'] ??
    process.env['RAILWAY_ENVIRONMENT_ID'] ??
    process.env['RAILWAY_SERVICE_ID']
  )

  const allVars = [
    'NODE_ENV', 'PORT', 'DATABASE_URL',
    'JWT_SECRET', 'JWT_REFRESH_SECRET',
    'ANTHROPIC_API_KEY',
    'WA_PROVIDER',
    'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET',
    'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN',
    'D360_API_KEY', 'D360_BASE_URL', 'D360_WEBHOOK_SECRET',
    'API_URL', 'WEB_ORIGINS', 'REPO_URL',
    'MTN_MOMO_SUBSCRIPTION_KEY',
    'PAYMENT_PROVIDER',
    'XENTE_BASE_URL', 'XENTE_APP_KEY', 'XENTE_APP_PASSWORD', 'XENTE_USER_ID',
    'XENTE_IPN_ALLOWED_IPS', 'XENTE_IPN_PATH_TOKEN',
    'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID',
  ]

  const present = allVars.filter((k) => !!process.env[k])
  const absent  = allVars.filter((k) => !process.env[k])

  console.log(`[startup] Environment: NODE_ENV=${process.env['NODE_ENV'] ?? 'unset'}, Railway=${isRailway}`)
  console.log(`[startup] Present vars: ${present.join(', ')}`)
  if (absent.length) {
    console.log(`[startup] Absent vars:  ${absent.join(', ')}`)
  }

  const critical = ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET']
  const missingCritical = critical.filter((k) => !process.env[k])

  if (missingCritical.length > 0) {
    console.error(`[startup] FATAL - missing critical env vars: ${missingCritical.join(', ')}`)
    process.exit(1)
  }

  // WP-17 L-1: in production, reject weak or placeholder JWT secrets. A 256-bit
  // secret is ~32+ characters; the .env.example placeholders must never reach
  // production. Presence alone (above) is not enough for a financial system.
  if (process.env['NODE_ENV'] === 'production') {
    const JWT_PLACEHOLDERS = new Set([
      'change-this-to-a-long-random-string',
      'change-this-too',
    ])
    const weakJwt = (['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const).filter((k) => {
      const v = process.env[k] ?? ''
      return v.length < 32 || JWT_PLACEHOLDERS.has(v)
    })
    if (weakJwt.length > 0) {
      console.error(
        `[startup] FATAL - weak JWT secret(s) in production (need >=32 random chars, not a placeholder): ${weakJwt.join(', ')}`
      )
      process.exit(1)
    }
  }

  const waProvider = process.env['WA_PROVIDER'] ?? 'meta'
  if (waProvider !== 'meta' && waProvider !== '360dialog') {
    console.error(`[startup] FATAL - WA_PROVIDER must be one of: meta, 360dialog`)
    process.exit(1)
  }

  const softRequired = [
    'ANTHROPIC_API_KEY',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_VERIFY_TOKEN',
    'API_URL',
  ]

  const missingSoft = softRequired.filter((k) => !process.env[k])
  if (missingSoft.length > 0) {
    console.warn(`[startup] WARNING - missing optional vars (features degraded): ${missingSoft.join(', ')}`)
  }

  if (waProvider === '360dialog') {
    const d360Required = ['D360_API_KEY', 'D360_WEBHOOK_SECRET']
    const missingD360 = d360Required.filter((k) => !process.env[k])
    if (missingD360.length > 0) {
      console.error(`[startup] FATAL - WA_PROVIDER=360dialog but missing: ${missingD360.join(', ')}`)
      process.exit(1)
    }
  }

  if ((process.env['PAYMENT_PROVIDER'] ?? 'legacy') === 'flutterwave') {
    const flwRequired = ['FLW_SECRET_KEY', 'FLW_PUBLIC_KEY', 'FLW_WEBHOOK_HASH', 'FLW_ENCRYPTION_KEY']
    const missingFlw = flwRequired.filter((k) => !process.env[k])
    if (missingFlw.length > 0) {
      console.error(`[startup] FATAL - PAYMENT_PROVIDER=flutterwave but missing: ${missingFlw.join(', ')}`)
      process.exit(1)
    }
  }

  // WP-25: Xente cutover. XENTE_BASE_URL has a default (https://api.xente.co);
  // everything else is fail-fast required — especially the IPN auth pair
  // (allowlist + path token): Xente sends no signature, so a missing value
  // here would mean an unauthenticated money webhook. Never boot like that.
  if ((process.env['PAYMENT_PROVIDER'] ?? 'legacy') === 'xente') {
    const xenteRequired = [
      'XENTE_APP_KEY',
      'XENTE_APP_PASSWORD',
      'XENTE_USER_ID',
      'XENTE_IPN_ALLOWED_IPS',
      'XENTE_IPN_PATH_TOKEN',
    ]
    const missingXente = xenteRequired.filter((k) => !process.env[k])
    if (missingXente.length > 0) {
      console.error(`[startup] FATAL - PAYMENT_PROVIDER=xente but missing: ${missingXente.join(', ')}`)
      process.exit(1)
    }
  }
}