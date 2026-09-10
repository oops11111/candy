/**
 * What `codex` 0.149.1's app-server actually emits, captured from the real
 * binary rather than read off a frame name.
 *
 * An LLM adapter over this CLI has to parse streaming text, token usage,
 * failure and cancellation, and none of those is where a reader would guess:
 * usage arrives as its own `thread/tokenUsage/updated` notification rather
 * than on `turn/completed`, and a cancelled turn is reported by a `status` on
 * that same frame rather than by an error. These cases drive the real
 * app-server against the package's own Responses fixture and assert the frame
 * vocabulary verbatim, so the future adapter reads recordings and a protocol
 * change in a later CLI fails here first.
 *
 * What this cannot record is what only a real account produces: the
 * `account/rateLimits/updated` payload comes back all-null without one, and
 * no frame carries a cost figure at all.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { startResponsesFixture, type ResponsesBehavior, type ResponsesFixture } from './responses-fixture.ts'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const codexBinDir = join(packageRoot, 'node_modules', '.bin')
const codexPackageJson = createRequire(import.meta.url).resolve('@openai/codex/package.json')
const codexPackage = JSON.parse(readFileSync(codexPackageJson, 'utf8')) as {
  version: string
  bin: { codex: string }
}
const codexEntry = resolve(dirname(codexPackageJson), codexPackage.bin.codex)

const roots: string[] = []
const fixtures: ResponsesFixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** One captured run: every JSON-RPC line the app-server wrote, in order. */
interface Capture {
  readonly lines: readonly string[]
  /** Every notification method, in arrival order. */
  readonly methods: readonly string[]
  /** The params of the first notification with this method. */
  params(method: string): Record<string, unknown>
}

/** Whether the app-server is expected to be interrupted mid-turn. */
type Ending = 'complete' | 'interrupt'

/**
 * Drive one real app-server turn and capture its output.
 *
 * The launch mirrors the package's own: the fixed package-local wrapper, the
 * package `.bin` ahead of `PATH`, and every proxy variable cleared, because a
 * Codex that resolves an ambient proxy reaches for `chatgpt.com` instead of
 * the loopback fixture.
 */
async function capture(script: readonly ResponsesBehavior[], prompt: string, ending: Ending = 'complete'): Promise<Capture> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-codex-record-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const codexHome = join(root, 'codex-home')
  mkdirSync(workspace)
  mkdirSync(codexHome)
  const fixture = await startResponsesFixture(script)
  fixtures.push(fixture)
  writeFileSync(join(codexHome, 'config.toml'), [
    'model = "fixture-model"',
    'model_provider = "fixture"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'disable_response_storage = true',
    'check_for_update_on_startup = false',
    '',
    '[model_providers.fixture]',
    'name = "Fixture Responses"',
    `base_url = "${fixture.baseUrl}"`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
  ].join('\n'))

  const child = spawn(process.execPath, [codexEntry, 'app-server', '--stdio'], {
    cwd: workspace,
    env: {
      ...process.env,
      OPENAI_API_KEY: 'dsh-fake-openai-key',
      CODEX_HOME: codexHome,
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'xdg'),
      PATH: `${codexBinDir}${delimiter}${process.env.PATH ?? ''}`,
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: '127.0.0.1,localhost',
      RUST_LOG: 'error',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines: string[] = []
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline < 0) break
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (line.trim() !== '') lines.push(line)
    }
  })
  child.stderr.resume()

  const send = (message: Record<string, unknown>): void => { child.stdin.write(`${JSON.stringify(message)}\n`) }
  /** Wait until a predicate holds over the captured lines, or time out. */
  const until = async (holds: () => boolean, label: string): Promise<void> => {
    for (let waited = 0; waited < 30_000; waited += 50) {
      if (holds()) return
      await new Promise(resolve_ => setTimeout(resolve_, 50))
    }
    throw new Error(`codex app-server never ${label}; captured:\n${lines.join('\n')}`)
  }
  const reply = (id: number): Record<string, unknown> | undefined => lines
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .find(message => message.id === id && message.result !== undefined)

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'dsh-record', title: 'dsh-record', version: '0' } } })
    await until(() => reply(1) !== undefined, 'answered initialize')
    send({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access' } })
    await until(() => reply(2) !== undefined, 'started a thread')
    const thread = (reply(2)?.result as { thread: { id: string } }).thread
    send({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: { threadId: thread.id, input: [{ type: 'text', text: prompt }] } })
    await until(() => reply(3) !== undefined, 'started a turn')
    if (ending === 'interrupt') {
      const turn = (reply(3)?.result as { turn: { id: string } }).turn
      send({ jsonrpc: '2.0', id: 4, method: 'turn/interrupt', params: { threadId: thread.id, turnId: turn.id } })
    }
    await until(() => lines.some(line => line.includes('"turn/completed"')), 'completed a turn')
  } finally {
    child.kill('SIGKILL')
  }

  const notifications = lines
    .map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    .filter((message): message is { method: string; params: Record<string, unknown> } => message.method !== undefined)
  return {
    lines,
    methods: notifications.map(message => message.method),
    params: (method) => {
      const found = notifications.find(message => message.method === method)
      if (found === undefined) throw new Error(`no ${method} frame was recorded in:\n${lines.join('\n')}`)
      return found.params
    },
  }
}

