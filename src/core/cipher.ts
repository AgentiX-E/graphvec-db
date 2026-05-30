// ============================================================
// EncryptionAtRest — Full encryption at rest
//
// Uses libsodium-wrappers (XChaCha20-Poly1305 AEAD) by default
// with AES-256-GCM fallback via node:crypto for FIPS environments.
//
// Key management (envelope encryption):
//   - DEK (Data Encryption Key): 256-bit random key
//   - KEK (Key Encryption Key): derived from passphrase via PBKDF2
//     (100K iterations, SHA-512)
//   - If no passphrase: DEK is stored in memory as plain key (still
//     encrypted at process level)
//   - Key export: DEK encrypted with KEK (or raw if no passphrase)
//
// Wire format per encrypt() call:
//   [nonce/iv(24b for XChaCha20 | 12b for AES-GCM)][ciphertext][mac(16b)]
// ============================================================

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as fsp from 'node:fs/promises'

// ── Types ────────────────────────────────

export interface CipherConfig {
  /** Path to store encrypted master key (optional) */
  keysPath?: string
  /** Passphrase to derive KEK (optional — if not set, DEK is in-memory only) */
  passphrase?: string
  /**
   * Algorithm: 'xchacha20-poly1305' (default) | 'aes-256-gcm'
   * Use AES-256-GCM in FIPS environments.
   */
  algorithm?: 'xchacha20-poly1305' | 'aes-256-gcm'
}

// ── Constants ────────────────────────────

const NONCE_SIZE_XCHACHA = 24
const NONCE_SIZE_AES_GCM = 12
const MAC_SIZE = 16
const DEK_BYTE_LENGTH = 32
const PBKDF2_ITERATIONS = 100_000
const PBKDF2_KEY_LENGTH = 32
const PBKDF2_DIGEST = 'sha512'
const PBKDF2_SALT_PREFIX = 'AgentiX.GraphVec.EncryptionAtRest.v1'
const FLAG_ENCRYPTED = 0x01

// ── Cipher class ─────────────────────────

export class EncryptionAtRest {
  /** Data Encryption Key (256-bit) */
  private _dek: Buffer
  /** Key Encryption Key (derived from passphrase) */
  private _kek: Buffer | null = null
  /** PBKDF2 salt (persisted alongside key file) */
  private _salt: Buffer | null = null
  /** Passphrase from config */
  private _passphrase: string | null = null
  /** Algorithm selection */
  private _algorithm: 'xchacha20-poly1305' | 'aes-256-gcm'
  /** Path to store encrypted key file */
  private _keysPath: string | null = null
  /** libsodium instance (lazy-loaded) */
  private _sodium: any = null
  /** Whether ready() has been called */
  private _ready = false

  constructor(config: CipherConfig) {
    this._algorithm = config.algorithm ?? 'xchacha20-poly1305'
    this._keysPath = config.keysPath ?? null
    this._passphrase = config.passphrase ?? null
    this._dek = crypto.randomBytes(DEK_BYTE_LENGTH)
    this._kek = null
    this._salt = null
  }

  /**
   * Initialize the cipher.
   * For libsodium-based modes, this loads the WASM module asynchronously.
   * For AES-256-GCM, this is a no-op (node:crypto is always available).
   */
  async ready(): Promise<void> {
    if (this._ready) return

    if (this._algorithm === 'xchacha20-poly1305') {
      // Lazily load libsodium-wrappers
      const libsodium = await import('libsodium-wrappers')
      this._sodium = libsodium.default
      await this._sodium.ready
    }

    // Derive KEK from passphrase if provided
    if (this._passphrase) {
      this._deriveKEK()
    }

    this._ready = true
  }

  /**
   * Synchronous initialization for cases where ready() can't be awaited.
   * Only works for AES-256-GCM (uses node:crypto which is always available).
   * For XChaCha20, you must still call ready() to load the WASM module.
   */
  initSync(): void {
    if (this._ready) return
    if (this._algorithm !== 'aes-256-gcm') {
      throw new Error(
        'initSync() is only supported for aes-256-gcm. ' +
        'For xchacha20-poly1305, call await ready() instead.'
      )
    }
    // Derive KEK from passphrase if provided
    if (this._passphrase) {
      this._deriveKEK()
    }
    this._ready = true
  }

  /**
   * Encrypt a Buffer.
   * Returns concatenated [nonce/iv][ciphertext][mac/tag] Buffer.
   */
  encrypt(plaintext: Buffer): Buffer {
    if (!this._ready) {
      throw new Error('EncryptionAtRest not initialized. Call ready() first.')
    }

    if (this._algorithm === 'xchacha20-poly1305') {
      return this._encryptXChaCha20(plaintext)
    } else {
      return this._encryptAESGCM(plaintext)
    }
  }

