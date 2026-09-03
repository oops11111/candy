import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { ClaudeCliFrameTranslator, ClaudeCliLineDecoder, isCredentialIsolated } from '../src/index.ts'

/**
 * Both fixtures are real `claude` 2.1.259 stdout, recorded through the flags
 * {@link claudeCliArguments} builds. Session ids, uuids, host paths and account
 * telemetry are normalized, and the payloads of frames this protocol ignores
 * are emptied; every frame's type, order and acted-on fields are as recorded.
 */
function recorded(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
}

/** Replay one recorded run exactly as the adapter will: decode, then translate. */
function replay(name: string): StreamChunk[] {
  const decoder = new ClaudeCliLineDecoder()
  const translator = new ClaudeCliFrameTranslator()
  const frames = [...decoder.push(recorded(name)), ...decoder.flush()]
  return frames.flatMap(frame => translator.translate(frame))
}

describe('a recorded text turn', () => {
  it('yields one text block and a normal finish', () => {
    expect(replay('text-turn.jsonl')).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
      {
        type: 'usage',
        usage: {
          inputTokens: 2,
          outputTokens: 4,
          totalTokens: 11_568,
          cacheReadTokens: 3289,
          cacheWriteTokens: 8273,
          reasoningTokens: 0,
          // 0.0347348 USD, the recorded run's own billed total across every
          // model the CLI ran for it.
          costMicroUsd: 34_735,
        },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('emits the text once, though the CLI also delivers it as an assistant frame', () => {
    const text = replay('text-turn.jsonl').filter(chunk => chunk.type === 'text-delta')

    expect(text).toHaveLength(1)
  })

  it('ignores the session, rate-limit and status frames interleaved with the turn', () => {
    const decoder = new ClaudeCliLineDecoder()
    const frames = decoder.push(recorded('text-turn.jsonl'))
    const ignored = frames.filter(frame => frame.type !== 'stream_event' && frame.type !== 'result')

    // active_goal, autocompact_state, rate_limit_event, three system frames
    // and one assistant frame: every one of them produces no chunk.
    expect(ignored.length).toBeGreaterThan(0)
    const translator = new ClaudeCliFrameTranslator()
    expect(ignored.flatMap(frame => translator.translate(frame))).toEqual([])
  })
})

describe('a recorded authentication failure', () => {
  it('finishes as an error carrying the provider status', () => {
    const chunks = replay('auth-failure.jsonl')

    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'Authentication error · This may be a temporary network issue, please try again',
          code: 'API_ERROR',
          status: 401,
        },
      },
    })
  })

  it('reports the failed run as having cost nothing, rather than reporting nothing', () => {
    const usage = replay('auth-failure.jsonl').find(chunk => chunk.type === 'usage')

    // The CLI billed zero for a run whose every request was refused. A charge
    // of zero and an unknown charge are different facts to a budget.
    expect(usage).toMatchObject({ usage: { costMicroUsd: 0 } })
  })

  it('does not report the failure text as model output', () => {
    // The CLI synthesizes an assistant frame whose content is the failure
    // message. Reading those frames would put it in the transcript as a turn.
    const chunks = replay('auth-failure.jsonl')

    expect(chunks.some(chunk => chunk.type === 'text-delta' || chunk.type === 'block-start')).toBe(false)
  })

  it('finishes as an error even though the run reports subtype "success"', () => {
    const result = recorded('auth-failure.jsonl')
      .split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { type?: string; subtype?: string })
      .find(frame => frame.type === 'result')

    expect(result?.subtype).toBe('success')
    expect(replay('auth-failure.jsonl').at(-1)).toMatchObject({ reason: { kind: 'error' } })
  })

  it('proves the run used the injected credential and not an ambient login', () => {
    const decoder = new ClaudeCliLineDecoder()
    const isolation = decoder.push(recorded('auth-failure.jsonl'))
      .map(frame => isCredentialIsolated(frame))
      .filter(verdict => verdict !== undefined)

    // Recorded under --bare with ANTHROPIC_API_KEY set: exactly one init
    // frame, reporting that key as the source.
    expect(isolation).toEqual([true])
  })

  it('reports no isolation verdict for a run recorded without an injected key', () => {
    const decoder = new ClaudeCliLineDecoder()
    const verdicts = decoder.push(recorded('text-turn.jsonl'))
      .map(frame => isCredentialIsolated(frame))
      .filter(verdict => verdict !== undefined)

    // Recorded without --bare: the CLI authenticated through the host's own
    // login and reported apiKeySource "none".
    expect(verdicts).toEqual([false])
  })
})
