import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, LlmError, type GenerateOptions, type ReasoningEffortId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import { ClaudeCliAdapter, type ClaudeCliAdapterOptions } from '../src/index.ts'

const ISOLATION = { home: '/srv/candy/pools/abc', apiKey: 'sk-ant-tenant' }

/** The recorded CLI runs the protocol package pins, replayed through the adapter. */
function recorded(name: string): string {
  return readFileSync(fileURLToPath(
    new URL(`../../claude-cli-protocol/tests/fixtures/${name}`, import.meta.url),
  ), 'utf8')
}

/** One fake process: the stdout it writes, and how it ends. */
interface FakeProcess {
  readonly stdout?: string | Readable
  readonly outcome?: SubprocessOutcome
  /** Never resolve `done`, standing in for a process still running. */
  readonly hang?: boolean
}

/** A spawn capability that records its spec and replays a scripted process. */
function fakeSpawn(script: FakeProcess = {}) {
  const specs: SubprocessSpawnSpec[] = []
  const spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    specs.push(spec)
    const stdout = typeof script.stdout === 'string' || script.stdout === undefined
      ? Readable.from([script.stdout ?? ''])
      : script.stdout
    return {
      pid: 4242,
      stdin: undefined,
      stdout,
      stderr: undefined,
      collected: {},
      done: script.hang === true
        ? new Promise<SubprocessOutcome>(() => {})
        : Promise.resolve(script.outcome ?? { exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }
  return { spawn, specs }
}

function adapter(script?: FakeProcess, overrides: Partial<ClaudeCliAdapterOptions> = {}) {
  const { spawn, specs } = fakeSpawn(script)
  return {
    specs,
    instance: new ClaudeCliAdapter({
      executable: '/usr/bin/claude',
      cwd: '/workspace',
      isolation: ISOLATION,
      graceMs: 5_000,
      maxOutputBytes: 1_000_000,
      spawn,
      requireCredentialIsolation: false,
      ...overrides,
    }),
  }
}

/** One ordinary single-turn request. */
function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'claude-cli',
    model: 'claude-opus-5',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'say ok' }], source: { kind: 'user' } })],
    ...overrides,
  }
}

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

describe('ClaudeCliAdapter.stream', () => {
  it('runs one process per call and streams its translated output', async () => {
    const { instance, specs } = adapter({ stdout: recorded('text-turn.jsonl') })

    const chunks = await collect(instance.stream(request()))

    expect(specs).toHaveLength(1)
    expect(chunks.at(0)).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('spawns the configured executable with the request on its command line', async () => {
    const { instance, specs } = adapter({ stdout: recorded('text-turn.jsonl') })

    await collect(instance.stream(request({ system: 'be terse' })))

    const spec = specs[0]
    expect(spec?.argv[0]).toBe('/usr/bin/claude')
    expect(spec?.argv.at(-1)).toBe('say ok')
    expect(spec?.argv).toContain('--bare')
    expect(spec?.argv[spec.argv.indexOf('--system-prompt') + 1]).toBe('be terse')
    expect(spec?.argv[spec.argv.indexOf('--model') + 1]).toBe('claude-opus-5')
  })

  it('gives the child the tenant home and key, and no input to wait for', async () => {
    const { instance, specs } = adapter({ stdout: recorded('text-turn.jsonl') })

    await collect(instance.stream(request()))

    expect(specs[0]?.env).toMatchObject({ HOME: ISOLATION.home, ANTHROPIC_API_KEY: ISOLATION.apiKey })
    // An open stdin makes the CLI wait seconds for input the prompt already carried.
    expect(specs[0]?.stdio.stdin).toBe('ignore')
  })

  it('hands the caller signal to the process seam, which owns the termination ladder', async () => {
    const controller = new AbortController()
    const { instance, specs } = adapter({ stdout: recorded('text-turn.jsonl') })

    await collect(instance.stream(request({ signal: controller.signal })))

    expect(specs[0]?.signal).toBe(controller.signal)
    expect(specs[0]?.graceMs).toBe(5_000)
  })

  it('carries a configured spend ceiling into every run', async () => {
    const { instance, specs } = adapter({ stdout: recorded('text-turn.jsonl') }, { maxBudgetUsd: 0.25 })

    await collect(instance.stream(request()))

    expect(specs[0]?.argv[specs[0].argv.indexOf('--max-budget-usd') + 1]).toBe('0.25')
  })

  it('reads a run split across stdout reads', async () => {
    const text = recorded('text-turn.jsonl')
    const half = Math.floor(text.length / 2)
    const { instance } = adapter({ stdout: Readable.from([text.slice(0, half), text.slice(half)]) })

    const chunks = await collect(instance.stream(request()))

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.filter(chunk => chunk.type === 'finish')).toHaveLength(1)
  })

  it('reports a failed run as one error finish', async () => {
    const { instance } = adapter({ stdout: recorded('auth-failure.jsonl'), outcome: { exitCode: 1, signal: null } })

    const chunks = await collect(instance.stream(request()))

    // The failed run's terminal frame still carries counts, all zero.
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } })
    expect(chunks[1]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { status: 401 } } })
  })
})

