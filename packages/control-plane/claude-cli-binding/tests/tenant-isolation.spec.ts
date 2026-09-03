/**
 * The isolation claim, exercised end to end: mint an assertion, admit it, bind
 * it, and run a real process through `dsh-subprocess`.
 *
 * Every other spec in this chain checks one link. This one checks that the
 * links hold together where it matters — what the operating system hands the
 * child. The stand-in executable reports the environment it was actually
 * given, so a home or a key that leaked between tenants shows up as a value in
 * the model's own output rather than as an assertion about an object.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { UserId } from '@deepseek-ai/dsh-control-plane'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ClaudeCliAdapter } from '@deepseek-ai/dsh-llm-claude-cli'
import type { AdmittedRun } from '@deepseek-ai/dsh-run-admission'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { openRuntimePool } from '@deepseek-ai/dsh-runtime-pool'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bindClaudeCliRun, type ClaudeCliDeployment } from '../src/index.ts'
import { admitFor } from './admit.ts'

/**
 * A stand-in `claude` that answers with the environment it was handed.
 *
 * `apiKeySource` mirrors the real CLI's init frame, so a run told to report
 * `none` exercises the credential-isolation refusal without a real provider.
 * With `STAND_IN_PIDS` set it also starts a child of its own and then hangs,
 * standing in for a CLI that is still working and has a tool process running.
 */
const STAND_IN = `
const say = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
const source = process.env.STAND_IN_KEY_SOURCE ?? 'ANTHROPIC_API_KEY'
say({ type: 'system', subtype: 'init', apiKeySource: source })
const report = JSON.stringify({
  home: process.env.HOME,
  cwd: process.cwd(),
  key: process.env.ANTHROPIC_API_KEY ?? 'absent',
  routed: process.env.CLAUDE_CODE_USE_BEDROCK ?? 'absent',
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? 'absent',
  probe: process.env.STAND_IN_AMBIENT_PROBE ?? 'absent',
  budget: process.argv.includes('--max-budget-usd')
    ? process.argv[process.argv.indexOf('--max-budget-usd') + 1]
    : 'absent',
})
say({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } })
say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: report } } })
const pidFile = process.env.STAND_IN_PIDS
if (pidFile !== undefined) {
  const { spawn } = await import('node:child_process')
  const { writeFileSync, renameSync } = await import('node:fs')
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  writeFileSync(pidFile + '.tmp', JSON.stringify({ cli: process.pid, child: child.pid }))
  renameSync(pidFile + '.tmp', pidFile)
  // Hang: a run that never reaches its result frame is what cancellation and
  // abandonment have to clean up.
  setInterval(() => {}, 1000)
} else {
  say({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  say({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 1 } })
}
`

let root: string
let executable: string
let ctx: Context

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-tenant-isolation-'))
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
  // A failing cleanup case must not leave its processes running for the rest
  // of the suite; the assertions are what decide whether the run was reaped.
  for (const pid of started.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone, which is the passing case */ }
  }
  await rm(root, { recursive: true, force: true })
})

/** Every pid the stand-in reported, killed in teardown whatever the outcome. */
const started: number[] = []

const REAP_DEADLINE_MS = 5_000
const REAP_POLL_MS = 10

/** Whether a pid is still addressable by this process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: no such process. A live pid this test lacks permission to signal
    // cannot occur, since every one of them is this process's own descendant.
    return false
  }
}

/** Wait until neither pid is addressable, or give up so the assertion reports it. */
async function reaped(pids: readonly number[]): Promise<boolean> {
  const deadline = Date.now() + REAP_DEADLINE_MS
  while (Date.now() < deadline) {
    if (!pids.some(alive)) return true
    await new Promise(resolve => setTimeout(resolve, REAP_POLL_MS))
  }
  return false
}

/** Read the pids the stand-in reported once its rename has published them. */
async function reportedPids(path: string): Promise<{ cli: number; child: number }> {
  const deadline = Date.now() + REAP_DEADLINE_MS
  while (Date.now() < deadline) {
    try {
      const pids = JSON.parse(await readFile(path, 'utf8')) as { cli: number; child: number }
      started.push(pids.cli, pids.child)
      return pids
    } catch {
      // The file appears atomically by rename; until then there is nothing to read.
      await new Promise(resolve => setTimeout(resolve, REAP_POLL_MS))
    }
  }
  throw new Error('the stand-in never reported its pids')
}

/** Admit one run against this case's own temporary pool base. */
async function admitted(secret: string, overrides: Parameters<typeof admitFor>[2] = {}): Promise<AdmittedRun> {
  return admitFor(Buffer.from(secret, 'utf8'), join(root, 'pools'), overrides)
}


/** The whole chain for one tenant: admit, bind, spawn, assemble. */
async function runFor(
  secret: string,
  overrides: Parameters<typeof admitFor>[2] = {},
  env: NodeJS.ProcessEnv = {},
): Promise<{ text: string; run: AdmittedRun }> {
  const run = await admitted(secret, overrides)
  // Creating the pool directory is the deployment's, not the binding's; a
  // launch into a directory nobody made fails at spawn.
  await openRuntimePool(join(root, 'pools'), run.poolKey)
  const deployment: ClaudeCliDeployment = { executable: process.execPath, graceMs: 2_000 }
  const result = bindClaudeCliRun(run, deployment, run.budget)
  if (!result.bound) throw new Error(`the fixture run would not bind: ${result.rejection}`)
  const adapter = new ClaudeCliAdapter({
    ...result.binding,
    // The stand-in is a script, so the executable is node and the script is
    // its first argument; everything else about the launch is the binding's.
    spawn: spec => ctx.subprocess.spawn({
      ...spec,
      argv: [spec.argv[0] ?? '', executable, ...spec.argv.slice(1)],
      env: { ...spec.env, ...env },
    }),
  })
  const assembler = new BlockAssembler()
  for await (const chunk of adapter.stream({
    provider: 'claude-cli',
    model: 'claude-sonnet-5',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'report' }], source: { kind: 'user' } })],
  })) {
    assembler.push(chunk)
  }
  const block = assembler.blocks().find(candidate => candidate.type === 'text')
  return { text: block?.type === 'text' ? block.text : '', run }
}

