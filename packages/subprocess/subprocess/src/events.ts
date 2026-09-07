/**
 * Launch-record vocabulary of the subprocess seam. Every managed child this
 * seam starts announces itself once, so a deployment can answer what it ran
 * without each spawner reporting for itself.
 *
 * The record carries what the seam knows and nothing it holds in trust. The
 * executable is named; the arguments are not, because a spawner's argv carries
 * whatever the caller put there — a model prompt, a credential passed as a
 * flag — and the environment is not, because that is where credentials live.
 * A consumer that needs more knows more than this seam does.
 * @module @deepseek-ai/dsh-subprocess/src/events
 */

/** How one managed child was started. */
export type SubprocessLaunchKind = 'process' | 'terminal'

/** One managed child, as the seam that started it can describe it. */
export interface SubprocessLaunched {
  /** Canonical executable path; `argv[0]` as the caller supplied it. */
  readonly executable: string
  /** Working directory the child was started in. */
  readonly cwd: string
  /**
   * Process id of the tree root, or `-1` when the spawn itself failed.
   *
   * A handle is returned either way, so `-1` is the seam reporting a launch
   * that did not happen rather than the absence of a record.
   */
  readonly pid: number
  /** Whether the child owns a terminal or a set of pipes. */
  readonly kind: SubprocessLaunchKind
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One managed child process was started, emitted once per launch by the
     * seam every spawner routes through, after the handle exists and its pid
     * is known.
     *
     * The payload names the executable and where it ran, never the arguments
     * or the environment. Attribution — which tenant, which run — belongs to a
     * consumer that has it; this seam has no notion of either.
     * @param launch - executable, working directory, pid (`-1` when the spawn
     * failed), and whether the child owns a terminal.
     * @mode emit
     */
    'subprocess/launched'(launch: SubprocessLaunched): void
  }
}
