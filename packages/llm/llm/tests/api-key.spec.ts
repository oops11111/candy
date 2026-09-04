import { describe, expect, it } from 'vitest'
import { assertUsableApiKey, INVALID_CREDENTIAL_CODE, normalizeApiKey, redactApiKey, redactChunkApiKey, type StreamChunk } from '@deepseek-ai/dsh-llm'

describe('normalizeApiKey', () => {
  it('accepts a printable-ASCII key unchanged', () => {
    expect(normalizeApiKey('sk-0123456789abcdef')).toEqual({ ok: true, value: 'sk-0123456789abcdef' })
  })

  it('trims surrounding whitespace before judging', () => {
    expect(normalizeApiKey('  sk-abc\t\n')).toEqual({ ok: true, value: 'sk-abc' })
  })

  it.each([
    ['an empty string', ''],
    ['spaces only', '   '],
    ['a tab only', '\t'],
  ])('rejects %s as empty', (_label, raw) => {
    expect(normalizeApiKey(raw)).toEqual({ ok: false, reason: 'empty' })
  })

  it.each([
    ['an emoji', 'sk-\u{1F600}abc'],
    ['CJK text', 'sk-你好'],
    ['full-width punctuation', 'sk-abc，'],
    ['an interior space', 'sk-abc def'],
    ['a C0 control character', 'sk-abc\x01'],
    ['a latin-1 character', 'sk-café'],
  ])('rejects %s as illegal characters', (_label, raw) => {
    expect(normalizeApiKey(raw)).toEqual({ ok: false, reason: 'illegalCharacters' })
  })

  it('accepts the printable-ASCII boundary characters', () => {
    expect(normalizeApiKey('!~')).toEqual({ ok: true, value: '!~' })
  })

  it('publishes a code distinct from a missing credential', () => {
    expect(INVALID_CREDENTIAL_CODE).toBe('INVALID_CREDENTIAL')
  })
})

describe('assertUsableApiKey', () => {
  it('returns the trimmed key when it is usable', () => {
    expect(assertUsableApiKey('  sk-abc  ', 'llm-deepseek', 'DEEPSEEK_API_KEY')).toBe('sk-abc')
  })

  it('refuses a blank stored credential, naming the reference', () => {
    expect(() => assertUsableApiKey('   ', 'llm-deepseek', 'DEEPSEEK_API_KEY'))
      .toThrow(/llm-deepseek: the API key resolved from DEEPSEEK_API_KEY is blank/)
  })

  it('refuses an unusable stored credential with the invalid-credential code', () => {
    try {
      assertUsableApiKey('sk-\u{1F600}', 'llm-pi-ai', 'ACME_API_KEY')
      expect.fail('an illegal key must throw')
    } catch (error) {
      expect((error as { code: string }).code).toBe(INVALID_CREDENTIAL_CODE)
      expect((error as Error).message).toContain('llm-pi-ai')
      expect((error as Error).message).toContain('ACME_API_KEY')
    }
  })

  it('never echoes the key it refuses', () => {
    try {
      assertUsableApiKey('sk-\u{1F600}supersecret', 'llm-deepseek', 'DEEPSEEK_API_KEY')
      expect.fail('an illegal key must throw')
    } catch (error) {
      expect((error as Error).message).not.toContain('supersecret')
    }
  })
})

describe('redactApiKey', () => {
  it('replaces every occurrence of the credential', () => {
    expect(redactApiKey('key sk-live-1 rejected; sk-live-1 is revoked', 'sk-live-1'))
      .toBe('key [redacted] rejected; [redacted] is revoked')
  })

  it('leaves text that does not quote the credential alone', () => {
    expect(redactApiKey('Authentication Fails', 'sk-live-1')).toBe('Authentication Fails')
  })

  it('matches the literal key rather than a pattern', () => {
    // A key is opaque text; treating it as a pattern would let its own
    // characters decide what else got replaced.
    expect(redactApiKey('a.b and axb', 'a.b')).toBe('[redacted] and axb')
  })

  it('refuses an empty credential rather than mangling the text', () => {
    expect(redactApiKey('nothing to hide', '')).toBe('nothing to hide')
  })
})

describe('redactChunkApiKey', () => {
  const KEY = 'sk-live-1'

  it('redacts the failure a terminal chunk carries', () => {
    const chunk: StreamChunk = {
      type: 'finish',
      reason: { kind: 'error', failure: { message: `rejected ${KEY}`, code: 'AUTH' } },
    }

    expect(redactChunkApiKey(chunk, KEY)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'rejected [redacted]', code: 'AUTH' } },
    })
  })

  it('leaves a terminal chunk that carries no failure alone', () => {
    const chunk: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }

    expect(redactChunkApiKey(chunk, KEY)).toBe(chunk)
  })

  it('leaves model output alone', () => {
    // The caller's own content, which a silent rewrite would corrupt.
    const chunk: StreamChunk = { type: 'text-delta', index: 0, text: `explain ${KEY}` }

    expect(redactChunkApiKey(chunk, KEY)).toBe(chunk)
  })
})
