import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { SubprocessRuntime, type SubprocessHandle, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as LlmClaudeCli from '../src/index.ts'

/** A subprocess service that never runs anything; registration needs no process. */
class UnusedSubprocess extends SubprocessRuntime {
  override resolveExecutable(command: string): Promise<string> { return Promise.resolve(command) }
  override spawnTerminal(): Promise<never> { throw new Error('unused') }
  override spawn(_spec: SubprocessSpawnSpec): SubprocessHandle { throw new Error('unused') }
}

afterEach(() => { vi.unstubAllEnvs() })

/** Boot the seam, a process owner, and this plugin on one context. */
async function booted(config: Partial<LlmClaudeCli.Config> = {}) {
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-tenant')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(UnusedSubprocess)
  const fiber = await ctx.plugin(LlmClaudeCli, { cwd: '/workspace', home: '/srv/pool', ...config })
  return { ctx, fiber }
}

describe('resolveAdapterOptions', () => {
  const minimal = { cwd: '/workspace', home: '/srv/pool' }

  it('supplies every default a composition omitted', () => {
    expect(LlmClaudeCli.resolveAdapterOptions(minimal, { ANTHROPIC_API_KEY: 'sk-ant-tenant' })).toEqual({
      executable: LlmClaudeCli.DEFAULT_EXECUTABLE,
      cwd: '/workspace',
      isolation: { home: '/srv/pool', apiKey: 'sk-ant-tenant' },
      graceMs: LlmClaudeCli.DEFAULT_GRACE_MS,
      maxBudgetUsd: undefined,
      requireCredentialIsolation: true,
      maxOutputBytes: LlmClaudeCli.DEFAULT_MAX_OUTPUT_BYTES,
      maxStderrBytes: LlmClaudeCli.DEFAULT_MAX_STDERR_BYTES,
    })
  })

  it('keeps every value a composition named', () => {
    expect(LlmClaudeCli.resolveAdapterOptions({
      ...minimal,
      executable: '/opt/claude',
      apiKeyEnv: 'CANDY_TENANT_KEY',
      graceMs: 250,
      maxBudgetUsd: 0.5,
      requireCredentialIsolation: false,
      maxOutputBytes: 2_048,
      maxStderrBytes: 512,
    }, { CANDY_TENANT_KEY: 'sk-ant-other' })).toEqual({
      executable: '/opt/claude',
      cwd: '/workspace',
      isolation: { home: '/srv/pool', apiKey: 'sk-ant-other' },
      graceMs: 250,
      maxBudgetUsd: 0.5,
      requireCredentialIsolation: false,
      maxOutputBytes: 2_048,
      maxStderrBytes: 512,
    })
  })

  it.each([
    ['absent', {}],
    ['empty', { ANTHROPIC_API_KEY: '' }],
  ])('refuses a credential variable that is %s', (_case, environment) => {
    expect(() => LlmClaudeCli.resolveAdapterOptions(minimal, environment))
      .toThrow(/ANTHROPIC_API_KEY is not set/)
  })
})

describe('the llm-claude-cli plugin', () => {
  it('registers the claude-cli route and unregisters on dispose (HMR safety)', async () => {
    const { ctx, fiber } = await booted()
    expect(ctx.llm.listProviders()).toEqual([{ id: 'claude-cli', name: 'Claude CLI' }])

    await fiber.dispose()

    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('reads the credential from the configured variable', async () => {
    vi.stubEnv('CANDY_TENANT_KEY', 'sk-ant-other')
    const { ctx } = await booted({ apiKeyEnv: 'CANDY_TENANT_KEY' })

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['claude-cli'])
  })

  it('refuses to register a route it has no credential for', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(UnusedSubprocess)

    await expect(ctx.plugin(LlmClaudeCli, { cwd: '/workspace', home: '/srv/pool' }))
      .rejects.toThrow(/has no credential to inject/)
  })
})
