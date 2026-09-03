import { describe, expect, it } from 'vitest'
import { ClaudeCliLineDecoder, ClaudeCliProtocolError } from '../src/index.ts'

describe('ClaudeCliLineDecoder', () => {
  it('decodes whole lines from one read', () => {
    expect(new ClaudeCliLineDecoder().push('{"type":"a"}\n{"type":"b"}\n'))
      .toEqual([{ type: 'a' }, { type: 'b' }])
  })

  it('holds a partial line until the read that completes it', () => {
    const decoder = new ClaudeCliLineDecoder()

    expect(decoder.push('{"type":"a"')).toEqual([])
    expect(decoder.push(',"subtype":"x"}\n')).toEqual([{ type: 'a', subtype: 'x' }])
  })

  it('joins a line split across three reads', () => {
    const decoder = new ClaudeCliLineDecoder()
    decoder.push('{"ty')
    decoder.push('pe":"a')

    expect(decoder.push('"}\n')).toEqual([{ type: 'a' }])
  })

  it('skips blank lines', () => {
    expect(new ClaudeCliLineDecoder().push('\n\n{"type":"a"}\n\n')).toEqual([{ type: 'a' }])
  })

  it('returns the final line when the stream ends without a newline', () => {
    const decoder = new ClaudeCliLineDecoder()
    decoder.push('{"type":"a"}')

    expect(decoder.flush()).toEqual([{ type: 'a' }])
  })

  it('flushes nothing when the stream ended on a newline', () => {
    const decoder = new ClaudeCliLineDecoder()
    decoder.push('{"type":"a"}\n')

    expect(decoder.flush()).toEqual([])
  })

  it('flushes nothing twice, so a second flush cannot repeat a frame', () => {
    const decoder = new ClaudeCliLineDecoder()
    decoder.push('{"type":"a"}')
    decoder.flush()

    expect(decoder.flush()).toEqual([])
  })

  it('discards the half-written line a killed CLI leaves behind', () => {
    const decoder = new ClaudeCliLineDecoder()
    decoder.push('{"type":"result","usa')

    expect(decoder.flush()).toEqual([])
  })

  it('rejects a complete line that is not JSON', () => {
    expect(() => new ClaudeCliLineDecoder().push('not json\n')).toThrow(ClaudeCliProtocolError)
  })

  it.each([
    ['an array', '[1,2]\n'],
    ['a bare string', '"hello"\n'],
    ['null', 'null\n'],
  ])('rejects a complete line that is %s rather than an object', (_case, line) => {
    expect(() => new ClaudeCliLineDecoder().push(line)).toThrow(ClaudeCliProtocolError)
  })

  it('retains the offending line and the parse failure for diagnostics', () => {
    try {
      new ClaudeCliLineDecoder().push('nope\n')
      expect.unreachable('the decoder must reject a non-JSON line')
    } catch (error) {
      expect(error).toBeInstanceOf(ClaudeCliProtocolError)
      expect((error as ClaudeCliProtocolError).line).toBe('nope')
      expect((error as ClaudeCliProtocolError).cause).toBeInstanceOf(SyntaxError)
    }
  })

  it('carries no cause when the line parsed but was not an object', () => {
    try {
      new ClaudeCliLineDecoder().push('[]\n')
      expect.unreachable('the decoder must reject a non-object line')
    } catch (error) {
      expect((error as ClaudeCliProtocolError).cause).toBeUndefined()
    }
  })
})
