/**
 * Real-composition guard: LlmRuntime, a subprocess provider, and
 * llm-claude-cli boot from a test-only cordis.yml through the actual Loader +
 * Include path, and a request routed to the registered provider reaches the
 * `dsh-llm` seam as translated chunks. The CLI process itself is the external
 * service this test replaces; everything between the seam and the spawn spec
 * is the real chain.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  SubprocessRuntime,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import * as LlmClaudeCli from '@deepseek-ai/dsh-llm-claude-cli'
import { afterEach, describe, expect, it, vi } from 'vitest'

const RECORDED = readFileSync(fileURLToPath(
  new URL('../../claude-cli-protocol/tests/fixtures/text-turn.jsonl', import.meta.url),
), 'utf8')

/** The one external service this composition replaces: the CLI process. */
class RecordedSubprocess extends SubprocessRuntime {
  static spawns: SubprocessSpawnSpec[] = []

  override resolveExecutable(command: string): Promise<string> { return Promise.resolve(command) }

  override spawnTerminal(): Promise<never> {
    throw new Error('llm-claude-cli spawns pipes, never terminals')
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    RecordedSubprocess.spawns.push(spec)
    return {
      pid: 1234,
      stdin: undefined,
      stdout: Readable.from([RECORDED]),
      stderr: undefined,
      collected: {},
      done: Promise.resolve<SubprocessOutcome>({ exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  RecordedSubprocess.spawns = []
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

/** Boot one already-written cordis.yml through the real Loader + Include path. */
async function bootFrom(configPath: string): Promise<Context> {
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-subprocess-recorded', RecordedSubprocess],
    ['@deepseek-ai/dsh-llm-claude-cli', LlmClaudeCli],
  ])
  await Promise.all([...modules.keys()].map(async (packageName) => {
    const packageDir = join(root!, 'node_modules', ...packageName.split('/'))
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({
      name: packageName, version: '0.1.0', type: 'module',
    })}\n`)
  }))
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** Write a default test composition and boot it. */
async function loadComposition(config: readonly string[] = [], apiKey = 'sk-ant-tenant'): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-claude-cli-composition-'))
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv('ANTHROPIC_API_KEY', apiKey)

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    '- id: subprocess',
    "  name: '@deepseek-ai/dsh-subprocess-recorded'",
    '- id: llm-claude-cli',
    "  name: '@deepseek-ai/dsh-llm-claude-cli'",
    '  config:',
    `    cwd: ${JSON.stringify(root)}`,
    `    home: ${JSON.stringify(join(root, 'pool'))}`,
    // text-turn.jsonl was recorded without --bare, so the CLI it captured
    // reports an ambient credential. The default refuses exactly that; the
    // test below asserts the refusal, so the runs that need output opt out.
    '    requireCredentialIsolation: false',
    ...config,
    '',
  ].join('\n'))
  return bootFrom(configPath)
}

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

describe('a booted claude-cli composition', () => {
  it('registers the provider route on the seam', async () => {
    const ctx = await loadComposition()

    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('claude-cli')
  })

  it('answers a request routed to that provider with translated chunks', async () => {
    const ctx = await loadComposition()

    const chunks = await collect(ctx.llm.stream({
      provider: 'claude-cli',
      model: 'claude-opus-5',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'say ok' }], source: { kind: 'user' } })],
    }))

    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('spawns the CLI through the composed subprocess service, under the configured home', async () => {
    const ctx = await loadComposition()

    await collect(ctx.llm.stream({
      provider: 'claude-cli',
      model: 'claude-opus-5',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'say ok' }], source: { kind: 'user' } })],
    }))

    const spec = RecordedSubprocess.spawns[0]
    expect(spec?.argv[0]).toBe('claude')
    expect(spec?.env).toMatchObject({ HOME: join(root!, 'pool'), ANTHROPIC_API_KEY: 'sk-ant-tenant' })
    // The pinned home is only isolation while nothing names a state directory
    // outside it. The seam removes an ambient entry an overlay tombstones.
    expect(spec?.env).toHaveProperty('CLAUDE_CONFIG_DIR', undefined)
    expect(spec?.env).toHaveProperty('XDG_CONFIG_HOME', undefined)
  })

  it('refuses a run the CLI did not authenticate with the injected key, by default', async () => {
    // No requireCredentialIsolation override: the shipped default is fail-closed.
    root = await mkdtemp(join(tmpdir(), 'dsh-claude-cli-composition-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-tenant')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: llm', "  name: '@deepseek-ai/dsh-llm'",
      '- id: subprocess', "  name: '@deepseek-ai/dsh-subprocess-recorded'",
      '- id: llm-claude-cli', "  name: '@deepseek-ai/dsh-llm-claude-cli'",
      '  config:', `    cwd: ${JSON.stringify(root)}`, `    home: ${JSON.stringify(join(root, 'pool'))}`, '',
    ].join('\n'))
    const ctx = await bootFrom(configPath)

    const chunks = await collect(ctx.llm.stream({
      provider: 'claude-cli',
      model: 'claude-opus-5',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'say ok' }], source: { kind: 'user' } })],
    }))

    expect(chunks).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'CREDENTIAL_NOT_ISOLATED',
          message: 'claude CLI authenticated with a credential this runtime did not inject',
        },
      },
    }])
  })

  it('fails the composition when the configured credential variable is unset', async () => {
    // A route with no credential to inject is a composition error, not a run
    // that fails later with a confusing provider message. The Loader wraps the
    // failure and rejects the boot; the rejection carries a Context, so it is
    // inspected rather than pretty-printed by the matcher.
    let message = ''
    try {
      await loadComposition([], '')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toMatch(/ANTHROPIC_API_KEY is not set/)
  })
})