/**
 * Start a run whose stand-in spawns a child and then hangs, and read far
 * enough into it that both processes exist.
 * @returns the live chunk stream and the pids the stand-in reported.
 */
async function startHangingRun(signal?: AbortSignal): Promise<{
  chunks: AsyncIterator<StreamChunk>
  pids: { cli: number; child: number }
}> {
  const run = await admitted('sk-ant-alice')
  await openRuntimePool(join(root, 'pools'), run.poolKey)
  const result = bindClaudeCliRun(run, { executable: process.execPath, graceMs: 2_000 }, run.budget)
  if (!result.bound) throw new Error(`the fixture run would not bind: ${result.rejection}`)
  const pidFile = join(root, 'stand-in-pids.json')
  const adapter = new ClaudeCliAdapter({
    ...result.binding,
    spawn: spec => ctx.subprocess.spawn({
      ...spec,
      argv: [spec.argv[0] ?? '', executable, ...spec.argv.slice(1)],
      env: { ...spec.env, STAND_IN_PIDS: pidFile },
    }),
  })
  const chunks = adapter.stream({
    provider: 'claude-cli',
    model: 'claude-sonnet-5',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'report' }], source: { kind: 'user' } })],
    ...signal === undefined ? {} : { signal },
  })[Symbol.asyncIterator]()
  // Reading to the first text delta proves the stand-in reached the point
  // where it starts its child.
  while (true) {
    const next = await chunks.next()
    if (next.done === true) throw new Error('the hanging run finished on its own')
    if (next.value.type === 'text-delta') break
  }
  return { chunks, pids: await reportedPids(pidFile) }
}

describe('cancelling a run reaps what it started', () => {
  it('kills the CLI and the process it spawned when the run is cancelled', async () => {
    const controller = new AbortController()
    const { chunks, pids } = await startHangingRun(controller.signal)
    expect(alive(pids.cli) && alive(pids.child)).toBe(true)

    controller.abort()
    await chunks.next()

    // A CLI reaped alone leaves its tool process running under init, still
    // holding the tenant's workspace open and still costing the host.
    expect(await reaped([pids.cli, pids.child])).toBe(true)
  })

  it('kills both when a consumer stops reading instead of cancelling', async () => {
    const { chunks, pids } = await startHangingRun()
    expect(alive(pids.cli) && alive(pids.child)).toBe(true)

    // Abandoning the stream is the case a caller reaches by returning early;
    // nothing signals the run, so only the generator's own teardown can reap it.
    await chunks.return?.(undefined)

    expect(await reaped([pids.cli, pids.child])).toBe(true)
  })
})

describe('a tenant run, from token to process', () => {
  it('hands the child that tenant\'s home, working directory, and key', async () => {
    const { text, run } = await runFor('sk-ant-alice')

    expect(JSON.parse(text)).toEqual({
      home: run.poolRoot,
      cwd: run.poolRoot,
      key: 'sk-ant-alice',
      routed: 'absent',
      baseUrl: 'absent',
      probe: 'absent',
      budget: '2.5',
    })
  })

  it('tombstones the ambient routing variables that would redirect the run', async () => {
    const restore = { ...process.env }
    process.env['CLAUDE_CODE_USE_BEDROCK'] = '1'
    process.env['ANTHROPIC_BASE_URL'] = 'https://gateway.example/v1'
    process.env['STAND_IN_AMBIENT_PROBE'] = 'present'
    try {
      const { text } = await runFor('sk-ant-alice')

      // Either routing variable would send the run to a provider that
      // authenticates with the host's own credentials, spending nobody's
      // tenant budget and leaving the injected key unused. The probe is the
      // control: an ordinary ambient entry does reach the child, so their
      // absence is the tombstone rather than a child with no inherited
      // environment at all.
      expect(JSON.parse(text)).toMatchObject({ routed: 'absent', baseUrl: 'absent', probe: 'present' })
    } finally {
      process.env = restore
    }
  })

  it('gives two tenants two homes and never crosses their keys', async () => {
    const alice = await runFor('sk-ant-alice')
    const bob = await runFor('sk-ant-bob', { userId: UserId('user-bob'), nonce: 'nonce-2' })

    const first = JSON.parse(alice.text) as { home: string; key: string }
    const second = JSON.parse(bob.text) as { home: string; key: string }
    expect(first.home).not.toBe(second.home)
    expect(first.key).toBe('sk-ant-alice')
    expect(second.key).toBe('sk-ant-bob')
    // The claim is not merely that they differ: neither process could see the
    // other's secret at all.
    expect(alice.text).not.toContain('sk-ant-bob')
    expect(bob.text).not.toContain('sk-ant-alice')
  })

  it('fails a run that authenticated with anything but the injected key', async () => {
    // A run that reached some other credential is billing a tenant that did
    // not authorize it, so the isolation the binding always requires must stop
    // it at the CLI's own report rather than let it finish.
    await expect(runFor('sk-ant-alice', {}, { STAND_IN_KEY_SOURCE: 'none' }))
      .rejects.toThrow(/did not inject/)
  })

  it('carries the admitted budget to the process as its spend ceiling', async () => {
    const { text } = await runFor('sk-ant-alice')

    expect((JSON.parse(text) as { budget: string }).budget).toBe('2.5')
  })
})
