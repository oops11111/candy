import { UserId } from '@deepseek-ai/dsh-control-plane'
import type { AdmittedRun } from '@deepseek-ai/dsh-run-admission'
import { describe, expect, it } from 'vitest'
import { bindClaudeCliRun, type ClaudeCliDeployment } from '../src/index.ts'
import { admitFor, MAX_OUTPUT_BYTES, MAX_STDERR_BYTES } from './admit.ts'
const POOL_BASE = '/srv/candy/pools'
const DEPLOYMENT: ClaudeCliDeployment = {
  executable: '/opt/candy/bin/claude',
  graceMs: 5_000,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxStderrBytes: MAX_STDERR_BYTES,
}

/** Admit one run against a fixed pool base; no case here touches the filesystem. */
async function admitted(secret: Uint8Array, overrides: Parameters<typeof admitFor>[2] = {}): Promise<AdmittedRun> {
  return admitFor(secret, POOL_BASE, overrides)
}


const KEY = Buffer.from('sk-ant-alice', 'utf8')

describe('binding an admitted run to a Claude CLI launch', () => {
  it('takes every tenant-varying value from the admission', async () => {
    const run = await admitted(KEY)

    const result = bindClaudeCliRun(run, DEPLOYMENT, run.budget)

    expect(result).toEqual({
      bound: true,
      binding: {
        executable: '/opt/candy/bin/claude',
        cwd: run.poolRoot,
        isolation: { home: run.poolRoot, apiKey: 'sk-ant-alice' },
        graceMs: 5_000,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        maxStderrBytes: MAX_STDERR_BYTES,
        maxBudgetUsd: 2.5,
        requireCredentialIsolation: true,
      },
    })
  })

  it('gives two tenants different homes and different keys', async () => {
    const alice = await admitted(Buffer.from('sk-ant-alice', 'utf8'))
    const bob = await admitted(Buffer.from('sk-ant-bob', 'utf8'), { userId: UserId('user-bob') })

    const first = bindClaudeCliRun(alice, DEPLOYMENT, alice.budget)
    const second = bindClaudeCliRun(bob, DEPLOYMENT, bob.budget)

    if (!first.bound || !second.bound) throw new Error('both fixture runs are admitted')
    expect(first.binding.isolation.home).not.toBe(second.binding.isolation.home)
    expect(first.binding.isolation.apiKey).not.toBe(second.binding.isolation.apiKey)
  })

  it('puts the process under the pool root the admission resolved, not the deployment base', async () => {
    const run = await admitted(KEY)

    const result = bindClaudeCliRun(run, DEPLOYMENT, run.budget)

    if (!result.bound) throw new Error('the fixture run is admitted')
    // Confinement is the point: a home left at the shared base would put every
    // tenant's CLI state in one directory.
    expect(result.binding.isolation.home.startsWith(`${POOL_BASE}/`)).toBe(true)
    expect(result.binding.isolation.home).not.toBe(POOL_BASE)
    expect(result.binding.cwd).toBe(result.binding.isolation.home)
  })

  it('derives the spend ceiling from the allowance this invocation was given', async () => {
    const run = await admitted(KEY)

    const result = bindClaudeCliRun(run, DEPLOYMENT, { ...run.budget, costMicroUsd: 1_234_567 })

    if (!result.bound) throw new Error('the fixture run is admitted')
    expect(result.binding.maxBudgetUsd).toBe(1.234567)
  })

  it('caps a later invocation at what the run has left, not what it started with', async () => {
    const run = await admitted(KEY)

    const first = bindClaudeCliRun(run, DEPLOYMENT, run.budget)
    // The CLI enforces its ceiling per invocation, so a run whose every call
    // carried the admitted budget could spend that budget once per call.
    const later = bindClaudeCliRun(run, DEPLOYMENT, { ...run.budget, costMicroUsd: 400_000 })

    if (!first.bound || !later.bound) throw new Error('the fixture run is admitted')
    expect(first.binding.maxBudgetUsd).toBe(2.5)
    expect(later.binding.maxBudgetUsd).toBe(0.4)
  })

  it('never leaves credential isolation to the deployment', async () => {
    const run = await admitted(KEY)

    const result = bindClaudeCliRun(run, DEPLOYMENT, run.budget)

    // A run that authenticated with some other credential is billing a tenant
    // that did not authorize it, so no configuration may turn this off.
    if (!result.bound) throw new Error('the fixture run is admitted')
    expect(result.binding.requireCredentialIsolation).toBe(true)
  })

  it('passes the deployment facts through unchanged', async () => {
    const run = await admitted(KEY)

    const result = bindClaudeCliRun(
      run,
      { executable: '/usr/local/bin/claude', graceMs: 250, maxOutputBytes: 4_096, maxStderrBytes: 256 },
      run.budget,
    )

    if (!result.bound) throw new Error('the fixture run is admitted')
    expect(result.binding.executable).toBe('/usr/local/bin/claude')
    expect(result.binding.graceMs).toBe(250)
    expect(result.binding.maxOutputBytes).toBe(4_096)
  })
})

describe('an allowance with nothing left', () => {
  it('is refused rather than becoming a ceiling the CLI would reject', async () => {
    const run = await admitted(KEY)

    const result = bindClaudeCliRun(run, DEPLOYMENT, { ...run.budget, costMicroUsd: 0 })

    // `claudeCliArguments` rejects a zero ceiling, so binding a spent run
    // would surface as a RangeError from inside the adapter at stream time.
    expect(result).toEqual({ bound: false, rejection: 'no-allowance' })
  })

  it.each([['tokens'], ['wallMs'], ['costMicroUsd']] as const)('is refused when %s is gone', async (dimension) => {
    const run = await admitted(KEY)

    expect(bindClaudeCliRun(run, DEPLOYMENT, { ...run.budget, [dimension]: 0 }))
      .toMatchObject({ bound: false, rejection: 'no-allowance' })
  })

  it('still binds a run that has only its delegation slots spent', async () => {
    const run = await admitted(KEY)

    // A run with no child slots left can still do its own work; refusing it
    // would confuse "cannot delegate" with "cannot proceed".
    expect(bindClaudeCliRun(run, DEPLOYMENT, { ...run.budget, children: 0 }))
      .toMatchObject({ bound: true })
  })
})

describe('a credential that cannot become an environment variable', () => {
  it.each([
    ['empty', new Uint8Array(0), 'empty'],
    ['invalid UTF-8', Uint8Array.from([0x73, 0x6b, 0xff, 0xfe]), 'not-utf8'],
    ['a NUL byte', Buffer.from('sk-ant\0-alice', 'utf8'), 'control-characters'],
    ['a newline', Buffer.from('sk-ant\nALSO=1', 'utf8'), 'control-characters'],
    ['a carriage return', Buffer.from('sk-ant\rALSO=1', 'utf8'), 'control-characters'],
  ])('refuses %s rather than repairing it', async (_case, secret, rejection) => {
    const run = await admitted(KEY)

    const result = bindClaudeCliRun({ ...run, secret }, DEPLOYMENT, run.budget)

    expect(result).toEqual({ bound: false, rejection })
  })

  it('produces no launch at all when it refuses', async () => {
    const run = await admitted(KEY)

    const result = bindClaudeCliRun({ ...run, secret: new Uint8Array(0) }, DEPLOYMENT, run.budget)

    // A partial launch would run the CLI under the tenant's home with whatever
    // credential the ambient environment happened to hold.
    expect('binding' in result).toBe(false)
  })
})
