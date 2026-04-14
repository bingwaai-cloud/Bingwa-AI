import { normalizePhone, isMTN, isAirtel, getPaymentProvider, maskPhone } from '../../../src/utils/phone.js'

describe('normalizePhone', () => {
  test.each([
    ['0772456789',    '+256772456789'],
    ['0782456789',    '+256782456789'],
    ['772456789',     '+256772456789'],
    ['+256772456789', '+256772456789'],
    ['256772456789',  '+256772456789'],
    ['0701234567',    '+256701234567'],
    ['0751234567',    '+256751234567'],
  ])('normalizes "%s" → "%s"', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected)
  })
})

describe('isMTN', () => {
  test('identifies MTN 077X numbers', () => {
    expect(isMTN('0772456789')).toBe(true)
    expect(isMTN('+256772456789')).toBe(true)
  })

  test('identifies MTN 078X numbers', () => {
    expect(isMTN('0782456789')).toBe(true)
  })

  test('rejects Airtel numbers', () => {
    expect(isMTN('0751234567')).toBe(false)
    expect(isMTN('0701234567')).toBe(false)
  })
})

describe('isAirtel', () => {
  test('identifies Airtel 075X numbers', () => {
    expect(isAirtel('0751234567')).toBe(true)
  })

  test('identifies Airtel 070X numbers', () => {
    expect(isAirtel('0701234567')).toBe(true)
  })

  test('rejects MTN numbers', () => {
    expect(isAirtel('0772456789')).toBe(false)
  })
})

describe('getPaymentProvider', () => {
  test('returns mtn_momo for MTN numbers', () => {
    expect(getPaymentProvider('0772456789')).toBe('mtn_momo')
  })

  test('returns airtel_money for Airtel numbers', () => {
    expect(getPaymentProvider('0751234567')).toBe('airtel_money')
  })

  test('returns null for unknown numbers', () => {
    expect(getPaymentProvider('0411234567')).toBeNull()
  })
})

describe('maskPhone', () => {
  test('masks middle digits of phone number', () => {
    expect(maskPhone('+256772456789')).toBe('+25677****89')
  })

  test('works with unnormalized input', () => {
    expect(maskPhone('0772456789')).toBe('+25677****89')
  })
})
