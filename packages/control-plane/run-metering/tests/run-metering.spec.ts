import { RunId } from '@deepseek-ai/dsh-control-plane'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RunBudget, RunSpend } from '@deepseek-ai/dsh-run-budget'
import { RunLedger } from '@deepseek-ai/dsh-run-ledger'
import { describe, expect, it } from 'vitest'
import { meterRun, RUN_BUDGET_EXHAUSTED, RUN_NOT_OPEN, type RunMeterPorts } from '../src/index.ts'

const RUN = RunId('run-1')
const NOW = 1_800_000_000_000

function budget(overrides: Partial<RunBudget> = {}): RunBudget {
  return { tokens: 1_000, wallMs: 60_000, costMicroUsd: 500_000, children: 2, ...overrides }
}

/** A ledger holding one open root, and the ports that meter against it. */
function metered(overrides: Partial<RunBudget> = {}, clock: () => number = () => NOW): {
  ledger: RunLedger
  ports: RunMeterPorts
  charges: RunSpend[]
} {
  const ledger = new RunLedger()
  ledger.openRoot(RUN, budget(overrides), NOW + 300_000)
  const charges: RunSpend[] = []
  return {
    ledger,
    charges,
    ports: {
      remaining: runId => ledger.remaining(runId),
      charge: (runId, spend) => {
        charges.push(spend)
        return Promise.resolve(ledger.charge(runId, spend))
      },
      now: clock,
    },
  }
}

async function* emits(...chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) yield chunk
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const seen: StreamChunk[] = []
  for await (const chunk of stream) seen.push(chunk)
  return seen
}

const TEXT: StreamChunk = { type: 'text-delta', index: 0, text: 'hi' }
const DONE: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }

describe('meterRun', () => {
  it('passes a stream through and charges what the call reported', async () => {
    const { ports, charges } = metered()

    const seen = await collect(meterRun(emits(
      TEXT,
      { type: 'usage', usage: { inputTokens: 30, outputTokens: 12, costMicroUsd: 900 } },
      DONE,
    ), RUN, ports))

    expect(seen).toHaveLength(3)
    expect(seen.at(-1)).toEqual(DONE)
    expect(charges).toEqual([{ tokens: 42, wallMs: 0, costMicroUsd: 900 }])
  })

  it('prefers the provider\'s own total to the sum of its counters', async () => {
    const { charges } = await run({ inputTokens: 30, outputTokens: 12, totalTokens: 50 })

    expect(charges[0]?.tokens).toBe(50)
  })

  it('counts a cached prompt when the provider reported no total', async () => {
    // `inputTokens` is uncached input only, so a call whose prompt was mostly a
    // cache hit would be charged at a fraction of what it cost.
    const { ports, charges } = metered()

    await collect(meterRun(emits(
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 6, cacheReadTokens: 90, cacheWriteTokens: 10 } },
      DONE,
    ), RUN, ports))

    expect(charges[0]?.tokens).toBe(110)
  })

  it('treats an unreported cost as unreported, not as zero spend', async () => {
    // A provider that stays silent leaves the money dimension alone; deriving a
    // figure from a price list would be indistinguishable from a real one.
    const { charges } = await run({ inputTokens: 1, outputTokens: 1 })

    expect(charges[0]?.costMicroUsd).toBe(0)
  })

  async function run(usage: { inputTokens: number; outputTokens: number; totalTokens?: number }): Promise<{ charges: RunSpend[] }> {
    const { ports, charges } = metered()
    await collect(meterRun(emits({ type: 'usage', usage }, DONE), RUN, ports))
    return { charges }
  }

  it('refuses the call before the provider is reached when the run has nothing left', async () => {
    // The check that matters: an exhausted run must not make the call whose own
    // usage would have reported the exhaustion.
    const { ports, ledger } = metered()
    ledger.charge(RUN, { tokens: 1_000, wallMs: 0, costMicroUsd: 0 })
    let reached = false
    async function* provider(): AsyncIterable<StreamChunk> {
      reached = true
      yield DONE
    }

    const seen = await collect(meterRun(provider(), RUN, ports))

    expect(reached).toBe(false)
    expect(seen).toEqual([{
      type: 'finish',
      reason: { kind: 'error', failure: { message: "run 'run-1' has spent tokens", code: RUN_BUDGET_EXHAUSTED } },
    }])
  })

  it('names every dimension a refused run has used up', async () => {
    const { ports, ledger } = metered()
    ledger.charge(RUN, { tokens: 1_000, wallMs: 60_000, costMicroUsd: 500_000 })

    const [finish] = await collect(meterRun(emits(DONE), RUN, ports))

    expect(finish).toMatchObject({
      reason: { failure: { message: "run 'run-1' has spent tokens, wallMs, costMicroUsd" } },
    })
  })

  it('refuses a call against a run that is not open', async () => {
    const { ports } = metered()

    const seen = await collect(meterRun(emits(DONE), RunId('run-absent'), ports))

    expect(seen).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: "run 'run-absent' is not open, so this call cannot be charged to it", code: RUN_NOT_OPEN },
      },
    }])
  })

  it('cuts a call that outruns the wall time its run had left', async () => {
    let clock = NOW
    const { ports, charges } = metered({ wallMs: 50 }, () => clock)
    async function* slow(): AsyncIterable<StreamChunk> {
      yield TEXT
      clock += 51
      yield TEXT
      yield TEXT
    }

    const seen = await collect(meterRun(slow(), RUN, ports))

    expect(seen).toEqual([TEXT, TEXT, {
      type: 'finish',
      reason: { kind: 'error', failure: { message: "run 'run-1' ran past the wall time it had left", code: RUN_BUDGET_EXHAUSTED } },
    }])
    expect(charges).toEqual([{ tokens: 0, wallMs: 51, costMicroUsd: 0 }])
  })

  it('charges what a cut call had already consumed', async () => {
    let clock = NOW
    const { ports, charges } = metered({ wallMs: 10 }, () => clock)
    async function* slow(): AsyncIterable<StreamChunk> {
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 5, costMicroUsd: 77 } }
      clock += 11
      yield TEXT
    }

    await collect(meterRun(slow(), RUN, ports))

    expect(charges).toEqual([{ tokens: 10, wallMs: 11, costMicroUsd: 77 }])
  })

  it('leaves the run open after a cut, so its caller decides what happens next', async () => {
    let clock = NOW
    const { ports, ledger } = metered({ wallMs: 5 }, () => clock)
    async function* slow(): AsyncIterable<StreamChunk> {
      yield TEXT
      clock += 6
      yield TEXT
    }

    await collect(meterRun(slow(), RUN, ports))

    expect(ledger.get(RUN)).toMatchObject({ spent: { wallMs: 6 } })
  })

  it('charges a source that ends without a terminal chunk', async () => {
    let clock = NOW
    const { ports, charges } = metered({}, () => clock)
    async function* truncated(): AsyncIterable<StreamChunk> {
      yield TEXT
      clock += 3
    }

    await collect(meterRun(truncated(), RUN, ports))

    expect(charges).toEqual([{ tokens: 0, wallMs: 3, costMicroUsd: 0 }])
  })

  it('reads the host clock when the caller brings none', async () => {
    const ledger = new RunLedger()
    ledger.openRoot(RUN, budget(), NOW + 300_000)
    const charges: RunSpend[] = []

    await collect(meterRun(emits(DONE), RUN, {
      remaining: runId => ledger.remaining(runId),
      charge: (runId, spend) => {
        charges.push(spend)
        return Promise.resolve(ledger.charge(runId, spend))
      },
    }))

    expect(charges).toHaveLength(1)
    expect(charges[0]?.wallMs).toBeGreaterThanOrEqual(0)
  })

  it('records no time when the host clock steps backwards mid-call', async () => {
    // The ledger rejects a negative spend as an arithmetic defect, so a clock
    // adjustment must not reach it as one.
    let clock = NOW
    const { ports, charges } = metered({}, () => clock)
    async function* adjusted(): AsyncIterable<StreamChunk> {
      clock -= 5_000
      yield DONE
    }

    await collect(meterRun(adjusted(), RUN, ports))

    expect(charges).toEqual([{ tokens: 0, wallMs: 0, costMicroUsd: 0 }])
  })

  it('charges once when the consumer stops reading part-way', async () => {
    const { ports, charges } = metered()
    const stream = meterRun(emits(TEXT, TEXT, DONE), RUN, ports)[Symbol.asyncIterator]()

    await stream.next()
    await stream.return?.(undefined)

    expect(charges).toHaveLength(1)
  })

  it('charges the call before its terminal chunk reaches the consumer', async () => {
    // The next call is admitted against a ledger that already knows about this
    // one; charging after the finish would let a loop make one call too many.
    const { ports, ledger } = metered()
    let remainingAtFinish: number | undefined
    const stream = meterRun(emits({ type: 'usage', usage: { inputTokens: 400, outputTokens: 0 } }, DONE), RUN, ports)

    for await (const chunk of stream) {
      if (chunk.type === 'finish') remainingAtFinish = ledger.remaining(RUN)?.tokens
    }

    expect(remainingAtFinish).toBe(600)
  })
})
