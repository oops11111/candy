/**
 * The `dsh-llm` adapter that runs the Claude CLI as a model endpoint.
 *
 * One `stream()` call is one CLI process. The adapter owns that process's
 * lifetime and nothing about the protocol: `dsh-claude-cli-protocol` decides
 * what the invocation says and what its output means, so what remains here is
 * spawning, reading stdout, classifying an exit, and guaranteeing exactly one
 * terminal chunk however the process ends.
 *
 * @module dsh-llm-claude-cli/adapter
 */

import {
  ClaudeCliFrameTranslator,
  ClaudeCliLineDecoder,
  claudeCliArguments,
  claudeCliEnvironment,
  isCredentialIsolated,
  type ClaudeCliIsolation,
  type WireFrame,
} from '@deepseek-ai/dsh-claude-cli-protocol'
import {
  LlmAdapter,
  LlmError,
  type FinishReason,
  type GenerateOptions,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ReasoningEffortId,
  redactChunkApiKey,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { projectRequest } from './request.ts'

/** Machine code for a CLI process that ended without completing its run. */
export const CLI_EXIT_CODE = 'CLI_EXIT'
/** Machine code for a run the CLI authenticated with something other than the injected key. */
export const CREDENTIAL_LEAK_CODE = 'CREDENTIAL_NOT_ISOLATED'

/** How one adapter instance runs the CLI. */
export interface ClaudeCliAdapterOptions {
  /** Absolute path to the `claude` executable. */
  readonly executable: string
  /** Working directory for the child; the CLI reads nothing from it under `--bare`. */
  readonly cwd: string
  /** The home directory and API key every run of this instance uses. */
  readonly isolation: ClaudeCliIsolation
  /** Process-tree termination grace in milliseconds. */
  readonly graceMs: number
  /**
   * Start one process. A closure rather than the `Context`, so the adapter
   * depends on the one subprocess capability it uses and stays testable
   * without booting a service.
   */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Per-invocation spend ceiling in US dollars, when the deployment sets one. */
  readonly maxBudgetUsd?: number | undefined
  /**
   * Most stdout bytes one run may write before it is failed and its process
   * terminated.
   *
   * The seam hands this route the raw stream — `stdout: 'pipe'` is documented
   * as the caller's to decode and therefore the caller's to bound — and every
   * byte read is accumulated, into a partial line while one is open and into a
   * content block once its frames parse. Without a ceiling one run's output
   * exhausts a runtime that other tenants share, and this route has no other
   * bound on response length: the CLI has no output-token flag, so
   * {@link projectRequest} refuses `maxTokens` rather than passing it on.
   *
   * Exceeding it fails the run instead of truncating. Truncation is right for
   * a tool result a model reads and wrong for a protocol stream: a half-written
   * frame does not parse, and a response cut short would otherwise be delivered
   * as though it were complete.
   */
  readonly maxOutputBytes: number
  /**
   * Most stderr bytes to retain from one run, as the tail of that stream.
   *
   * The CLI writes its diagnostics here — an unusable executable, a rejected
   * flag, an unhandled failure — and they are the only account of a run that
   * ends without a terminal frame. The stream is collected rather than
   * inherited so this adapter can hand that account back with the credential
   * redacted, which makes the ceiling the amount of one tenant's stderr a
   * runtime holds while its run is alive.
   *
   * Overflow keeps the tail and discards the head, which is the opposite of
   * the stdout ceiling and right for the same reason: a diagnostic ends with
   * what failed, while a protocol stream cannot survive a gap at all.
   */
  readonly maxStderrBytes: number
  /**
   * Fail a run whose CLI reports authenticating with anything but the injected
   * key. A multi-tenant deployment sets this: a run that reached another
   * credential is spending someone other than the tenant, and finishing it
   * normally would bill them for it.
   */
  readonly requireCredentialIsolation: boolean
}

/** Efforts this adapter exposes, mirroring the levels the CLI accepts. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** Classify a process that ended without its terminal frame. */
/**
 * The diagnostic tail one CLI process wrote, bounded by the collect ceiling.
 *
 * The text goes into a failure the caller reads, and every chunk leaving this
 * adapter passes the credential redaction in `runProcess`, so the tail is
 * covered there rather than rewritten twice here.
 *
 * @param child - the process, whose stderr this adapter spawned in collect mode.
 * @returns the retained tail with surrounding whitespace removed, or an empty
 *   string when the process wrote nothing or the implementation collected none.
 */
function stderrTail(child: SubprocessHandle): string {
  const collected = child.collected.stderr
  return collected === undefined ? '' : collected.readFrom(0).text.trim()
}

function exitFailure(
  outcome: { exitCode: number | null; signal: NodeJS.Signals | null },
  diagnostics: string,
): FinishReason {
  const cause = outcome.signal === null ? `exit code ${String(outcome.exitCode)}` : `signal ${outcome.signal}`
  const said = diagnostics.length === 0 ? '' : `: ${diagnostics}`
  return {
    kind: 'error',
    failure: {
      message: `claude CLI ended without finishing its run (${cause})${said}`,
      code: CLI_EXIT_CODE,
    },
  }
}

/**
 * Runs the Claude CLI for one registered provider route.
 *
 * The instance carries one tenant's isolation, so a multi-tenant runtime
 * constructs one adapter per runtime pool rather than passing identity through
 * a request; there is no parameter on `stream()` through which a caller could
 * pair its request with another tenant's credential.
 */
export class ClaudeCliAdapter extends LlmAdapter {
  /** @param options - the executable, isolation, and process capability this instance uses. */
  constructor(private readonly options: ClaudeCliAdapterOptions) {
    super()
  }

  /**
   * Describe the route this adapter serves.
   * @param provider - a route registered for this instance.
   * @returns display metadata whose id is the route.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Claude CLI' }
  }

  /**
   * Resolve one model's metadata.
   *
   * The CLI accepts model aliases and exact ids and publishes no catalogue, so
   * this reports the route's efforts and leaves the id to the caller: an
   * unlisted model is the CLI's to accept or reject, not this adapter's.
   * @param provider - a route registered for this instance.
   * @param model - the exact model id or alias the request names.
   * @returns route identity plus the effort levels the CLI accepts.
   */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: EFFORTS.map(effort => ({ id: brandString<ReasoningEffortId>(effort), name: effort })),
      },
    })
  }

  /**
   * Run one model call as one CLI process.
   * @param options - the fully-assembled request; `options.signal` terminates the process tree.
   * @returns the chunk stream, with exactly one terminal finish however the process ends.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Projection happens before the generator body so an unsupported request
    // throws at the call, not on first iteration.
    const run = projectRequest(options, this.options.maxBudgetUsd)
    return this.runProcess(run, options.signal)
  }

  /** Drive one process from spawn to terminal chunk. */
  private async * runProcess(
    run: ReturnType<typeof projectRequest>,
    signal: AbortSignal | undefined,
  ): AsyncIterable<StreamChunk> {
    const child = this.options.spawn({
      argv: [this.options.executable, ...claudeCliArguments(run)],
      cwd: this.options.cwd,
      // The prompt is a command-line argument, so the child needs no input; an
      // open stdin makes the CLI wait several seconds for one that never comes.
      // Collected rather than inherited, and never spilled. The CLI quotes the
      // request it failed on, and that request carried the tenant's key, so an
      // inherited stderr writes the credential straight to the host's own
      // stream where this adapter — the one place that still knows which
      // secret to look for — cannot redact it. Collecting keeps the tail this
      // adapter can hand back through `exitFailure`, which the redaction in
      // `runProcess` then covers.
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: this.options.maxStderrBytes } },
      graceMs: this.options.graceMs,
      signal,
      env: claudeCliEnvironment(this.options.isolation),
    })

    // Set before every return, and read by the finally below: a consumer that
    // stops iterating closes this generator part-way through, and the CLI it
    // abandons is still running with nothing else to reap it.
    let completed = false
    try {
      const stdout = child.stdout
      if (stdout === undefined) throw new LlmError('claude CLI stdout was not piped', CLI_EXIT_CODE)
      for await (const chunk of this.readRun(child, stdout, signal)) yield redactChunkApiKey(chunk, this.options.isolation.apiKey)
      completed = true
    } finally {
      if (!completed) child.terminate()
    }
  }

  /** Read one running process to its terminal chunk. */
  private async * readRun(
    child: SubprocessHandle,
    stdout: NonNullable<SubprocessHandle['stdout']>,
    signal: AbortSignal | undefined,
  ): AsyncIterable<StreamChunk> {
    const decoder = new ClaudeCliLineDecoder()
    const translator = new ClaudeCliFrameTranslator()
    /** Admit and translate one batch of frames, reporting whether the run finished. */
    const consume = (frames: readonly WireFrame[]): { chunks: StreamChunk[]; finished: boolean } => {
      const chunks: StreamChunk[] = []
      let finished = false
      for (const frame of frames) {
        this.admitFrame(frame)
        for (const translated of translator.translate(frame)) {
          finished ||= translated.type === 'finish'
          chunks.push(translated)
        }
      }
      return { chunks, finished }
    }

    let finished = false
    let bytes = 0
    stdout.setEncoding('utf8')
    for await (const chunk of stdout) {
      const text = chunk as string
      // Bytes, not code units: the ceiling bounds what the runtime holds.
      bytes += Buffer.byteLength(text, 'utf8')
      if (bytes > this.options.maxOutputBytes) {
        // Nothing else reaps the child here: this generator returns normally,
        // so `runProcess` treats the run as completed and leaves it alone.
        child.terminate()
        yield* translator.end({
          kind: 'error',
          failure: {
            message: `claude CLI wrote more than ${String(this.options.maxOutputBytes)} bytes of stdout`,
            code: 'OUTPUT_LIMIT',
          },
        })
        return
      }
      const batch = consume(decoder.push(text))
      finished = finished || batch.finished
      yield* batch.chunks
    }
    // The trailing frame reaches the same admission and translation as any
    // other: a run whose last line lacked its newline is not less checked.
    const tail = consume(decoder.flush())
    yield* tail.chunks
    if (finished || tail.finished) return

    // stdout closed without a terminal frame. Cancellation is settled from the
    // signal alone and never from the process: the seam has only *started* the
    // termination ladder, so a child that ignores SIGTERM would hold this run
    // open for the whole grace period after the caller already gave up.
    if (signal?.aborted === true) {
      yield* translator.end({
        kind: 'aborted',
        failure: { message: 'claude CLI run was cancelled', code: 'ABORTED' },
      })
      return
    }
    // Otherwise the process died on its own, and its exit facts say how.
    yield* translator.end(exitFailure(await child.done, stderrTail(child)))
  }

  /**
   * Fail the run when the CLI reports a credential this adapter did not inject.
   * @param frame - one decoded stdout frame.
   * @throws LlmError with code `CREDENTIAL_NOT_ISOLATED` when isolation is
   * required and the CLI's init frame names another credential source.
   */
  private admitFrame(frame: WireFrame): void {
    if (!this.options.requireCredentialIsolation) return
    if (isCredentialIsolated(frame) === false) {
      throw new LlmError(
        'claude CLI authenticated with a credential this runtime did not inject',
        CREDENTIAL_LEAK_CODE,
      )
    }
  }
}
