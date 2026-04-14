import { normalizeCurrency, formatUGX, formatUGXShort } from '../../../src/nlp/normalizers.js'

describe('normalizeCurrency', () => {
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

  test('returns null for empty string', () => {
    expect(normalizeCurrency('')).toBeNull()
  })

  test('returns null for non-numeric string', () => {
    expect(normalizeCurrency('abc')).toBeNull()
  })

  test('returns null for letters only', () => {
    expect(normalizeCurrency('kilo')).toBeNull()
  })
})

describe('formatUGX', () => {
  test('formats 70000 as UGX 70,000', () => {
    expect(formatUGX(70000)).toBe('UGX 70,000')
  })

  test('formats 1500000 as UGX 1,500,000', () => {
    expect(formatUGX(1500000)).toBe('UGX 1,500,000')
  })

  test('formats 500 as UGX 500', () => {
    expect(formatUGX(500)).toBe('UGX 500')
  })
})

describe('formatUGXShort', () => {
  test('formats 70000 as 70k', () => {
    expect(formatUGXShort(70000)).toBe('70k')
  })

  test('formats 1500000 as 1.5m', () => {
    expect(formatUGXShort(1500000)).toBe('1.5m')
  })

  test('formats 500 as 500', () => {
    expect(formatUGXShort(500)).toBe('500')
  })

  test('formats 2000000 as 2m (no decimal)', () => {
    expect(formatUGXShort(2000000)).toBe('2m')
  })
})
