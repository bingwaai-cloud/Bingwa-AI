import type { UserContext, InventoryItem } from '../../src/nlp/types.js'

const DEFAULT_ITEMS: InventoryItem[] = [
  {
    id: 'item-sugar',
    name: 'Sugar',
    nameNormalized: 'sugar',
    aliases: ['sukari', 'shuga'],
    unit: 'kg',
    qtyInStock: 50,
    lowStockThreshold: 5,
    typicalBuyPrice: 4500,
    typicalSellPrice: 6500,
  },
  {
    id: 'item-gumboots',
    name: 'Gumboots',
    nameNormalized: 'gumboots',
    aliases: [],
    unit: 'pair',
    qtyInStock: 24,
    lowStockThreshold: 5,
    typicalBuyPrice: 20000,
    typicalSellPrice: 35000,
  },
  {
    id: 'item-soap',
    name: 'Soap',
    nameNormalized: 'soap',
    aliases: ['sabuni', 'sopo'],
    unit: 'piece',
    qtyInStock: 30,
    lowStockThreshold: 5,
    typicalBuyPrice: 1500,
    typicalSellPrice: 2500,
  },
  {
    id: 'item-flour',
    name: 'Maize Flour',
    nameNormalized: 'maize flour',
    aliases: ['unga', 'posho', 'flour'],
    unit: 'bag',
    qtyInStock: 10,
    lowStockThreshold: 3,
    typicalBuyPrice: 60000,
    typicalSellPrice: 75000,
  },
]

interface MockContextOptions {
  items?: InventoryItem[]
}

export function buildMockContext(options: MockContextOptions = {}): UserContext {
  return {
    tenantId: 'tenant-test-001',
    schemaName: 'tenant_test_001',
    userPhone: '+256772000001',
    tenant: {
      businessName: 'Rose General Store',
      businessType: 'General shop',
      ownerName: 'Rose',
      currency: 'UGX',
      country: 'UG',
    },
    items: options.items ?? DEFAULT_ITEMS,
    recentInteractions: [],
    onboardingStep: 5,
    onboardingComplete: true,
    preferences: {},
  }
}
