/**
 * Service Definition for the subprocess capability seam (`ctx.subprocess`): execution-world executable lookup,
 * fully specified managed process trees with raw or
 * collected stdio, and one terminal-process primitive. Command defaulting,
 * shell semantics, deadlines, protocol framing, terminal readiness, and
 * presentation belong to consumers. The local implementation lives in
 * `@deepseek-ai/dsh-subprocess-local`.
 * @module @deepseek-ai/dsh-subprocess
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { DSH_ENV_PREFIX } from './types.ts'
import type { SubprocessHandle, SubprocessSpawnSpec } from './types.ts'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from './types.ts'
import type { SubprocessLaunchKind } from './events.ts'

export { DSH_ENV_PREFIX } from './types.ts'
export type { SubprocessLaunched, SubprocessLaunchKind } from './events.ts'
export type {
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
  SubprocessCollect,
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessStdinMode,
  SubprocessStdio,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from './types.ts'

/**
 * Credential-shaped environment names are NOT forwarded to children (the
 * harness's own `DEEPSEEK_API_KEY`/secrets must not leak into a spawned
 * process implicitly). One heuristic for every in-repo spawner; a
 * deliberately supplied entry survives because explicit env layers merge
 * after the scrub.
 */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * The ambient parent environment minus credential-shaped names and minus all
 * `DSH_*` names — the canonical base every harness child starts from. `PATH`,
 * `HOME`, locale, and proxy variables survive, so child CLIs run normally;
 * harness identity never leaks implicitly (a deliberately forwarded
 * credential or current `DSH_*` fact goes through the spec's explicit `env`,
 * which merges after this scrub). Both scrubs match case-insensitively:
 * Windows environment names are case-insensitive, so a parent `dsh_*` entry
 * would otherwise survive and read back as `$env:DSH_*` in the child;
 * deliberate lowercase `dsh_*` names on POSIX are implausible. Exported as a plain function so spawners
 * that cannot route through the service (node-pty backends, SDK-managed
 * transports) share the one scrub definition.
 * @returns a fresh environment object safe to hand to a child spawn.
 */
export function scrubbedParentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith(DSH_ENV_PREFIX)) env[key] = value
  }
  return env
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subprocess: SubprocessRuntime
  }
}

/**
 * Abstract subprocess service. Subclass, implement {@link spawn}, and load the
 * subclass as a plugin — it registers as `ctx.subprocess` (one implementation
 * per context; loading a second throws, which is cordis' standard
 * duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - Executable paths belong to one execution world shared with the mounted
 *   filesystem provider.
 * - {@link spawn} returns immediately with a live handle; `done` resolves at
 *   process close with exit facts and rejects only for spawn-level failures.
 * - Collect-mode readers are offset-based and non-consuming, so independent
 *   readers never consume one another's output; lossy reads report truncation
 *   and the spill file holding the complete stream when one exists. Piped
 *   streams are handed to the caller raw and never buffered here.
 * - {@link SubprocessHandle.terminate} (and the spec's abort signal) escalates
 *   SIGTERM→grace→SIGKILL — the only termination verb — tree-scoped on every
 *   platform. {@link SubprocessHandle.waitForExit} observes whole-tree
 *   liveness, so a consumer-owned teardown ladder can hold each tier on real
 *   quiescence.
 * - Disposal of the service terminates all still-running managed processes
 *   and awaits their exit.
 * - {@link spawnTerminal} owns terminal allocation, text transport,
 *   foreground groups, signalling, and whole-session quiescence behind one
 *   awaited termination method; readiness and persistent-shell policy stay
 *   in the PTY consumer. Its output stream ends after queued terminal output
 *   when the top-level process exits.
 */
export abstract class SubprocessRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }

  /**
   * Resolve one configured executable in this provider's execution world.
   * Absolute paths are verified; bare names use the provider's scrubbed PATH
   * plus explicit environment overrides. Relative paths containing separators
   * are rejected: the resolution base is undefined, so providers fail loud
   * instead of guessing.
   * @param command - absolute executable path or bare PATH name.
   * @param env - explicit environment entries used for lookup.
   * @param signal - aborts remote or local lookup.
   * @returns a canonical executable path.
   */
  abstract resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>

  /**
   * Start one managed child process from a fully-specified spec; this seam
   * applies no defaults.
   * @param spec - argv, directory, stdio dispositions, grace, cancellation, and environment.
   * @returns the live process handle (streams/readers, signalling, outcome promise).
   */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    // `argv[0]` is the program: the spec's own contract, not a value to default.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the comment above states the invariant
    return this.announce(this.spawnProcess(spec), spec.argv[0]!, spec.cwd, 'process')
  }

  /**
   * Start one managed child process; the implementation's half of
   * {@link spawn}.
   *
   * Implementations override this rather than `spawn`, so a launch record is
   * emitted for every spawner without each one reporting for itself. The
   * contract is `spawn`'s in full: this seam applies no defaults.
   * @param spec - argv, directory, stdio dispositions, grace, cancellation, and environment.
   * @returns the live process handle (streams/readers, signalling, outcome promise).
   */
  protected abstract spawnProcess(spec: SubprocessSpawnSpec): SubprocessHandle

  /**
   * Allocate a real terminal and start one owned process session. This is the
   * only non-pipe process primitive: implementations own terminal byte I/O,
   * foreground groups, signals, and complete session-tree cleanup.
   * @param spec - fully specified argv, cwd, environment, dimensions, grace, and allocation cancellation.
   * @returns the live terminal handle after allocation succeeds.
   */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- `argv[0]` is the program, as in `spawn`
    return this.announce(await this.spawnTerminalSession(spec), spec.argv[0]!, spec.cwd, 'terminal')
  }

  /**
   * Allocate a terminal and start one owned process session; the
   * implementation's half of {@link spawnTerminal}.
   *
   * Implementations override this rather than `spawnTerminal`, for the reason
   * {@link spawnProcess} exists. The contract is `spawnTerminal`'s in full.
   * @param spec - fully specified argv, cwd, environment, dimensions, grace, and allocation cancellation.
   * @returns the live terminal handle after allocation succeeds.
   */
  protected abstract spawnTerminalSession(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>

  /**
   * Announce one started child, and hand its handle back unchanged.
   *
   * The record is emitted here rather than in each implementation so that
   * every spawner in a deployment is covered by the seam they all route
   * through. A listener that throws is contained by cordis' own dispatch;
   * nothing about the launch depends on anyone listening.
   * @param handle - the started child, returned to the caller as it is.
   * @param executable - `argv[0]` as the caller supplied it.
   * @param cwd - the directory the child was started in.
   * @param kind - whether the child owns a terminal or a set of pipes.
   * @returns the handle it was given.
   */
  private announce<T extends { readonly pid: number }>(
    handle: T,
    executable: string,
    cwd: string,
    kind: SubprocessLaunchKind,
  ): T {
    this.ctx.emit('subprocess/launched', { executable, cwd, pid: handle.pid, kind })
    return handle
  }
}

export default SubprocessRuntime
