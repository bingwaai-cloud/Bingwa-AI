import { matchItemSync } from '../../../src/nlp/itemMatcher.js'
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

describe('matchItem (sync)', () => {
  test('exact nameNormalized match', () => {
    const result = matchItemSync('sugar', INVENTORY)
    expect(result?.id).toBe('1')
  })

  test('case-insensitive exact match', () => {
    const result = matchItemSync('Sugar', INVENTORY)
    expect(result?.id).toBe('1')
  })

  test('alias match — sukari → sugar', () => {
    const result = matchItemSync('sukari', INVENTORY)
    expect(result?.id).toBe('1')
  })

  test('alias match — unga → maize flour', () => {
    const result = matchItemSync('unga', INVENTORY)
    expect(result?.id).toBe('2')
  })

  test('alias match — posho → maize flour', () => {
    const result = matchItemSync('posho', INVENTORY)
    expect(result?.id).toBe('2')
  })

  test('substring "maize" does NOT match "maize flour" (no substring matching)', () => {
    const result = matchItemSync('maize', INVENTORY)
    expect(result).toBeNull()
  })

  test('partial query "gumboots pair" does NOT match "gumboots" (no contains matching)', () => {
    const result = matchItemSync('gumboots pair', INVENTORY)
    expect(result).toBeNull()
  })

  test('returns null for completely unknown item', () => {
    const result = matchItemSync('laptop', INVENTORY)
    expect(result).toBeNull()
  })

  test('returns null for empty string', () => {
    const result = matchItemSync('', INVENTORY)
    expect(result).toBeNull()
  })

  test('returns null when inventory is empty', () => {
    const result = matchItemSync('sugar', [])
    expect(result).toBeNull()
  })
})