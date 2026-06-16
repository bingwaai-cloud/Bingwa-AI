/**
 * Unit tests for the sync item matcher (matchItemSync).
 *
 * The async full matcher (matchItemFull, enrichMatchedItems, recordAliasMatch)
 * requires a DB transaction — tested in integration/itemMatcher.test.ts.
 */

import { matchItemSync, SEED_ALIASES } from '../../../src/nlp/itemMatcher.js'
import type { InventoryItem } from '../../../src/nlp/types.js'

const mockInventory: InventoryItem[] = [
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
    id: 'item-soap-powder',
    name: 'Soap Powder',
    nameNormalized: 'soap powder',
    aliases: ['omo', 'detergent'],
    unit: 'packet',
    qtyInStock: 15,
    lowStockThreshold: 3,
    typicalBuyPrice: 3000,
    typicalSellPrice: 4500,
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
    id: 'item-flour',
    name: 'Maize Flour',
    nameNormalized: 'maize flour',
    aliases: ['unga', 'posho'],
    unit: 'bag',
    qtyInStock: 10,
    lowStockThreshold: 3,
    typicalBuyPrice: 60000,
    typicalSellPrice: 75000,
  },
  {
    id: 'item-rice',
    name: 'Rice',
    nameNormalized: 'rice',
    aliases: [],
    unit: 'kg',
    qtyInStock: 40,
    lowStockThreshold: 10,
    typicalBuyPrice: 4000,
    typicalSellPrice: 5500,
  },
  {
    id: 'item-cooking-oil',
    name: 'Cooking Oil',
    nameNormalized: 'cooking oil',
    aliases: [],
    unit: 'litre',
    qtyInStock: 20,
    lowStockThreshold: 5,
    typicalBuyPrice: 8000,
    typicalSellPrice: 10000,
  },
]

describe('matchItemSync', () => {
  it('exact match on name_normalized', () => {
    const result = matchItemSync('sugar', mockInventory)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('item-sugar')
    expect(result!.name).toBe('Sugar')
  })

  it('exact match case-insensitive', () => {
    const result = matchItemSync('SUGAR', mockInventory)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('item-sugar')
  })

  it('exact match with whitespace', () => {
    const result = matchItemSync('  sugar  ', mockInventory)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('item-sugar')
  })

  it('inventory alias match (sabuni → soap)', () => {
    const result = matchItemSync('sabuni', mockInventory)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('item-soap')
  })

  it('inventory alias match (shuga → sugar)', () => {
    const result = matchItemSync('shuga', mockInventory)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('item-sugar')
  })

  it('seed alias match (posho → maize flour)', () => {
    // posho is in both inventory aliases AND seed aliases
    const result = matchItemSync('posho', mockInventory)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('item-flour')
  })

  it('seed alias match (chumvi → salt) — no salt in inventory, returns null', () => {
    const result = matchItemSync('chumvi', mockInventory)
    expect(result).toBeNull()
  })

  it('seed alias match (mafuta → cooking oil) — inventory has it', () => {
    const result = matchItemSync('mafuta', mockInventory)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('item-cooking-oil')
    expect(result!.nameNormalized).toBe('cooking oil')
  })

  it('"soap" does NOT match "soap powder"', () => {
    // soap should match exactly, not substring
    const result = matchItemSync('soap', mockInventory)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('item-soap')
    expect(result!.name).toBe('Soap')
    // It should NOT match soap powder
    expect(result!.id).not.toBe('item-soap-powder')
  })

  it('"soap powder" matches exactly, not "soap"', () => {
    const result = matchItemSync('soap powder', mockInventory)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('item-soap-powder')
    expect(result!.name).toBe('Soap Powder')
  })

  it('"soa" (substring) does NOT match "soap"', () => {
    const result = matchItemSync('soa', mockInventory)
    expect(result).toBeNull()
  })

  it('no-hit returns null', () => {
    const result = matchItemSync('bicycles', mockInventory)
    expect(result).toBeNull()
  })

  it('empty input returns null', () => {
    expect(matchItemSync('', mockInventory)).toBeNull()
    expect(matchItemSync('  ', mockInventory)).toBeNull()
  })

  it('multi-word match works (maize flour)', () => {
    const result = matchItemSync('maize flour', mockInventory)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('item-flour')
  })
})

describe('SEED_ALIASES', () => {
  it('contains all required seed entries', () => {
    expect(SEED_ALIASES['sukari']).toBe('sugar')
    expect(SEED_ALIASES['shuga']).toBe('sugar')
    expect(SEED_ALIASES['unga']).toBe('maize flour')
    expect(SEED_ALIASES['posho']).toBe('maize flour')
    expect(SEED_ALIASES['mafuta']).toBe('cooking oil')
    expect(SEED_ALIASES['oli']).toBe('cooking oil')
    expect(SEED_ALIASES['sabuni']).toBe('soap')
    expect(SEED_ALIASES['sopo']).toBe('soap')
    expect(SEED_ALIASES['chumvi']).toBe('salt')
    expect(SEED_ALIASES['munyu']).toBe('salt')
    expect(SEED_ALIASES['mchele']).toBe('rice')
    expect(SEED_ALIASES['rayisi']).toBe('rice')
    expect(SEED_ALIASES['maharagwe']).toBe('beans')
    expect(SEED_ALIASES['obunde']).toBe('beans')
  })
})