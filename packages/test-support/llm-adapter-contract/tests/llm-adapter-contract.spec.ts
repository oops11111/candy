/**
 * The contract suite's own tests. A suite that cannot fail proves nothing
 * about the adapters it runs against, so each case here drives the suite with
 * a deliberately non-conforming subject and asserts which case rejects it.
 */

import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  testLlmAdapterContract,
  type LlmAdapterContractHarness,
  type LlmAdapterContractSubject,
} from '../src/index.ts'

const SECRET = 'sk-suite-secret'

/** A harness that records the suite's cases instead of registering them. */
function recordingHarness(): {
  harness: LlmAdapterContractHarness
  run: () => Promise<Map<string, string | undefined>>
} {
  const cases: { name: string; body: () => Promise<void> | void }[] = []
  let failure: string | undefined
  const harness: LlmAdapterContractHarness = {
    describe: (_name, body) => { body() },
    it: (name, body) => { cases.push({ name, body }) },
    expect: value => ({
      toBe: (expected) => {
        if (!Object.is(value, expected)) failure ??= `expected ${String(value)} to be ${String(expected)}`
      },
      toBeGreaterThan: (expected) => {
        if (typeof value !== 'number' || value <= expected) failure ??= `expected ${String(value)} > ${String(expected)}`
      },
    }),
  }
  const run = async (): Promise<Map<string, string | undefined>> => {
    const outcomes = new Map<string, string | undefined>()
    for (const entry of cases) {
      failure = undefined
      try {
        await entry.body()
      } catch (error) {
        failure ??= error instanceof Error ? error.message : String(error)
      }
      outcomes.set(entry.name, failure)
    }
    return outcomes
  }
  return { harness, run }
}

/** A complete, well-behaved run: one text block and a terminal finish. */
async function* conformingRun(): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'ok' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** A stream that yields once and then never ends, standing in for an open run. */
async function* neverEndingRun(): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  await new Promise(() => {})
}

function subject(overrides: Partial<LlmAdapterContractSubject> = {}): LlmAdapterContractSubject {
  return {
    name: 'Fake',
    secret: SECRET,
    run: () => conformingRun(),
    failingRun: () => conformingRun(),
    leakingRun: () => conformingRun(),
    openRun: () => ({ chunks: neverEndingRun(), released: () => true }),
    ...overrides,
  }
}

/** Run the suite against one subject and report each case's failure, if any. */
async function outcomesFor(over: Partial<LlmAdapterContractSubject>): Promise<Map<string, string | undefined>> {
  const { harness, run } = recordingHarness()
  testLlmAdapterContract(subject(over), harness)
  return run()
}

/** The names of the cases that rejected this subject. */
function rejected(outcomes: Map<string, string | undefined>): string[] {
  return [...outcomes].filter(([, failure]) => failure !== undefined).map(([name]) => name)
}

describe('the contract suite', () => {
  it('accepts a conforming adapter', async () => {
    expect(rejected(await outcomesFor({}))).toEqual([])
  })

  it('rejects a run that ends without a terminal chunk', async () => {
    async function* bare(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
    }

    expect(rejected(await outcomesFor({ run: () => bare(), failingRun: () => bare() })))
      .toContain('finishes a failing run rather than ending the stream bare')
  })

  it('rejects a run that finishes more than once', async () => {
    async function* twice(): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

    expect(rejected(await outcomesFor({ run: () => twice() })))
      .toContain('finishes a normal run with exactly one terminal chunk')
  })

  it('rejects an adapter that never releases an abandoned run', async () => {
    const outcomes = await outcomesFor({
      openRun: () => ({ chunks: neverEndingRun(), released: () => false }),
    })

    expect(rejected(outcomes)).toContain('releases the run a consumer stops reading')
  })

  it('rejects a secret carried in a chunk', async () => {
    async function* leaky(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `key is ${SECRET}` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

    expect(rejected(await outcomesFor({ run: () => leaky() })))
      .toContain('emits no chunk carrying the secret')
  })

  it('rejects a secret carried in a failure the adapter reports', async () => {
    async function* leaky(): AsyncIterable<StreamChunk> {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: `rejected ${SECRET}`, code: 'AUTH' } },
      }
    }

    expect(rejected(await outcomesFor({ failingRun: () => leaky() })))
      .toContain('reports a failure without the secret in it')
  })

  it('rejects a secret carried in a thrown error, including through its cause', async () => {
    async function* throwing(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      throw new Error('request failed', { cause: new Error(`sent ${SECRET}`) })
    }

    const outcomes = await outcomesFor({ failingRun: () => throwing() })

    expect(rejected(outcomes)).toContain('throws no error carrying the secret')
  })

  it('searches an error that carries no stack', async () => {
    async function* throwing(): AsyncIterable<StreamChunk> {
      const error = new Error(`sent ${SECRET}`)
      // Some runtimes and deliberately stripped errors arrive without one.
      delete (error as { stack?: string }).stack
      yield { type: 'block-start', index: 0, blockType: 'text' }
      throw error
    }

    expect(rejected(await outcomesFor({ failingRun: () => throwing() })))
      .toContain('throws no error carrying the secret')
  })

  it('rejects a normal run that produces nothing at all', async () => {
    async function* empty(): AsyncIterable<StreamChunk> {
      // Nothing: an adapter that yields no chunks would pass every leak check
      // vacuously, so the suite requires output before it trusts them.
      await Promise.resolve()
    }

    expect(rejected(await outcomesFor({ run: () => empty() })))
      .toContain('emits no chunk carrying the secret')
  })
})