describe(`a recorded codex ${codexPackage.version} turn`, () => {
  it('streams its answer through item/agentMessage/delta', async () => {
    const recorded = await capture([{ kind: 'complete', text: 'recorded ok' }], 'say ok')

    // The delta frame is what an adapter emits text from; `item/completed`
    // carries the whole answer again and arrives after it.
    expect(recorded.methods).toContain('item/agentMessage/delta')
    expect(recorded.params('item/agentMessage/delta')).toMatchObject({ delta: 'recorded ok' })
    expect(recorded.methods.indexOf('item/agentMessage/delta'))
      .toBeLessThan(recorded.methods.lastIndexOf('item/completed'))
    expect(recorded.params('turn/completed')).toMatchObject({ turn: { status: 'completed' } })
  }, 60_000)

  it('reports token usage on its own notification, not on the completed turn', async () => {
    const recorded = await capture([{ kind: 'complete', text: 'recorded ok' }], 'say ok')

    const usage = recorded.params('thread/tokenUsage/updated').tokenUsage as {
      last: Record<string, unknown>
      total: Record<string, unknown>
      modelContextWindow: unknown
    }
    // The field names are the recorded ones. `cacheWriteInputTokens` and the
    // total/last split are not guessable from the harness vocabulary, and a
    // reader looking on `turn/completed` finds nothing.
    expect(Object.keys(usage.last).sort()).toEqual([
      'cacheWriteInputTokens',
      'cachedInputTokens',
      'inputTokens',
      'outputTokens',
      'reasoningOutputTokens',
      'totalTokens',
    ])
    expect(Object.keys(usage.total).sort()).toEqual(Object.keys(usage.last).sort())
    for (const value of [...Object.values(usage.last), usage.modelContextWindow]) {
      expect(typeof value).toBe('number')
    }
    expect(JSON.stringify(recorded.params('turn/completed'))).not.toContain('Tokens')
    // No frame carries a cost. An adapter that reports one computes it.
    expect(recorded.lines.join('\n')).not.toMatch(/cost|usd/iu)
  }, 60_000)

  it('fails a turn with an error notification and the same error on the turn', async () => {
    const recorded = await capture(
      [{ kind: 'error', status: 429, message: 'rate limit reached' }],
      'say ok',
    )

    // Reported twice: once as it happens, once on the turn that failed.
    expect(recorded.params('error')).toMatchObject({
      willRetry: false,
      error: { codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } },
    })
    expect(recorded.params('turn/completed')).toMatchObject({
      turn: { status: 'failed', error: { codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } } },
    })
  }, 60_000)

  it('ends an interrupted turn with a status rather than an error', async () => {
    const recorded = await capture([{ kind: 'hold' }], 'wait', 'interrupt')

    // `turn/interrupt` needs the turn id as well as the thread's, and what it
    // produces is a completed frame whose status says why.
    expect(recorded.params('turn/completed')).toMatchObject({ turn: { status: 'interrupted', error: null } })
  }, 60_000)
})