describe('a process that ends without finishing its run', () => {
  it('finishes as an error naming the exit code', async () => {
    const { instance } = adapter({ stdout: '', outcome: { exitCode: 2, signal: null } })

    const chunks = await collect(instance.stream(request()))

    expect(chunks).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'claude CLI ended without finishing its run (exit code 2)', code: 'CLI_EXIT' },
      },
    }])
  })

  it('finishes as an error naming the signal that killed it', async () => {
    const { instance } = adapter({ stdout: '', outcome: { exitCode: null, signal: 'SIGKILL' } })

    const chunks = await collect(instance.stream(request()))

    expect(chunks).toMatchObject([{
      reason: { failure: { message: 'claude CLI ended without finishing its run (signal SIGKILL)' } },
    }])
  })

  it('reports the counts a truncated run did send before dying', async () => {
    const partial = recorded('text-turn.jsonl').split('\n').slice(0, 12).join('\n') + '\n'
    const { instance } = adapter({ stdout: partial, outcome: { exitCode: 1, signal: null } })

    const chunks = await collect(instance.stream(request()))

    // message_delta arrived, so its counts stand in for the result frame that never came.
    expect(chunks.at(-2)).toMatchObject({ type: 'usage', usage: { inputTokens: 2, outputTokens: 4 } })
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'CLI_EXIT' } } })
  })

  it('finishes as aborted when the caller cancelled, without waiting on the process', async () => {
    const controller = new AbortController()
    controller.abort()
    // `done` never settles: a cancelled run must not block on the tree's exit.
    const { instance } = adapter({ stdout: '', hang: true })

    const chunks = await collect(instance.stream(request({ signal: controller.signal })))

    expect(chunks).toEqual([{
      type: 'finish',
      reason: { kind: 'aborted', failure: { message: 'claude CLI run was cancelled', code: 'ABORTED' } },
    }])
  })
})

