/**
 * backup-timestamp.spec.ts — unit tests for parseBackupTimestamp, the pure
 * filename→epoch-millis parser used to enumerate PITR recovery points. It must
 * reject malformed or out-of-range timestamps rather than silently normalising
 * them via JavaScript's lenient Date construction.
 */
import { describe, it, expect } from 'vitest'
import { parseBackupTimestamp } from './backup'

describe('parseBackupTimestamp', () => {
  it('parses the basic YYYYMMDDTHHmmssZ format', () => {
    const ts = parseBackupTimestamp('graphvec-backup-20260101T120000Z')
    expect(ts).toBe(Date.UTC(2026, 0, 1, 12, 0, 0))
  })

  it('parses a full path, ignoring directories', () => {
    const ts = parseBackupTimestamp('/var/backups/graphvec-backup-20260101T120000Z.tar.gz')
    expect(ts).toBe(Date.UTC(2026, 0, 1, 12, 0, 0))
  })

  it('strips .tar.gz and .tgz extensions', () => {
    expect(parseBackupTimestamp('graphvec-backup-20260101T120000Z.tar.gz')).toBe(
      Date.UTC(2026, 0, 1, 12, 0, 0),
    )
    expect(parseBackupTimestamp('graphvec-backup-20260101T120000Z.tgz')).toBe(
      Date.UTC(2026, 0, 1, 12, 0, 0),
    )
  })

  it('parses the YYYY-MM-DDTHH-mm-ss-SSSZ format', () => {
    const ts = parseBackupTimestamp('graphvec-backup-2026-01-01T12-00-00-000Z')
    expect(ts).toBe(Date.UTC(2026, 0, 1, 12, 0, 0, 0))
  })

  it('returns null for a non-matching prefix', () => {
    expect(parseBackupTimestamp('something-else-20260101T120000Z')).toBeNull()
  })

  it('returns null for a missing timestamp', () => {
    expect(parseBackupTimestamp('graphvec-backup-')).toBeNull()
  })

  it('returns null for a garbage timestamp', () => {
    expect(parseBackupTimestamp('graphvec-backup-not-a-date')).toBeNull()
  })

  it('rejects an out-of-range month (13)', () => {
    // 13 is not a valid month; it must NOT be normalised to the next year.
    expect(parseBackupTimestamp('graphvec-backup-20261301T120000Z')).toBeNull()
  })

  it('rejects an out-of-range day (32)', () => {
    expect(parseBackupTimestamp('graphvec-backup-20260132T120000Z')).toBeNull()
  })

  it('rejects an out-of-range hour (25)', () => {
    expect(parseBackupTimestamp('graphvec-backup-20260101T250000Z')).toBeNull()
  })

  it('rejects an out-of-range minute (61)', () => {
    expect(parseBackupTimestamp('graphvec-backup-20260101T126100Z')).toBeNull()
  })

  it('rejects an out-of-range second (60)', () => {
    expect(parseBackupTimestamp('graphvec-backup-20260101T120060Z')).toBeNull()
  })

  it('rejects a non-existent day (Feb 30)', () => {
    expect(parseBackupTimestamp('graphvec-backup-20260230T120000Z')).toBeNull()
  })

  it('rejects a non-existent day in the dashed format (Feb 30)', () => {
    expect(parseBackupTimestamp('graphvec-backup-2026-02-30T12-00-00-000Z')).toBeNull()
  })

  it('rejects an out-of-range month in the dashed format (13)', () => {
    expect(parseBackupTimestamp('graphvec-backup-2026-13-01T12-00-00-000Z')).toBeNull()
  })

  it('rejects an out-of-range hour in the dashed format (25)', () => {
    expect(parseBackupTimestamp('graphvec-backup-2026-01-01T25-00-00-000Z')).toBeNull()
  })
})
