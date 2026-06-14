import request from 'supertest'
import type { Express } from 'express'
import type { Prisma } from '@prisma/client'
import { createApp } from '../../src/app.js'
import { db, withTenant } from '../../src/db.js'
import {
  confirmAndCommitDraft,
  createDraft,
  requestDraftClarification,
  resolvePendingDraftMessage,
} from '../../src/services/draftsService.js'
import { findPendingDraftForPhone } from '../../src/repositories/draftsRepository.js'
import {
  cleanupTenant,
  createTestTenant,
  makeToken,
  seedItem,
  type TestTenant,
} from '../fixtures/tenant.js'
import type { ParsedIntent } from '../../src/nlp/types.js'

const A_ID = 'd1b2c3d4-0000-0000-0000-0000000000a1'
const B_ID = 'd1b2c3d4-0000-0000-0000-0000000000b1'
const ITEM_ID = 'd1b2c3d4-0000-0000-0000-0000000000a2'
const PHONE_A = '+256700000401'
const PHONE_B = '+256700000402'

function saleIntent(overrides: Partial<ParsedIntent> = {}): ParsedIntent {
  return {
    action: 'sale',
    item: 'Sugar',
    itemNormalized: 'sugar',
    qty: 2,
    unit: 'kg',
    unitPrice: null,
    totalPrice: null,
    confidence: 0.6,
    needsClarification: true,
    clarificationQuestion: 'What was the price for Sugar?',
    supplierName: null,
    customerPhone: null,
    customerName: null,
    expenseName: null,
    period: null,
    anomaly: false,
    anomalyReason: null,
    notes: null,
    ...overrides,
  }
}

