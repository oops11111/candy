/**
 * The accounting loop, over a real process: admit a run, open it in a ledger,
 * launch it, charge the ledger with what the run reported, and close it.
 *
 * This is where the pieces meet. `dsh-run-admission` supplies the allowance,
 * this package turns it into a launch, the adapter reports usage and cost, and
 * `dsh-run-ledger` records the spend. Each has its own tests; none of them can
 * show that a second invocation of one run is capped by what that run has left.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { ClaudeCliAdapter } from '@deepseek-ai/dsh-llm-claude-cli'
import type { AdmittedRun } from '@deepseek-ai/dsh-run-admission'
import type { RunBudget, RunSpend } from '@deepseek-ai/dsh-run-budget'
import { RunLedger } from '@deepseek-ai/dsh-run-ledger'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { openRuntimePool } from '@deepseek-ai/dsh-runtime-pool'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bindClaudeCliRun } from '../src/index.ts'
import { admitFor, BUDGET, MAX_OUTPUT_BYTES, NOW } from './admit.ts'

/** A stand-in that reports the ceiling it was given and bills a fixed amount. */
const STAND_IN = `
const say = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
say({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' })
const ceiling = process.argv[process.argv.indexOf('--max-budget-usd') + 1]
say({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } })
say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ceiling } } })
say({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
say({
  type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn',
  total_cost_usd: 0.5,
  usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 },
})
`

const LEASE = NOW + 60_000

let root: string
let executable: string
let ctx: Context

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-run-accounting-'))
  // The pool base is the deployment's storage; `openRuntimePool` creates a
  // pool inside it and refuses to invent the base itself.
  await mkdir(join(root, 'pools'), { mode: 0o700 })
  executable = join(root, 'stand-in-claude.mjs')
  await writeFile(executable, STAND_IN, 'utf8')
  ctx = new Context()
  await ctx.plugin(SubprocessLocal)
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/**
 * What a run consumed, in the ledger's terms.
 *
 * Billed tokens are the disjoint counts summed; reasoning tokens are already
 * inside `outputTokens` and are not added again. An absent cost is charged as
 * nothing, which is what "not reported" means — a caller that needs a provider
 * to report one checks for it before charging.
 */
function spendOf(usage: TokenUsage, wallMs: number): RunSpend {
  return {
    tokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens,
    wallMs,
    costMicroUsd: usage.costMicroUsd ?? 0,
  }
}

/** Run one invocation under the given allowance, and report what it billed. */
async function invoke(run: AdmittedRun, allowance: RunBudget): Promise<{ ceiling: string; usage: TokenUsage }> {
  const result = bindClaudeCliRun(run, { executable: process.execPath, graceMs: 2_000, maxOutputBytes: MAX_OUTPUT_BYTES }, allowance)
  if (!result.bound) throw new Error(`the fixture run would not bind: ${result.rejection}`)
  const adapter = new ClaudeCliAdapter({
    ...result.binding,
    spawn: spec => ctx.subprocess.spawn({
      ...spec,
      argv: [spec.argv[0] ?? '', executable, ...spec.argv.slice(1)],
    }),
  })
  const assembler = new BlockAssembler()
  for await (const chunk of adapter.stream({
    provider: 'claude-cli',
    model: 'claude-sonnet-5',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'report' }], source: { kind: 'user' } })],
  })) assembler.push(chunk)
  const block = assembler.blocks().find(candidate => candidate.type === 'text')
  const usage = assembler.usage
  if (usage === undefined) throw new Error('the stand-in reported no usage')
  return { ceiling: block?.type === 'text' ? block.text : '', usage }
}

describe('charging a run for what it actually spent', () => {
  it('carries the reported cost from the process into the ledger', async () => {
    const run = await admitFor(Buffer.from('sk-ant-alice', 'utf8'), join(root, 'pools'))
    await openRuntimePool(join(root, 'pools'), run.poolKey)
    const ledger = new RunLedger()
    ledger.openRoot(run.claims.runId, run.budget, LEASE)

    const { usage } = await invoke(run, run.budget)
    const charged = ledger.charge(run.claims.runId, spendOf(usage, 1_000))

    // 0.5 USD billed by the CLI, and the four disjoint counts summed.
    expect(usage.costMicroUsd).toBe(500_000)
    expect(charged).toMatchObject({ ok: true, value: { exhausted: [] } })
    expect(ledger.remaining(run.claims.runId))
      .toMatchObject({ costMicroUsd: BUDGET.costMicroUsd - 500_000, tokens: BUDGET.tokens - 12 })
  })

  it('caps a second invocation at what the first left', async () => {
    const run = await admitFor(Buffer.from('sk-ant-alice', 'utf8'), join(root, 'pools'))
    await openRuntimePool(join(root, 'pools'), run.poolKey)
    const ledger = new RunLedger()
    ledger.openRoot(run.claims.runId, run.budget, LEASE)

    const first = await invoke(run, run.budget)
    ledger.charge(run.claims.runId, spendOf(first.usage, 1_000))
    const remaining = ledger.remaining(run.claims.runId)
    if (remaining === undefined) throw new Error('the fixture run is open')
    const second = await invoke(run, remaining)

    // The CLI enforces its ceiling per invocation. A run whose every call
    // carried the admitted budget could spend that budget once per call, which
    // is the whole point of charging between them.
    expect(first.ceiling).toBe('2.5')
    expect(second.ceiling).toBe('2')
  })

  it('settles the run for everything it spent across its invocations', async () => {
    const run = await admitFor(Buffer.from('sk-ant-alice', 'utf8'), join(root, 'pools'))
    await openRuntimePool(join(root, 'pools'), run.poolKey)
    const ledger = new RunLedger()
    ledger.openRoot(run.claims.runId, run.budget, LEASE)

    for (const _ of [0, 1]) {
      const remaining = ledger.remaining(run.claims.runId) ?? run.budget
      const { usage } = await invoke(run, remaining)
      ledger.charge(run.claims.runId, spendOf(usage, 1_000))
    }
    const settled = ledger.close(run.claims.runId)

    expect(settled).toMatchObject({
      ok: true,
      value: { spent: { tokens: 24, wallMs: 2_000, costMicroUsd: 1_000_000 } },
    })
    expect(ledger.open()).toEqual([])
  })
})
