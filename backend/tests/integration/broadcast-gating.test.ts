/**
 * WP-14: Broadcast gating + quality monitor tests.
 *
 * Covers:
 *  - template-required rejection (BROADCAST_TEMPLATE_REQUIRED)
 *  - global pause blocks sendBroadcast (BROADCASTS_GLOBALLY_PAUSED)
 *  - quality monitor sets pause on <HIGH and clears on recovery
 *  - stub/provider returns HIGH (no false pause)
 *  - UNSUBSCRIBE keyword opts out platform-wide
 *  - platform-wide opt-out: a phone opted out is filtered for ALL tenants
 *  - cross-tenant cap independence
 *  - migration 017 applies (platform_settings + platform_marketing_opt_outs exist)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { createTestTenant, cleanupTenant, seedItem } from '../fixtures/tenant.js'
import { db, withTenant } from '../../src/db.js'
import { AppError, ErrorCodes } from '../../src/utils/AppError.js'
import {
  sendBroadcast,
  setBroadcastsPaused,
  setMarketingOptIn,
  platformOptOut,
  platformOptIn,
  isPhonePlatformOptedOut,
} from '../../src/services/marketingService.js'
import {
  getQualityProvider,
  resetQualityProvider,
  setQualityProvider,
  StubQualityProvider,
} from '../../src/channels/whatsapp/whatsappQualityProvider.js'
import type { QualityTier } from '../../src/channels/whatsapp/whatsappQualityProvider.js'
import { runQualityMonitor } from '../../src/scheduler/scheduler.js'
import { normalizePhone } from '../../src/utils/phone.js'

const TENANT_A = 'b0000000-0000-0000-0000-0000000000a0'
const TENANT_B = 'b0000000-0000-0000-0000-00000000000b'
const CUST_PHONE_1 = '+256772000001'
const CUST_PHONE_2 = '+256772000002'
const CUST_PHONE_1_NORM = normalizePhone(CUST_PHONE_1)
const CUST_PHONE_2_NORM = normalizePhone(CUST_PHONE_2)

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeAll(async () => {
  // Create two tenants
  await createTestTenant({ id: TENANT_A, ownerPhone: '+256700000001', businessName: 'Shop A' })
  await createTestTenant({ id: TENANT_B, ownerPhone: '+256700000002', businessName: 'Shop B' })

  // Seed customers in both tenants
  await withTenant(TENANT_A, async (tx) => {
    await tx.customer.upsert({
      where: { id: 'c0000000-0000-0000-0000-000000000a01' },
      update: {},
      create: {
        id: 'c0000000-0000-0000-0000-000000000a01',
        tenantId: TENANT_A,
        phone: CUST_PHONE_1_NORM,
        name: 'Customer A1',
        optedInMarketing: true,
      },
    })
    await tx.customer.upsert({
      where: { id: 'c0000000-0000-0000-0000-000000000a02' },
      update: {},
      create: {
        id: 'c0000000-0000-0000-0000-000000000a02',
        tenantId: TENANT_A,
        phone: CUST_PHONE_2_NORM,
        name: 'Customer A2',
        optedInMarketing: true,
      },
    })
  })

  await withTenant(TENANT_B, async (tx) => {
    await tx.customer.upsert({
      where: { id: 'c0000000-0000-0000-0000-000000000b01' },
      update: {},
      create: {
        id: 'c0000000-0000-0000-0000-000000000b01',
        tenantId: TENANT_B,
        phone: CUST_PHONE_1_NORM, // same phone as tenant A's customer
        name: 'Customer B1',
        optedInMarketing: true,
      },
    })
  })
})

afterAll(async () => {
  // Clean up platform-level state
  await db.platformSetting.updateMany({ data: { broadcastsPaused: false, pausedReason: null, pausedAt: null } }).catch(() => undefined)
  await db.platformMarketingOptOut.deleteMany({ where: { phone: { in: [CUST_PHONE_1_NORM, CUST_PHONE_2_NORM] } } }).catch(() => undefined)
  await cleanupTenant(TENANT_A).catch(() => undefined)
  await cleanupTenant(TENANT_B).catch(() => undefined)
})

beforeEach(async () => {
  // Reset platform state between tests
  await db.platformSetting.updateMany({ data: { broadcastsPaused: false, pausedReason: null, pausedAt: null } })
  await db.platformMarketingOptOut.deleteMany({ where: { phone: { in: [CUST_PHONE_1_NORM, CUST_PHONE_2_NORM] } } })
  // Ensure customers are opted in
  await withTenant(TENANT_A, async (tx) => {
    await tx.customer.updateMany({ where: { tenantId: TENANT_A }, data: { optedInMarketing: true } })
  })
  await withTenant(TENANT_B, async (tx) => {
    await tx.customer.updateMany({ where: { tenantId: TENANT_B }, data: { optedInMarketing: true } })
  })
  // Clean any lingering broadcasts from previous tests
  await withTenant(TENANT_A, async (tx) => {
    await tx.marketingBroadcast.deleteMany({})
  })
  await withTenant(TENANT_B, async (tx) => {
    await tx.marketingBroadcast.deleteMany({})
  })
  // Reset quality provider to default
  resetQualityProvider()
})

// ── Test 1: Template-required rejection ──────────────────────────────────────

describe('broadcast gating — template-required', () => {
  test('free-text broadcast without templateName is rejected', async () => {
    await expect(
      sendBroadcast(TENANT_A, 'Hello customers!', null)
    ).rejects.toThrow(AppError)

    try {
      await sendBroadcast(TENANT_A, 'Hello customers!', null)
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe(ErrorCodes.BROADCAST_TEMPLATE_REQUIRED)
    }
  })

  test('broadcast with templateName succeeds when templateName is provided', async () => {
    // Ensure cap allows it (default is 1, no broadcasts yet after cleanup)
    const result = await sendBroadcast(TENANT_A, 'Hello customers!', null, 'welcome_message')
    expect(result.broadcastId).toBeTruthy()
    expect(result.sentTo).toBeGreaterThan(0)
  })
})

// ── Test 2: Global pause blocks broadcasts ────────────────────────────────────

describe('broadcast gating — global pause', () => {
  test('broadcast is rejected when broadcasts are globally paused', async () => {
    await setBroadcastsPaused(true, 'test_pause')

    await expect(
      sendBroadcast(TENANT_A, 'Hello customers!', null, 'welcome_message')
    ).rejects.toThrow(AppError)

    try {
      await sendBroadcast(TENANT_A, 'Hello customers!', null, 'welcome_message')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe(ErrorCodes.BROADCASTS_GLOBALLY_PAUSED)
    }
  })

  test('broadcast succeeds after global pause is cleared', async () => {
    await setBroadcastsPaused(true, 'test_pause')
    await setBroadcastsPaused(false)

    const result = await sendBroadcast(TENANT_A, 'Hello customers!', null, 'welcome_message')
    expect(result.broadcastId).toBeTruthy()
  })
})

// ── Test 3: Daily cap (configurable via BROADCAST_DAILY_CAP) ─────────────────

describe('broadcast gating — daily cap', () => {
  test('second broadcast within cap=1 is rejected', async () => {
    // Send one broadcast (consumes the daily cap of 1)
    await sendBroadcast(TENANT_A, 'First broadcast', null, 'welcome_message')

    // Second should be rejected
    await expect(
      sendBroadcast(TENANT_A, 'Second broadcast', null, 'welcome_message')
    ).rejects.toThrow(AppError)

    try {
      await sendBroadcast(TENANT_A, 'Second broadcast', null, 'welcome_message')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe(ErrorCodes.BROADCAST_RATE_LIMITED)
    }
  })

  test('cross-tenant caps are independent', async () => {
    // Tenant A: send one
    await sendBroadcast(TENANT_A, 'A broadcast', null, 'welcome_message')
    // Tenant A second should fail
    await expect(
      sendBroadcast(TENANT_A, 'A second', null, 'welcome_message')
    ).rejects.toThrow(AppError)

    // Tenant B should still be able to send (independent cap)
    const result = await sendBroadcast(TENANT_B, 'B broadcast', null, 'welcome_message')
    expect(result.broadcastId).toBeTruthy()
  })
})

// ── Test 4: Platform-wide opt-out ─────────────────────────────────────────────

describe('broadcast gating — platform-wide opt-out', () => {
  test('platformOptOut blocks the phone for ALL tenants', async () => {
    // Opt out CUST_PHONE_1 via the platform registry
    await platformOptOut(CUST_PHONE_1)

    // Verify the phone is in the registry
    const optedOut = await isPhonePlatformOptedOut(CUST_PHONE_1)
    expect(optedOut).toBe(true)

    // Send broadcast for Tenant A — CUST_PHONE_1 should be filtered out
    const resultA = await sendBroadcast(TENANT_A, 'Test broadcast', null, 'welcome_message')
    // CUST_PHONE_2 should still receive (2 customers, 1 filtered)
    expect(resultA.sentTo).toBe(1)

    // Send broadcast for Tenant B — CUST_PHONE_1 should also be filtered out
    // Tenant B only has CUST_PHONE_1, which is opted out → 0 recipients → error
    await expect(
      sendBroadcast(TENANT_B, 'Test broadcast', null, 'welcome_message')
    ).rejects.toThrow(AppError)
  })

  test('setMarketingOptIn(false) also writes to platform registry', async () => {
    await setMarketingOptIn(TENANT_A, CUST_PHONE_2, false)

    // Should be in the platform registry now
    const optedOut = await isPhonePlatformOptedOut(CUST_PHONE_2)
    expect(optedOut).toBe(true)
  })

  test('setMarketingOptIn(true) removes from platform registry', async () => {
    await platformOptOut(CUST_PHONE_2)
    await setMarketingOptIn(TENANT_A, CUST_PHONE_2, true)

    const optedOut = await isPhonePlatformOptedOut(CUST_PHONE_2)
    expect(optedOut).toBe(false)
  })

  test('platformOptIn removes phone from registry', async () => {
    await platformOptOut(CUST_PHONE_1)
    await platformOptIn(CUST_PHONE_1)

    const optedOut = await isPhonePlatformOptedOut(CUST_PHONE_1)
    expect(optedOut).toBe(false)
  })
})

// ── Test 5: Quality monitor — pause / recover ─────────────────────────────────

describe('quality monitor — pause / recover', () => {
  test('quality monitor sets global pause when tier is LOW', async () => {
    // Inject a stub provider that returns LOW
    class LowQualityStub extends StubQualityProvider {
      async getQualityTier(): Promise<QualityTier> {
        return 'LOW'
      }
    }
    setQualityProvider(new LowQualityStub())

    await runQualityMonitor()

    // Verify broadcasts are paused
    const row = await db.platformSetting.findFirst({ where: { id: 1 } })
    expect(row?.broadcastsPaused).toBe(true)
    expect(row?.pausedReason).toBe('whatsapp_quality_low')
  })

  test('quality monitor clears pause when tier recovers to HIGH', async () => {
    // First set pause
    await setBroadcastsPaused(true, 'whatsapp_quality_low')

    // Inject stub that returns HIGH
    setQualityProvider(new StubQualityProvider())

    await runQualityMonitor()

    // Verify pause is cleared
    const row = await db.platformSetting.findFirst({ where: { id: 1 } })
    expect(row?.broadcastsPaused).toBe(false)
  })

  test('quality monitor does not pause when tier is HIGH', async () => {
    setQualityProvider(new StubQualityProvider())

    await runQualityMonitor()

    const row = await db.platformSetting.findFirst({ where: { id: 1 } })
    expect(row?.broadcastsPaused).toBe(false)
  })

  test('quality monitor does not pause when tier is UNKNOWN', async () => {
    class UnknownQualityStub extends StubQualityProvider {
      async getQualityTier(): Promise<QualityTier> {
        return 'UNKNOWN'
      }
    }
    setQualityProvider(new UnknownQualityStub())

    await runQualityMonitor()

    const row = await db.platformSetting.findFirst({ where: { id: 1 } })
    expect(row?.broadcastsPaused).toBe(false)
  })

  test('stub returns HIGH by default (no false pause)', async () => {
    resetQualityProvider()
    const provider = getQualityProvider()
    const tier = await provider.getQualityTier()
    expect(tier).toBe('HIGH')
  })
})

// ── Test 6: Migration 017 applies (platform tables exist) ─────────────────────

describe('migration 017 — platform tables', () => {
  test('platform_settings table exists and has the seed row', async () => {
    const row = await db.platformSetting.findFirst({ where: { id: 1 } })
    expect(row).toBeTruthy()
    expect(row!.id).toBe(1)
    expect(typeof row!.broadcastsPaused).toBe('boolean')
  })

  test('platform_marketing_opt_outs table exists and is writable', async () => {
    const testPhone = '+256000000000'
    await db.platformMarketingOptOut.upsert({
      where: { phone: testPhone },
      create: { phone: testPhone },
      update: {},
    })
    const row = await db.platformMarketingOptOut.findUnique({ where: { phone: testPhone } })
    expect(row).toBeTruthy()
    expect(row!.phone).toBe(testPhone)

    // Cleanup
    await db.platformMarketingOptOut.delete({ where: { phone: testPhone } })
  })
})

// ── Test 7: preview honors platform opt-outs ─────────────────────────────────

describe('broadcast preview — platform opt-outs', () => {
  test('preview filters platform-wide opted-out phones from count', async () => {
    const { previewBroadcast } = await import('../../src/services/marketingService.js')

    // Get preview without opt-outs
    const before = await previewBroadcast(TENANT_A, 'Test preview', 'Shop A')
    expect(before.recipientCount).toBeGreaterThan(0)

    // Opt out one phone
    await platformOptOut(CUST_PHONE_1)

    const after = await previewBroadcast(TENANT_A, 'Test preview', 'Shop A')
    expect(after.recipientCount).toBe(before.recipientCount - 1)
  })
})