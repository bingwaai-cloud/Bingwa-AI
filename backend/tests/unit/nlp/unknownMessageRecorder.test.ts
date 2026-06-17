/**
 * Unit/integration tests for unknown message recorder (WP-9b Part 3).
 *
 * Uses the real test DB. Verifies:
 *  1. Writes a row for action:unknown
 *  2. Does NOT write for action:sale
 *  3. Swallows DB errors silently
 *  4. Cross-tenant denial: tenant A cannot read tenant B's unknown_messages rows
 */

import { db, withTenant } from '../../../src/db.js'
import { recordUnknownMessage } from '../../../src/nlp/unknownMessageRecorder.js'
import { createTestTenant, cleanupTenant } from '../../fixtures/tenant.js'
import type { TestTenant } from '../../fixtures/tenant.js'
import type { ParsedIntent } from '../../../src/nlp/types.js'

function makeIntent(overrides: Partial<ParsedIntent> = {}): ParsedIntent {
  return {
    action: 'unknown',
    items: [],
    confidence: 0,
    resolution: 'clarify',
    clarificationQuestion: "Sorry, I didn't understand.",
    supplierName: null,
    customerPhone: null,
    customerName: null,
    expenseName: null,
    period: null,
    notes: null,
    ...overrides,
  }
}

describe('recordUnknownMessage', () => {
  let tenantA: TestTenant
  let tenantB: TestTenant

  beforeAll(async () => {
    tenantA = await createTestTenant({
      id: '40000000-0000-0000-0000-0000000000a1',
      ownerPhone: '+256772000401',
      businessName: 'Unknown Msg Tenant A',
    })
    tenantB = await createTestTenant({
      id: '40000000-0000-0000-0000-0000000000b2',
      ownerPhone: '+256772000402',
      businessName: 'Unknown Msg Tenant B',
    })
  })

  afterAll(async () => {
    await cleanupTenant(tenantA.tenantId)
    await cleanupTenant(tenantB.tenantId)
  })

  beforeEach(async () => {
    await withTenant(tenantA.tenantId, async (tx) => {
      await tx.unknownMessage.deleteMany({})
    })
    await withTenant(tenantB.tenantId, async (tx) => {
      await tx.unknownMessage.deleteMany({})
    })
  })

  it('writes a row for action:unknown', async () => {
    await recordUnknownMessage(
      {
        tenantId: tenantA.tenantId,
        message: 'give me something random abc123',
        rawNlpOutput: makeIntent({ action: 'unknown' }),
        source: 'whatsapp',
      },
      db
    )

    const rows = await withTenant(tenantA.tenantId, async (tx) => {
      return tx.unknownMessage.findMany({ where: { tenantId: tenantA.tenantId } })
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.message).toBe('give me something random abc123')
    expect(rows[0]!.source).toBe('whatsapp')
    expect(rows[0]!.rawNlpOutput).toBeDefined()
  })

  it('does NOT write for action:sale', async () => {
    await recordUnknownMessage(
      {
        tenantId: tenantA.tenantId,
        message: 'sold 2 sugar 6k',
        rawNlpOutput: makeIntent({ action: 'sale' }),
        source: 'whatsapp',
      },
      db
    )

    const rows = await withTenant(tenantA.tenantId, async (tx) => {
      return tx.unknownMessage.findMany({ where: { tenantId: tenantA.tenantId } })
    })

    expect(rows).toHaveLength(0)
  })

  it('swallows DB errors silently', async () => {
    // Provoke an error by passing an invalid tenantId (not a valid UUID)
    // The function must not throw.
    await expect(
      recordUnknownMessage(
        {
          tenantId: 'not-a-uuid',
          message: 'should fail',
          rawNlpOutput: makeIntent({ action: 'unknown' }),
          source: 'whatsapp',
        },
        db
      )
    ).resolves.toBeUndefined()
  })

  it('cross-tenant denial: tenant A cannot read tenant B rows', async () => {
    // Write from tenant B's perspective (but using tenant A's ID for the test)
    await recordUnknownMessage(
      {
        tenantId: tenantB.tenantId,
        message: 'tenant B unknown message',
        rawNlpOutput: makeIntent({ action: 'unknown' }),
        source: 'whatsapp',
      },
      db
    )

    // Tenant A should NOT see tenant B's unknown_messages
    const rowsA = await withTenant(tenantA.tenantId, async (tx) => {
      return tx.unknownMessage.findMany({})
    })

    expect(rowsA).toHaveLength(0)

    // Tenant B SHOULD see its own rows
    const rowsB = await withTenant(tenantB.tenantId, async (tx) => {
      return tx.unknownMessage.findMany({ where: { tenantId: tenantB.tenantId } })
    })

    expect(rowsB).toHaveLength(1)
  })
})