  /**
   * Decrypt a Buffer.
   * Expects concatenated [nonce/iv][ciphertext][mac/tag] format.
   */
  decrypt(ciphertext: Buffer): Buffer {
    if (!this._ready) {
      throw new Error('EncryptionAtRest not initialized. Call ready() first.')
    }

    if (this._algorithm === 'xchacha20-poly1305') {
      return this._decryptXChaCha20(ciphertext)
    } else {
      return this._decryptAESGCM(ciphertext)
    }
  }

  /**
   * Rotate the Data Encryption Key (DEK).
   * Generates a new DEK and stores the old DEK for backwards-compatible
   * decryption of existing data (lazy re-encryption model).
   *
   * NOTE: This does NOT re-encrypt existing data. Old ciphertexts
   * remain decryptable because we try the old DEK as fallback.
   * For full data re-encryption, callers must orchestrate re-writing
   * all data with the new DEK.
   */
  async rotateKey(): Promise<void> {
    // Save old DEK for backwards-compatible decrypt
    const oldDek = Buffer.from(this._dek)
    const prevKeys: Buffer[] = (this as any)._prevDekChain ?? []
    prevKeys.push(oldDek)
    ;(this as any)._prevDekChain = prevKeys

    // Generate new DEK
    this._dek = crypto.randomBytes(DEK_BYTE_LENGTH)

    // Re-write encrypted DEK file if keys path is set
    if (this._keysPath) {
      await this._writeKeyFile()
    }
  }

  /**
   * Export the encrypted DEK (for backup/migration).
   *
   * If passphrase is set, the DEK is encrypted with the KEK.
   * Format: [salt(32 bytes)][encrypted DEK(48 bytes = nonce(16) + ciphertext(32))]
   *   or raw [DEK(32 bytes)] if no passphrase.
   */
  exportEncryptedKey(): Buffer {
    if (this._passphrase && this._kek && this._salt) {
      // Encrypt DEK with KEK using AES-256-GCM
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', this._kek!, iv)
      const encrypted = Buffer.concat([cipher.update(this._dek), cipher.final()])
      const tag = cipher.getAuthTag()
      // Format: [salt(32)][iv(12)][ciphertext(32)][tag(16)]
      return Buffer.concat([this._salt, iv, encrypted, tag])
    } else {
      // No passphrase: export raw DEK (still in-memory only)
      // The returned buffer is still sensitive
      return Buffer.from(this._dek)
    }
  }