describe('a run whose stdout ends without a trailing newline', () => {
  it('still delivers the final frame', async () => {
    const { instance } = adapter({ stdout: recorded('text-turn.jsonl').trimEnd() })

    const chunks = await collect(instance.stream(request()))

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})

describe('credential isolation', () => {
  it('takes the injected key back out of a failure that quotes it', async () => {
    // A `result` frame's text becomes the failure message verbatim, so a CLI
    // that echoes its credential would put it in the session log.
    const frames = [
      JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' }),
      JSON.stringify({
        type: 'result',
        is_error: true,
        result: `authentication failed for ${ISOLATION.apiKey}`,
        terminal_reason: 'auth',
      }),
    ].join('\n')
    const { instance } = adapter({ stdout: frames, outcome: { exitCode: 1, signal: null } })

    const chunks = await collect(instance.stream(request()))

    expect(JSON.stringify(chunks).includes(ISOLATION.apiKey)).toBe(false)
    expect(chunks.at(-1)).toMatchObject({
      reason: { failure: { message: 'authentication failed for [redacted]' } },
    })
  })

  it('leaves model output alone', async () => {
    // The tenant's own content, which a silent rewrite would corrupt.
    const { instance } = adapter({ stdout: recorded('text-turn.jsonl') })

    const chunks = await collect(instance.stream(request()))

    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
  })

  it('fails a run that writes past its stdout ceiling, and reaps it', async () => {
    // The seam hands this route the raw stream, so nothing but the adapter
    // bounds what one tenant's process makes the runtime hold.
    let terminated = false
    const flood = Readable.from(['x'.repeat(64), 'y'.repeat(64)])
    const { spawn } = fakeSpawn({ stdout: flood, hang: true })
    const instance = new ClaudeCliAdapter({
      executable: '/usr/bin/claude',
      cwd: '/workspace',
      isolation: ISOLATION,
      graceMs: 5_000,
      maxOutputBytes: 100,
      spawn: spec => ({ ...spawn(spec), terminate: () => { terminated = true } }),
      requireCredentialIsolation: false,
    })

    const chunks = await collect(instance.stream(request()))

    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: expect.stringContaining('more than 100 bytes') as string, code: 'OUTPUT_LIMIT' } },
    })
    expect(terminated).toBe(true)
  })

  it('counts the ceiling in bytes, not code units', async () => {
    // Four code units of astral text are sixteen bytes; a ceiling read in
    // code units would admit four times what it promised to hold.
    const { spawn } = fakeSpawn({ stdout: Readable.from(['\u{1f600}'.repeat(4)]), hang: true })
    const instance = new ClaudeCliAdapter({
      executable: '/usr/bin/claude',
      cwd: '/workspace',
      isolation: ISOLATION,
      graceMs: 5_000,
      maxOutputBytes: 12,
      spawn,
      requireCredentialIsolation: false,
    })

    const chunks = await collect(instance.stream(request()))

    expect(chunks.at(-1)).toMatchObject({ reason: { failure: { code: 'OUTPUT_LIMIT' } } })
  })

  it('admits a run that stays inside its ceiling', async () => {
    const turn = recorded('text-turn.jsonl')
    const { instance } = adapter({ stdout: turn, outcome: { exitCode: 0, signal: null } }, {
      maxOutputBytes: Buffer.byteLength(turn, 'utf8'),
    })

    const chunks = await collect(instance.stream(request()))

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('checks a run whose init frame arrived in an unterminated final line', async () => {
    const init = recorded('text-turn.jsonl').split('\n')
      .find(line => line.includes('"subtype":"init"')) ?? ''
    const { instance } = adapter({ stdout: init }, { requireCredentialIsolation: true })

    await expect(collect(instance.stream(request()))).rejects.toThrow(/did not inject/)
  })

  it('fails a run the CLI authenticated with an ambient login', async () => {
    // text-turn.jsonl was recorded without --bare: apiKeySource is "none".
    const { instance } = adapter(
      { stdout: recorded('text-turn.jsonl') }, { requireCredentialIsolation: true },
    )

    await expect(collect(instance.stream(request()))).rejects.toThrow(/did not inject/)
  })

  it('admits a run the CLI authenticated with the injected key', async () => {
    const { instance } = adapter(
      { stdout: recorded('auth-failure.jsonl') }, { requireCredentialIsolation: true },
    )

    const chunks = await collect(instance.stream(request()))

    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
  })

  it('does not check when the deployment did not ask for it', async () => {
    const { instance } = adapter({ stdout: recorded('text-turn.jsonl') })

    await expect(collect(instance.stream(request()))).resolves.toBeDefined()
  })
})

describe('a process the seam gave no stdout pipe', () => {
  it('fails the run rather than reading nothing', async () => {
    const { spawn } = fakeSpawn()
    let terminated = false
    const instance = new ClaudeCliAdapter({
      executable: '/usr/bin/claude',
      cwd: '/workspace',
      isolation: ISOLATION,
      graceMs: 5_000,
      maxOutputBytes: 1_000_000,
      spawn: spec => ({ ...spawn(spec), stdout: undefined, terminate: () => { terminated = true } }),
      requireCredentialIsolation: false,
    })

    await expect(collect(instance.stream(request()))).rejects.toThrow(/stdout was not piped/)
    expect(terminated).toBe(true)
  })
})

describe('ClaudeCliAdapter metadata', () => {
  it('names the route it serves', () => {
    expect(adapter().instance.providerInfo('claude-cli')).toEqual({ id: 'claude-cli', name: 'Claude CLI' })
  })

  it('reports the effort levels the CLI accepts and leaves the model id to the caller', async () => {
    const model = await adapter().instance.resolveModel('claude-cli', 'some-future-model')

    expect(model).toMatchObject({ provider: 'claude-cli', id: 'some-future-model' })
    expect(model.reasoning?.efforts.map(effort => effort.id))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('a request the CLI cannot express', () => {
  it('throws at the call rather than on first iteration', () => {
    const { instance } = adapter()

    expect(() => instance.stream(request({ maxTokens: 100 }))).toThrow(LlmError)
  })

  it('spawns nothing when it refuses', () => {
    const { instance, specs } = adapter()

    expect(() => instance.stream(request({ temperature: 0.5 }))).toThrow()
    expect(specs).toEqual([])
  })

  it('carries the effort the caller chose', async () => {
    const { instance, specs } = adapter({ stdout: recorded('text-turn.jsonl') })

    await collect(instance.stream(request({ reasoningEffort: brandString<ReasoningEffortId>('xhigh') })))

    expect(specs[0]?.argv[specs[0].argv.indexOf('--effort') + 1]).toBe('xhigh')
  })
})