describe('Draft transactions', () => {
  let app: Express
  let tenantA: TestTenant
  let tenantB: TestTenant
  let tokenA: string

  beforeAll(async () => {
    app = createApp()
    await cleanupTenant(A_ID)
    await cleanupTenant(B_ID)
    tenantA = await createTestTenant({ id: A_ID, ownerPhone: PHONE_A, businessName: 'Draft Shop A' })
    tenantB = await createTestTenant({ id: B_ID, ownerPhone: PHONE_B, businessName: 'Draft Shop B' })
    tokenA = makeToken(tenantA)
    await seedItem(A_ID, {
      id: ITEM_ID,
      name: 'Sugar',
      unit: 'kg',
      qtyInStock: 20,
      typicalSellPrice: 6500,
    })
  })

  beforeEach(async () => {
    await withTenant(A_ID, async (tx) => {
      await tx.draftTransaction.deleteMany({})
      await tx.receipt.deleteMany({})
      await tx.priceHistory.deleteMany({})
      await tx.sale.deleteMany({})
      await tx.purchase.deleteMany({})
      await tx.auditLog.deleteMany({})
      await tx.expense.deleteMany({})
      await tx.item.update({ where: { id: ITEM_ID }, data: { qtyInStock: 20 } })
    })
    await withTenant(B_ID, (tx) => tx.draftTransaction.deleteMany({}))
  })

  afterAll(async () => {
    await cleanupTenant(A_ID)
    await cleanupTenant(B_ID)
    await db.$disconnect()
  })

  it('persists an ambiguous conversation across a new DB connection and commits the sale from the reply', async () => {
    const pending = await createDraft(A_ID, {
      userPhone: PHONE_A,
      action: 'sale',
      payload: saleIntent(),
      state: 'pending_clarification',
      clarificationQuestion: 'What was the price for Sugar?',
    })
    expect(pending.state).toBe('pending_clarification')

    // Simulate a process/connection restart: no in-memory conversation state survives this.
    await db.$disconnect()

    const result = await resolvePendingDraftMessage(A_ID, PHONE_A, '6500 each')
    expect(result?.draft.state).toBe('committed')
    expect(result?.committedEntityType).toBe('sale')

    const persisted = await withTenant(A_ID, async (tx) => {
      const draft = await tx.draftTransaction.findFirst({ where: { id: pending.id, tenantId: A_ID } })
      const sale = await tx.sale.findFirst({ where: { id: result?.committedEntityId, tenantId: A_ID } })
      return { draft, sale }
    })
    expect(persisted.draft?.committedEntityId).toBe(result?.committedEntityId)
    expect(persisted.sale?.unitPrice).toBe(6500)
    expect(persisted.sale?.totalPrice).toBe(13000)
  })

  it('GET /api/v1/drafts returns the open WhatsApp draft with pagination metadata', async () => {
    const pending = await createDraft(A_ID, {
      userPhone: PHONE_A,
      action: 'sale',
      payload: saleIntent(),
      state: 'pending_clarification',
      clarificationQuestion: 'What was the price for Sugar?',
    })

    const res = await request(app)
      .get('/api/v1/drafts')
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: pending.id })]))
    expect(res.body.meta).toEqual(expect.objectContaining({ total: 1, page: 1, perPage: 20 }))
  })

  it('POST /api/v1/drafts creates an open draft', async () => {
    const res = await request(app)
      .post('/api/v1/drafts')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        userPhone: PHONE_A,
        action: 'sale',
        payload: saleIntent({ needsClarification: false, clarificationQuestion: null }),
      })

    expect(res.status).toBe(201)
    expect(res.body.data.state).toBe('parsed')
    expect(res.body.data.tenantId).toBe(A_ID)
  })

  it('rejects every mutation of a committed draft with AppError 422', async () => {
    const draft = await createDraft(A_ID, {
      userPhone: PHONE_A,
      action: 'sale',
      payload: saleIntent({
        unitPrice: 6500,
        totalPrice: 13000,
        needsClarification: false,
        clarificationQuestion: null,
      }),
    })
    const committed = await confirmAndCommitDraft(A_ID, draft.id)
    expect(committed.draft.state).toBe('committed')

    const amend = await request(app)
      .post(`/api/v1/drafts/${draft.id}/amend`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ payload: saleIntent({ unitPrice: 7000, totalPrice: 14000 }) })
    const cancel = await request(app)
      .post(`/api/v1/drafts/${draft.id}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({})
    const confirm = await request(app)
      .post(`/api/v1/drafts/${draft.id}/confirm`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({})

    for (const res of [amend, cancel, confirm]) {
      expect(res.status).toBe(422)
      expect(res.body.error.code).toBe('ILLEGAL_DRAFT_TRANSITION')
    }
  })

  it('rejects transitions outside the exact legal transition set', async () => {
    const draft = await createDraft(A_ID, {
      userPhone: PHONE_A,
      action: 'sale',
      payload: saleIntent(),
    })
    await requestDraftClarification(A_ID, draft.id, 'What was the price?')
    await expect(requestDraftClarification(A_ID, draft.id, 'Again?')).rejects.toMatchObject({
      statusCode: 422,
      code: 'ILLEGAL_DRAFT_TRANSITION',
    })
  })

  it('commits a purchase and draft in the same tenant transaction', async () => {
    const draft = await createDraft(A_ID, {
      userPhone: PHONE_A,
      action: 'purchase',
      payload: saleIntent({
        action: 'purchase',
        unitPrice: 5000,
        totalPrice: 10000,
        needsClarification: false,
        clarificationQuestion: null,
      }),
    })

    const result = await confirmAndCommitDraft(A_ID, draft.id)
    const persisted = await withTenant(A_ID, async (tx) => {
      const savedDraft = await tx.draftTransaction.findFirst({ where: { id: draft.id, tenantId: A_ID } })
      const purchase = await tx.purchase.findFirst({ where: { id: result.committedEntityId, tenantId: A_ID } })
      return { savedDraft, purchase }
    })

    expect(result.committedEntityType).toBe('purchase')
    expect(persisted.savedDraft?.state).toBe('committed')
    expect(persisted.savedDraft?.committedEntityId).toBe(persisted.purchase?.id)
  })

  it('rolls back confirmation when the real financial write fails', async () => {
    const draft = await createDraft(A_ID, {
      userPhone: PHONE_A,
      action: 'sale',
      payload: saleIntent({
        qty: 100,
        unitPrice: 6500,
        totalPrice: 650000,
        needsClarification: false,
        clarificationQuestion: null,
      }),
    })

    await expect(confirmAndCommitDraft(A_ID, draft.id)).rejects.toMatchObject({
      statusCode: 422,
      code: 'INSUFFICIENT_STOCK',
    })

    const persisted = await withTenant(A_ID, (tx) =>
      tx.draftTransaction.findFirst({ where: { id: draft.id, tenantId: A_ID } })
    )
    expect(persisted?.state).toBe('parsed')
    expect(persisted?.committedEntityId).toBeNull()
  })

  it('commits an expense clarification through the same draft state machine', async () => {
    const draft = await createDraft(A_ID, {
      userPhone: PHONE_A,
      action: 'expense',
      payload: saleIntent({
        action: 'expense',
        item: null,
        itemNormalized: null,
        qty: null,
        expenseName: 'Rent',
        clarificationQuestion: 'How much was the rent?',
      }),
      state: 'pending_clarification',
      clarificationQuestion: 'How much was the rent?',
    })

    const result = await resolvePendingDraftMessage(A_ID, PHONE_A, '800k')
    const expense = await withTenant(A_ID, (tx) =>
      tx.expense.findFirst({ where: { id: result?.committedEntityId, tenantId: A_ID } })
    )

    expect(result?.committedEntityType).toBe('expense')
    expect(result?.draft.state).toBe('committed')
    expect(expense?.amountUgx).toBe(800000)
  })

  it('denies cross-tenant draft reads, mutations, and writes', async () => {
    const bDraft = await createDraft(B_ID, {
      userPhone: PHONE_B,
      action: 'sale',
      payload: saleIntent(),
      state: 'pending_clarification',
      clarificationQuestion: 'What was the price?',
    })

    const hidden = await withTenant(A_ID, (tx) => findPendingDraftForPhone(tx, A_ID, PHONE_B))
    expect(hidden).toBeNull()

    const listAsA = await request(app)
      .get('/api/v1/drafts')
      .set('Authorization', `Bearer ${tokenA}`)
    expect(listAsA.body.data).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: bDraft.id })]))

    const cancelAsA = await request(app)
      .post(`/api/v1/drafts/${bDraft.id}/cancel`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({})
    expect(cancelAsA.status).toBe(404)

    await expect(
      withTenant(A_ID, (tx) =>
        tx.draftTransaction.create({
          data: {
            tenantId: B_ID,
            userPhone: PHONE_B,
            action: 'sale',
            payload: saleIntent() as unknown as Prisma.InputJsonValue,
            state: 'parsed',
            expiresAt: new Date(Date.now() + 60_000),
          },
        })
      )
    ).rejects.toThrow()
  })
})
