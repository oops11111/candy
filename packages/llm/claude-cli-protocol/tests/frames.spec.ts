import type { WireStreamEvent } from '@deepseek-ai/dsh-claude-cli-protocol'
import { describe, expect, it } from 'vitest'
import { ClaudeCliFrameTranslator, mapFinish, mapUsage } from '../src/index.ts'

/** One `stream_event` frame wrapping the given Messages API event. */
function streamed(event: WireStreamEvent) {
  return { type: 'stream_event', event }
}

/** Open a text block at index 0 on a fresh translator. */
function withOpenText(): ClaudeCliFrameTranslator {
  const translator = new ClaudeCliFrameTranslator()
  translator.translate(streamed({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }))
  return translator
}

describe('mapUsage', () => {
  it('maps the disjoint counts without subtracting cache figures', () => {
    expect(mapUsage({
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20,
    })).toEqual({
      inputTokens: 10, outputTokens: 5, totalTokens: 135, cacheReadTokens: 100, cacheWriteTokens: 20,
    })
  })

  it('omits cache and reasoning counts the run never reported', () => {
    expect(mapUsage({ input_tokens: 3, output_tokens: 7 }))
      .toEqual({ inputTokens: 3, outputTokens: 7, totalTokens: 10 })
  })

  it('reports thinking tokens as reasoning tokens', () => {
    expect(mapUsage({ output_tokens_details: { thinking_tokens: 12 } }))
      .toMatchObject({ reasoningTokens: 12 })
  })

  it('treats absent counters as zero', () => {
    expect(mapUsage({})).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  })

  it('omits the total when a counter is not a safe non-negative integer', () => {
    expect(mapUsage({ input_tokens: 1.5, output_tokens: 2 })).not.toHaveProperty('totalTokens')
    expect(mapUsage({ input_tokens: -1, output_tokens: 2 })).not.toHaveProperty('totalTokens')
  })

  it('carries the reported cost as rounded integer micro-USD', () => {
    expect(mapUsage({ input_tokens: 1, output_tokens: 1 }, 0.0347348))
      .toMatchObject({ costMicroUsd: 34_735 })
  })

  it('reports a zero cost, which is not the same as reporting none', () => {
    expect(mapUsage({}, 0)).toMatchObject({ costMicroUsd: 0 })
    expect(mapUsage({})).not.toHaveProperty('costMicroUsd')
  })

  it.each([
    ['negative', -0.5],
    ['not finite', Number.POSITIVE_INFINITY],
    ['not a number', Number.NaN],
    ['past safe integer range once scaled', Number.MAX_SAFE_INTEGER],
  ])('omits a cost that is %s rather than repairing it', (_case, cost) => {
    // A repaired figure would be charged to a tenant as though the CLI had
    // reported it.
    expect(mapUsage({}, cost)).not.toHaveProperty('costMicroUsd')
  })

  it('does not surface invalid counters on the public usage fields', () => {
    expect(mapUsage({
      input_tokens: -1,
      output_tokens: 1.5,
      cache_read_input_tokens: Number.MAX_SAFE_INTEGER + 1,
      cache_creation_input_tokens: -2,
      output_tokens_details: { thinking_tokens: -3 },
    })).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})

describe('mapFinish', () => {
  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['tool_use', 'tool-calls'],
    ['max_tokens', 'max-tokens'],
  ])('maps stop_reason %s to %s', (stop_reason, kind) => {
    expect(mapFinish({ stop_reason })).toEqual({ kind })
  })

  it.each([[null], [undefined]])('treats an absent stop_reason (%s) as a normal stop', (stop_reason) => {
    expect(mapFinish({ stop_reason })).toEqual({ kind: 'stop' })
  })

  it('surfaces an unrecognized stop_reason as an error rather than a stop', () => {
    expect(mapFinish({ stop_reason: 'refusal' })).toEqual({
      kind: 'error',
      failure: { message: 'model stopped: refusal', code: 'REFUSAL' },
    })
  })

  it('classifies is_error regardless of a success subtype', () => {
    expect(mapFinish({
      subtype: 'success', is_error: true, api_error_status: 429,
      terminal_reason: 'api_error', result: 'rate limited',
    })).toEqual({
      kind: 'error',
      failure: { message: 'rate limited', code: 'API_ERROR', status: 429 },
    })
  })

  it('describes a failed run the CLI left unexplained', () => {
    expect(mapFinish({ is_error: true })).toEqual({
      kind: 'error',
      failure: { message: 'claude CLI reported a failed run', code: 'CLI_ERROR' },
    })
  })

  it('omits a status the CLI reported as null', () => {
    expect(mapFinish({ is_error: true, api_error_status: null })).toMatchObject({
      failure: { code: 'CLI_ERROR' },
    })
    expect(mapFinish({ is_error: true, api_error_status: null }))
      .not.toHaveProperty('failure.status')
  })
})

