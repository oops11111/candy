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
function exitFailure(outcome: { exitCode: number | null; signal: NodeJS.Signals | null }): FinishReason {
  const cause = outcome.signal === null ? `exit code ${String(outcome.exitCode)}` : `signal ${outcome.signal}`
  return {
    kind: 'error',
    failure: {
      message: `claude CLI ended without finishing its run (${cause})`,
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
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
      graceMs: this.options.graceMs,
      signal,
      env: claudeCliEnvironment(this.options.isolation),
    })
    const stdout = child.stdout
    if (stdout === undefined) throw new LlmError('claude CLI stdout was not piped', CLI_EXIT_CODE)

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
    stdout.setEncoding('utf8')
    for await (const chunk of stdout) {
      const batch = consume(decoder.push(chunk as string))
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
    yield* translator.end(exitFailure(await child.done))
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
