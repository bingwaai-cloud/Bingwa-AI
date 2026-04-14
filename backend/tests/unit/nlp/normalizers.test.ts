import { matchItem } from '../../../src/nlp/normalizers.js'
import type { InventoryItem } from '../../../src/nlp/types.js'

const INVENTORY: InventoryItem[] = [
  {
    id: '1',
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
    id: '2',
    name: 'Maize Flour',
    nameNormalized: 'maize flour',
    aliases: ['unga', 'posho', 'flour'],
    unit: 'bag',
    qtyInStock: 20,
    lowStockThreshold: 3,
    typicalBuyPrice: 60000,
    typicalSellPrice: 75000,
  },
  {
    id: '3',
    name: 'Gumboots',
    nameNormalized: 'gumboots',
    aliases: [],
    unit: 'pair',
    qtyInStock: 24,
    lowStockThreshold: 5,
    typicalBuyPrice: 20000,
    typicalSellPrice: 35000,
  },
]

describe('matchItem', () => {
  test('exact nameNormalized match', () => {
    const result = matchItem('sugar', INVENTORY)
    expect(result?.id).toBe('1')
  })

  test('case-insensitive exact match', () => {
    const result = matchItem('Sugar', INVENTORY)
    expect(result?.id).toBe('1')
  })

  test('alias match — sukari → sugar', () => {
    const result = matchItem('sukari', INVENTORY)
    expect(result?.id).toBe('1')
  })

  test('alias match — unga → maize flour', () => {
    const result = matchItem('unga', INVENTORY)
    expect(result?.id).toBe('2')
  })

  test('alias match — posho → maize flour', () => {
    const result = matchItem('posho', INVENTORY)
    expect(result?.id).toBe('2')
  })

  test('partial match — "maize" matches "maize flour"', () => {
    const result = matchItem('maize', INVENTORY)
    expect(result?.id).toBe('2')
  })

  test('partial match — query contains item name', () => {
    const result = matchItem('gumboots pair', INVENTORY)
    expect(result?.id).toBe('3')
  })

  test('returns null for completely unknown item', () => {
    const result = matchItem('laptop', INVENTORY)
    expect(result).toBeNull()
  })

  test('returns null for empty string', () => {
    const result = matchItem('', INVENTORY)
    expect(result).toBeNull()
  })

  test('returns null when inventory is empty', () => {
    const result = matchItem('sugar', [])
    expect(result).toBeNull()
  })
})
