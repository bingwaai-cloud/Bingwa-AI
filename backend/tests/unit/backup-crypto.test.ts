/**
 * Encrypt/decrypt round-trip test (WP-15).
 *
 * Verifies AES-256-CBC + PBKDF2-SHA256 round-trip matching the algorithm used
 * by scripts/backup.ts (`openssl enc -aes-256-cbc -pbkdf2 -salt`).
 * Uses Node.js built-in crypto so the test is portable (no openssl CLI dep).
 *
 * Output format: Salted__<8-byte-salt><ciphertext> — same as openssl.
 *
 * Run: npx jest tests/unit/backup-crypto.test.ts
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, createHash } from 'crypto'

const TEST_KEY = Buffer.from(
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'hex'
)
const TEST_PLAINTEXT = 'Gezi AI weekly encrypted backup — round-trip test payload.'

/**
 * Encrypts using AES-256-CBC with PBKDF2 key derivation + random salt.
 *
 * openssl enc -pbkdf2 derives key+iv from password+salt via:
 *   key_iv = PBKDF2(password, salt, 10000, 48, sha256)
 *   enc_key = key_iv[0:32], iv = key_iv[32:48]
 */
function encryptAes256CbcPbkdf2(plaintext: Buffer, password: Buffer): Buffer {
  const salt = randomBytes(8)
  const keyIv = pbkdf2Sync(password, salt, 10000, 48, 'sha256')
  const encKey = keyIv.subarray(0, 32)
  const iv = keyIv.subarray(32, 48)

  const cipher = createCipheriv('aes-256-cbc', encKey, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return Buffer.concat([Buffer.from('Salted__'), salt, encrypted])
}

/** Decrypts openssl-compatible AES-256-CBC + PBKDF2 encrypted data. */
function decryptAes256CbcPbkdf2(encrypted: Buffer, password: Buffer): Buffer {
  const salt = encrypted.subarray(8, 16)
  const ciphertext = encrypted.subarray(16)

  const keyIv = pbkdf2Sync(password, salt, 10000, 48, 'sha256')
  const encKey = keyIv.subarray(0, 32)
  const iv = keyIv.subarray(32, 48)

  const decipher = createDecipheriv('aes-256-cbc', encKey, iv)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

describe('Backup crypto round-trip', () => {
  it('encrypts with AES-256-CBC PBKDF2 and decrypts correctly', () => {
    const plaintext = Buffer.from(TEST_PLAINTEXT, 'utf-8')
    const encrypted = encryptAes256CbcPbkdf2(plaintext, TEST_KEY)

    expect(encrypted.subarray(0, 8).toString()).toBe('Salted__')
    expect(encrypted.toString('utf-8')).not.toContain(TEST_PLAINTEXT)

    const decrypted = decryptAes256CbcPbkdf2(encrypted, TEST_KEY)
    expect(decrypted.toString('utf-8')).toBe(TEST_PLAINTEXT)
  })

  it('fails to decrypt with wrong key', () => {
    const plaintext = Buffer.from(TEST_PLAINTEXT, 'utf-8')
    const encrypted = encryptAes256CbcPbkdf2(plaintext, TEST_KEY)
    const wrongKey = Buffer.from(
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      'hex'
    )

    expect(() => decryptAes256CbcPbkdf2(encrypted, wrongKey)).toThrow()
  })

  it('produces different ciphertext for same plaintext (random salt)', () => {
    const plaintext = Buffer.from(TEST_PLAINTEXT, 'utf-8')
    const enc1 = encryptAes256CbcPbkdf2(plaintext, TEST_KEY)
    const enc2 = encryptAes256CbcPbkdf2(plaintext, TEST_KEY)

    expect(enc1.compare(enc2)).not.toBe(0)

    expect(decryptAes256CbcPbkdf2(enc1, TEST_KEY).toString('utf-8')).toBe(TEST_PLAINTEXT)
    expect(decryptAes256CbcPbkdf2(enc2, TEST_KEY).toString('utf-8')).toBe(TEST_PLAINTEXT)
  })

  it('handles binary data (pg_dump -Fc output)', () => {
    const binaryPayload = randomBytes(1024 * 50)
    const encrypted = encryptAes256CbcPbkdf2(binaryPayload, TEST_KEY)

    expect(encrypted.length).toBeGreaterThan(binaryPayload.length)

    const decrypted = decryptAes256CbcPbkdf2(encrypted, TEST_KEY)
    expect(decrypted.length).toBe(binaryPayload.length)
    expect(decrypted.compare(binaryPayload)).toBe(0)
  })

  it('SHA-256 hash differs per salt (integrity check)', () => {
    const plaintext = Buffer.from(TEST_PLAINTEXT, 'utf-8')
    const enc1 = encryptAes256CbcPbkdf2(plaintext, TEST_KEY)
    const enc2 = encryptAes256CbcPbkdf2(plaintext, TEST_KEY)

    const hash1 = createHash('sha256').update(enc1).digest('hex')
    const hash2 = createHash('sha256').update(enc2).digest('hex')

    expect(hash1).not.toBe(hash2)
  })
})