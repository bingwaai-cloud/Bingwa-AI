/**
 * Quick NLP smoke test — run with:
 *   npx tsx scripts/testNlp.ts
 *
 * Tests the intent parser against real Ugandan business messages
 * without needing WhatsApp or a running server.
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ override: true })
import { parseIntent } from '../src/nlp/intentParser.js'
import { formatUGX } from '../src/nlp/normalizers.js'
import type { UserContext } from '../src/nlp/types.js'

const mockContext: UserContext = {
  tenantId: 'test-tenant-id',
  schemaName: 'tenant_test',
  userPhone: '+256772000001',
  tenant: {
    businessName: 'Mama Rose General Store',
    businessType: 'retail',
    ownerName: 'Rose Nakato',
    currency: 'UGX',
    country: 'UG',
  },
  items: [
    {
      id: 'item-1',
      name: 'Sugar',
      nameNormalized: 'sugar',
      aliases: ['sukari', 'shuga'],
      unit: 'bag',
      qtyInStock: 20,
      lowStockThreshold: 5,
      typicalBuyPrice: 5500,
      typicalSellPrice: 7000,
    },
    {
      id: 'item-2',
      name: 'Maize Flour',
      nameNormalized: 'maize flour',
      aliases: ['unga', 'posho', 'flour'],
      unit: 'bag',
      qtyInStock: 15,
      lowStockThreshold: 3,
      typicalBuyPrice: 65000,
      typicalSellPrice: 75000,
    },
    {
      id: 'item-3',
      name: 'Gumboots',
      nameNormalized: 'gumboots',
      aliases: [],
      unit: 'pair',
      qtyInStock: 8,
      lowStockThreshold: 2,
      typicalBuyPrice: 25000,
      typicalSellPrice: 35000,
    },
  ],
  recentInteractions: [],
  onboardingStep: 0,
  onboardingComplete: true,
  preferences: {},
}

const testMessages = [
  'sold 2 gumboots at 70k total',
  'nimeuza sukari 3 bags at 6500 each',
  'bought 10 bags flour from Ali at 65000 each',
  'how much sugar do i have',
  'report',
  'add item Cooking Oil, 20 litres, sell price 8000',
  'sold 2 sugar 3000', // ambiguous — unit or total?
  'nimepata posho 5 bags 70k',
]

console.log('🧠 Bingwa AI — NLP Smoke Test\n' + '='.repeat(50))

for (const msg of testMessages) {
  console.log(`\n📩 "${msg}"`)
  const start = Date.now()
  const result = await parseIntent(msg, mockContext)
  const elapsed = Date.now() - start

  console.log(`   action    : ${result.action}`)
  console.log(`   item      : ${result.item ?? '—'}`)
  console.log(`   qty       : ${result.qty ?? '—'}`)
  console.log(`   unitPrice : ${result.unitPrice != null ? formatUGX(result.unitPrice) : '—'}`)
  console.log(`   total     : ${result.totalPrice != null ? formatUGX(result.totalPrice) : '—'}`)
  console.log(`   confidence: ${(result.confidence * 100).toFixed(0)}%`)
  if (result.needsClarification) {
    console.log(`   ❓ ${result.clarificationQuestion}`)
  }
  if (result.anomaly) {
    console.log(`   ⚠️  anomaly: ${result.anomalyReason}`)
  }
  if (result.supplierName) {
    console.log(`   supplier  : ${result.supplierName}`)
  }
  console.log(`   ⏱  ${elapsed}ms`)
}

console.log('\n' + '='.repeat(50))
console.log('✅ Smoke test complete')
