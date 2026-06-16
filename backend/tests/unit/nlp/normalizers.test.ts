import { matchItemSync } from '../../../src/nlp/itemMatcher.js'
import type { InventoryItem } from '../../../src/nlp/types.js'
import {
  normalizeCurrency,
  parseAtNotation,
  isUnitPriceMarker,
  isUnitWord,
} from '../../../src/nlp/normalizers.js'

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

// ─── normalizeCurrency ──────────────────────────────────────────────

describe('normalizeCurrency', () => {
  describe('legacy cases (no regression)', () => {
    test.each([
      ['70k',       70000],
      ['70K',       70000],
      ['70,000',    70000],
      ['70000',     70000],
      ['shs70k',    70000],
      ['UGX70,000', 70000],
      ['ugx70000',  70000],
      ['1.5m',      1500000],
      ['1.5M',      1500000],
      ['1.2m',      1200000],
      ['7.5k',      7500],
      ['100',       100],
      ['4500',      4500],
      ['800k',      800000],
      ['sh70k',     70000],
    ])('normalizes "%s" → %i', (input, expected) => {
      expect(normalizeCurrency(input)).toBe(expected)
    })
  })

  describe('comma disambiguation (k/m suffix = decimal | no suffix = thousands)', () => {
    test.each([
      ['6,5k',      6500],
      ['1,5m',      1500000],
      ['70,000',    70000],
      ['1,500',     1500],
      ['2,75k',     2750],
      ['3,8m',      3800000],
      ['12,5k',     12500],
      ['0,5k',      500],
    ])('"%s" → %i', (input, expected) => {
      expect(normalizeCurrency(input)).toBe(expected)
    })
  })

  describe('shilling notation /= and /-', () => {
    test.each([
      ['70/=',      70],
      ['70/-',      70],
      ['70/= ',     70],
      ['70k/=',     70000],
      ['1500/=',    1500],
    ])('"%s" → %i', (input, expected) => {
      expect(normalizeCurrency(input)).toBe(expected)
    })
  })

  describe('prefix + suffix combos', () => {
    test.each([
      ['ug70k',     70000],
      ['ugx6,5k',   6500],
      ['shs1,5m',   1500000],
      ['ug1.5m',    1500000],
      ['sh50/=',    50],
    ])('"%s" → %i', (input, expected) => {
      expect(normalizeCurrency(input)).toBe(expected)
    })
  })

  describe('invalid inputs → null', () => {
    test.each([
      [''],
      ['abc'],
      ['kilo'],
    ])('"%s" → null', (input) => {
      expect(normalizeCurrency(input)).toBeNull()
    })

    test('returns null for non-string', () => {
      expect(normalizeCurrency(null as unknown as string)).toBeNull()
      expect(normalizeCurrency(undefined as unknown as string)).toBeNull()
    })
  })
})

// ─── parseAtNotation ────────────────────────────────────────────────

describe('parseAtNotation', () => {
  test.each([
    ['2 @ 6k',    { qty: 2, unitPrice: 6000 }],
    ['2 at 6k',   { qty: 2, unitPrice: 6000 }],
    ['2@6k',      { qty: 2, unitPrice: 6000 }],
    ['3 @ 7.5k',  { qty: 3, unitPrice: 7500 }],
    ['1 at 1.2m', { qty: 1, unitPrice: 1200000 }],
    ['5@70/=',     { qty: 5, unitPrice: 70 }],
  ])('"%s" → %o', (input, expected) => {
    expect(parseAtNotation(input)).toEqual(expected)
  })

  test('returns null for non-matching input', () => {
    expect(parseAtNotation('just plain text')).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(parseAtNotation('')).toBeNull()
  })

  test('returns null when price is invalid', () => {
    expect(parseAtNotation('2 @ abc')).toBeNull()
  })
})

// ─── isUnitPriceMarker ──────────────────────────────────────────────

describe('isUnitPriceMarker', () => {
  test.each([
    ['each',      true],
    ['@kimu',     true],
    ['buli emu',  true],
    ['BULI EMU',  true],
    ['Each',      true],
    ['@KIMU',     true],
  ])('"%s" → %s', (input, expected) => {
    expect(isUnitPriceMarker(input)).toBe(expected)
  })

  test.each([
    [''],
    ['normal text'],
    ['sold 2 sugar'],
  ])('"%s" → false', (input) => {
    expect(isUnitPriceMarker(input)).toBe(false)
  })
})

// ─── isUnitWord ─────────────────────────────────────────────────────

describe('isUnitWord', () => {
  test.each([
    ['bag',       true],
    ['doz',       true],
    ['dozen',     true],
    ['jerrycan',  true],
    ['crate',     true],
    ['tray',      true],
    ['sack',      true],
    ['carton',    true],
    ['BAG',       true],
    ['JERRYCAN',  true],
  ])('"%s" → %s', (input, expected) => {
    expect(isUnitWord(input)).toBe(expected)
  })

  test.each([
    ['box'],
    ['pair'],
    ['kg'],
    ['litre'],
    [''],
  ])('"%s" → false', (input) => {
    expect(isUnitWord(input)).toBe(false)
  })
})