  /**
   * Import an encrypted DEK (from backup/migration).
   * Must match the format produced by exportEncryptedKey().
   */
  importEncryptedKey(data: Buffer): void {
    if (this._passphrase && this._kek && this._salt) {
      // Expect [salt(32)][iv(12)][ciphertext(32)][tag(16)] = 92 bytes
      if (data.length < 92) {
        throw new Error(`Invalid encrypted key data: expected >=92 bytes, got ${data.length}`)
      }
      const salt = data.subarray(0, 32)
      const iv = data.subarray(32, 44)
      const encrypted = data.subarray(44, 76)
      const tag = data.subarray(76, 92)

      const decipher = crypto.createDecipheriv('aes-256-gcm', this._kek!, iv)
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()])
      this._dek = plaintext
    } else {
      // Raw DEK import
      if (data.length !== DEK_BYTE_LENGTH) {
        throw new Error(`Invalid raw key data: expected ${DEK_BYTE_LENGTH} bytes, got ${data.length}`)
      }
      this._dek = Buffer.from(data)
    }
  }

  /**
   * Persist the encrypted DEK to disk (at keysPath).
   */
  private async _writeKeyFile(): Promise<void> {
    if (!this._keysPath) return

    const dir = path.dirname(this._keysPath)
    await fsp.mkdir(dir, { recursive: true })
    const exported = this.exportEncryptedKey()
    await fsp.writeFile(this._keysPath, exported, { mode: 0o600 })
  }

  /**
   * Derive KEK from passphrase using PBKDF2.
   */
  private _deriveKEK(): void {
    if (!this._passphrase) return

    // Generate or reuse salt
    if (!this._salt) {
      this._salt = crypto.randomBytes(32)
    }

    this._kek = crypto.pbkdf2Sync(
      this._passphrase,
      Buffer.concat([Buffer.from(PBKDF2_SALT_PREFIX), this._salt]),
      PBKDF2_ITERATIONS,
      PBKDF2_KEY_LENGTH,
      PBKDF2_DIGEST,
    )
  }

  // ── XChaCha20-Poly1305 (libsodium) ─────

  private _encryptXChaCha20(plaintext: Buffer): Buffer {
    const nonce = this._sodium.randombytes_buf(NONCE_SIZE_XCHACHA)
    const result = this._sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      null,   // additional data (none)
      null,   // secret nonce (none)
      nonce,
      this._dek,
    )
    // result is ciphertext + mac (16 bytes appended)
    return Buffer.concat([Buffer.from(nonce), Buffer.from(result)])
  }

  private _decryptXChaCha20(ciphertextWithNonce: Buffer): Buffer {
    const nonceLen = NONCE_SIZE_XCHACHA
    if (ciphertextWithNonce.length < nonceLen + MAC_SIZE) {
      throw new Error(
        `Ciphertext too short: ${ciphertextWithNonce.length} bytes ` +
        `(need >= ${nonceLen + MAC_SIZE})`
      )
    }

    const nonce = ciphertextWithNonce.subarray(0, nonceLen)
    const encrypted = ciphertextWithNonce.subarray(nonceLen)

    // Try current DEK first, then fall back to previous DEKs (for key rotation)
    const keysToTry = [this._dek]
    const prevKeys: Buffer[] | undefined = (this as any)._prevDekChain
    if (prevKeys) {
      for (const k of prevKeys) {
        keysToTry.push(k)
      }
    }

    let lastError: Error | null = null
    for (const key of keysToTry) {
      try {
        const plaintext = this._sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,   // secret nonce (none)
          encrypted,
          null,   // additional data (none)
          nonce,
          key,
        )
        return Buffer.from(plaintext)
      } catch (e: any) {
        lastError = e
      }
    }

    throw lastError ?? new Error('Decryption failed with all available keys')
  }

  // ── AES-256-GCM (node:crypto) ───────────

  private _encryptAESGCM(plaintext: Buffer): Buffer {
    const iv = crypto.randomBytes(NONCE_SIZE_AES_GCM)
    const cipher = crypto.createCipheriv('aes-256-gcm', this._dek, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, encrypted, tag])
  }

  private _decryptAESGCM(ciphertextWithIv: Buffer): Buffer {
    const ivLen = NONCE_SIZE_AES_GCM
    if (ciphertextWithIv.length < ivLen + MAC_SIZE) {
      throw new Error(
        `Ciphertext too short: ${ciphertextWithIv.length} bytes ` +
        `(need >= ${ivLen + MAC_SIZE})`
      )
    }

    const iv = ciphertextWithIv.subarray(0, ivLen)
    const tag = ciphertextWithIv.subarray(ciphertextWithIv.length - MAC_SIZE)
    const encrypted = ciphertextWithIv.subarray(ivLen, ciphertextWithIv.length - MAC_SIZE)

    // Try current DEK first, then fall back to previous DEKs (for key rotation)
    const keysToTry = [this._dek]
    const prevKeys: Buffer[] | undefined = (this as any)._prevDekChain
    if (prevKeys) {
      for (const k of prevKeys) {
        keysToTry.push(k)
      }
    }

    let lastError: Error | null = null
    for (const key of keysToTry) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(encrypted), decipher.final()])
      } catch (e: any) {
        lastError = e
      }
    }

    throw lastError ?? new Error('Decryption failed with all available keys')
  }

  // ── Accessors ───────────────────────────

  /** Whether the cipher is initialized and ready */
  get isReady(): boolean {
    return this._ready
  }

  /** The algorithm being used */
  get algorithm(): string {
    return this._algorithm
  }

  /** Check if encryption is passphrase-protected */
  get hasPassphrase(): boolean {
    return this._passphrase !== null
  }

  /**
   * Create a prefix byte for stored data to identify encryption status.
   * 0x00 = unencrypted, 0x01 = encrypted with current config.
   */
  static encryptionFlag(): number {
    return FLAG_ENCRYPTED
  }

  /**
   * Check whether a buffer has the encryption flag.
   */
  static isEncrypted(data: Buffer): boolean {
    return data.length > 0 && (data[0] & FLAG_ENCRYPTED) !== 0
  }

  /**
   * Strip the encryption flag prefix.
   */
  static stripFlag(data: Buffer): Buffer {
    return data.subarray(1)
  }

  /**
   * Prepend the encryption flag to data.
   */
  static prependFlag(data: Buffer): Buffer {
    const flagged = Buffer.alloc(1 + data.length)
    flagged[0] = FLAG_ENCRYPTED
    data.copy(flagged, 1)
    return flagged
  }
}
