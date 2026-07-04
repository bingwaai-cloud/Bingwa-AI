/**
 * dbSecurityAssertions.test.ts — Unit tests for assertProductionDbSecurity.
 *
 * Mocks db.$queryRaw to simulate RLS/audit privilege states without a
 * live DB connection. Kept separate from the integration runner tests
 * (tests/integration/apply-migrations.test.ts) to avoid mock leakage.
 */
import { jest } from '@jest/globals'

type QueryRawMock = () => Promise<unknown[]>

const mockQueryRaw = jest.fn<QueryRawMock>()
jest.unstable_mockModule('../../../src/db.js', () => ({
  db: {
    $queryRaw: mockQueryRaw,
  },
}))

describe('assertProductionDbSecurity', () => {
  let assertProductionDbSecurity: () => Promise<void>

  beforeAll(async () => {
    const mod = await import('../../../src/utils/dbSecurityAssertions.js')
    assertProductionDbSecurity = mod.assertProductionDbSecurity
  })

  beforeEach(() => {
    mockQueryRaw.mockReset()
  })

  it('resolves when RLS is enabled and audit UPDATE is revoked', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([{ relrowsecurity: true }])
      .mockResolvedValueOnce([{ has_priv: false }])

    await expect(assertProductionDbSecurity()).resolves.toBeUndefined()
  })

  it('throws when RLS is NOT enabled on sales (no row)', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([])

    await expect(assertProductionDbSecurity()).rejects.toThrow(
      'RLS is NOT enabled on public.sales'
    )
  })

  it('throws when RLS is disabled (relrowsecurity=false)', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([{ relrowsecurity: false }])

    await expect(assertProductionDbSecurity()).rejects.toThrow(
      'RLS is NOT enabled on public.sales'
    )
  })

  it('throws when gezi_app still has UPDATE on audit_log', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([{ relrowsecurity: true }])
      .mockResolvedValueOnce([{ has_priv: true }])

    await expect(assertProductionDbSecurity()).rejects.toThrow(
      'gezi_app still has UPDATE on public.audit_log'
    )
  })
})