describe('ClaudeCliFrameTranslator', () => {
  it('ignores every frame it does not own', () => {
    const translator = new ClaudeCliFrameTranslator()

    expect([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { model: '<synthetic>' } },
      { type: 'rate_limit_event' },
      { type: 'stream_event' },
      {},
    ].flatMap(frame => translator.translate(frame))).toEqual([])
  })

  it('opens, accumulates and closes a thinking block as reasoning', () => {
    const translator = new ClaudeCliFrameTranslator()

    const chunks = [
      streamed({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      streamed({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'we' } }),
      streamed({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta' } }),
      streamed({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'igh' } }),
      streamed({ type: 'content_block_stop', index: 0 }),
    ].flatMap(frame => translator.translate(frame))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'we' },
      { type: 'reasoning-delta', index: 0, text: 'igh' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'weigh' } },
    ])
  })

  it('assembles a tool call from its identity and argument deltas', () => {
    const translator = new ClaudeCliFrameTranslator()

    const chunks = [
      streamed({
        type: 'content_block_start', index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' },
      }),
      streamed({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"p"' } }),
      streamed({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':1}' } }),
      streamed({ type: 'content_block_stop', index: 1 }),
    ].flatMap(frame => translator.translate(frame))

    expect(chunks).toEqual([
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'toolu_1', name: 'read_file', argumentsDelta: '{"p"' },
      { type: 'tool-call-delta', index: 1, id: 'toolu_1', name: 'read_file', argumentsDelta: ':1}' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'toolu_1', name: 'read_file', arguments: '{"p":1}' } },
    ])
  })

  it('treats a text delta that carries no payload as empty rather than dropping it', () => {
    const translator = withOpenText()

    expect(translator.translate(streamed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta' } })))
      .toEqual([{ type: 'text-delta', index: 0, text: '' }])
  })

  it('treats a thinking delta that carries no payload as empty', () => {
    const translator = new ClaudeCliFrameTranslator()
    translator.translate(streamed({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }))

    expect(translator.translate(streamed({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta' } })))
      .toEqual([{ type: 'reasoning-delta', index: 0, text: '' }])
  })

  it('treats an argument delta that carries no payload as empty', () => {
    const translator = new ClaudeCliFrameTranslator()
    translator.translate(streamed({
      type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'n' },
    }))

    expect(translator.translate(streamed({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta' } })))
      .toEqual([{ type: 'tool-call-delta', index: 0, id: 't1', name: 'n', argumentsDelta: '' }])
  })

  it('defaults a tool call the wire never identified to empty identity', () => {
    const translator = new ClaudeCliFrameTranslator()
    translator.translate(streamed({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use' } }))

    expect(translator.translate(streamed({ type: 'content_block_stop', index: 0 })))
      .toEqual([{ type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: '', arguments: '' } }])
  })

  it('drops a block type it does not represent, and that block\'s deltas with it', () => {
    const translator = new ClaudeCliFrameTranslator()

    expect([
      streamed({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } }),
      streamed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }),
      streamed({ type: 'content_block_stop', index: 0 }),
    ].flatMap(frame => translator.translate(frame))).toEqual([])
  })

  it('ignores an unrecognized delta type on an open block', () => {
    const translator = withOpenText()

    expect(translator.translate(streamed({ type: 'content_block_delta', index: 0, delta: { type: 'audio_delta' } })))
      .toEqual([])
  })

  it('ignores block frames that carry no index', () => {
    const translator = withOpenText()

    expect([
      streamed({ type: 'content_block_start', content_block: { type: 'text' } }),
      streamed({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }),
      streamed({ type: 'content_block_stop' }),
    ].flatMap(frame => translator.translate(frame))).toEqual([])
  })

  it('ignores a stop for a block that was never opened', () => {
    const translator = new ClaudeCliFrameTranslator()

    expect(translator.translate(streamed({ type: 'content_block_stop', index: 7 }))).toEqual([])
  })

  it('reports the result frame usage in preference to the message_delta usage', () => {
    const translator = new ClaudeCliFrameTranslator()
    translator.translate(streamed({ type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 } }))

    expect(translator.translate({ type: 'result', usage: { input_tokens: 9, output_tokens: 9 } }))
      .toEqual([
        { type: 'usage', usage: { inputTokens: 9, outputTokens: 9, totalTokens: 18 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
  })

  it('falls back to the message_delta usage when the result carries none', () => {
    const translator = new ClaudeCliFrameTranslator()
    translator.translate(streamed({ type: 'message_delta', usage: { input_tokens: 4, output_tokens: 2 } }))

    expect(translator.translate({ type: 'result' })).toEqual([
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('finishes without a usage chunk when the run reported no counts at all', () => {
    expect(new ClaudeCliFrameTranslator().translate({ type: 'result' }))
      .toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('ignores a message_delta that carries no usage', () => {
    const translator = new ClaudeCliFrameTranslator()

    expect(translator.translate(streamed({ type: 'message_delta' }))).toEqual([])
  })

  it('emits nothing after the terminal finish', () => {
    const translator = new ClaudeCliFrameTranslator()
    translator.translate({ type: 'result' })

    expect(translator.translate(streamed({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })))
      .toEqual([])
    expect(translator.end({ kind: 'stop' })).toEqual([])
  })
})

describe('ClaudeCliFrameTranslator.end', () => {
  it('closes a run the CLI abandoned, reporting the counts it did send', () => {
    const translator = new ClaudeCliFrameTranslator()
    translator.translate(streamed({ type: 'message_delta', usage: { input_tokens: 5, output_tokens: 1 } }))

    expect(translator.end({ kind: 'aborted', failure: { message: 'killed', code: 'ABORTED' } })).toEqual([
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } },
      { type: 'finish', reason: { kind: 'aborted', failure: { message: 'killed', code: 'ABORTED' } } },
    ])
  })

  it('closes a run that produced no counts', () => {
    expect(new ClaudeCliFrameTranslator().end({ kind: 'stop' }))
      .toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })
})
