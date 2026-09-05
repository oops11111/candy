/**
 * Compose one isolated Claude CLI invocation: the argument vector that makes
 * the CLI a plain streaming model endpoint, and the environment that pins it
 * to exactly one tenant's credential.
 *
 * Every flag and variable name here was verified against `claude` 2.1.259
 * rather than inferred. Two of them are load-bearing and not obvious:
 * `--verbose` is mandatory (the CLI refuses `--print` with
 * `--output-format=stream-json` without it), and `--bare` is what confines
 * authentication to `ANTHROPIC_API_KEY`. Without `--bare` the CLI falls back
 * to whatever ambient login the host has — an observed run on this machine
 * authenticated through the host's OAuth session and reported
 * `apiKeySource: "none"`, which in a multi-tenant runtime is one tenant's run
 * billed to the host.
 *
 * @module dsh-claude-cli-protocol/launch
 */

/** The credential and filesystem identity one run may use. */
export interface ClaudeCliIsolation {
  /**
   * `HOME` for the child. The CLI derives its per-user state directory from
   * this, so it is what separates one tenant's runtime pool from another's.
   */
  readonly home: string
  /** The tenant's Anthropic API key, already opened from its sealed envelope. */
  readonly apiKey: string
}

/**
 * Effort levels the CLI accepts for `--effort`, in increasing order.
 *
 * A closed set because the CLI validates the value and rejects anything else;
 * it is not a harness-owned vocabulary this package may extend.
 */
export const CLAUDE_CLI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** One effort level the CLI accepts. */
export type ClaudeCliEffort = typeof CLAUDE_CLI_EFFORTS[number]

/** What one invocation asks the model for. */
export interface ClaudeCliRun {
  /** The user turn, passed as the CLI's positional prompt. */
  readonly prompt: string
  /** Replaces the CLI's built-in agent prompt; omitted leaves that prompt in force. */
  readonly systemPrompt?: string | undefined
  /** Exact model id or alias; omitted takes the CLI's configured default. */
  readonly model?: string | undefined
  /** Hard spend ceiling for this invocation, in US dollars. */
  readonly maxBudgetUsd?: number | undefined
  /** Reasoning effort; omitted leaves the CLI's configured level. */
  readonly effort?: ClaudeCliEffort | undefined
}

/**
 * Provider-routing and authentication variables that must not reach the child.
 *
 * `--bare` already confines Anthropic auth to `ANTHROPIC_API_KEY`, but it does
 * not govern which provider the CLI talks to: an ambient `CLAUDE_CODE_USE_*`
 * toggle redirects the run to a cloud provider that authenticates with the
 * host's own credentials, ignoring the tenant key entirely. Tombstoning them
 * is what makes the injected key the only credential the run can use.
 */
export const SCRUBBED_ROUTING_VARIABLES: readonly string[] = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_AWS_AUTH',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_VERTEX_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
]

/**
 * Variables naming a state directory the child would use instead of one under
 * its home.
 *
 * {@link claudeCliEnvironment} isolates a tenant by pinning `HOME` to that
 * tenant's pool root, which holds only as long as the child's state locations
 * are derived from `HOME`. Each name here defeats that derivation: an ambient
 * `CLAUDE_CONFIG_DIR` relocates the CLI's own configuration and account state
 * out of the pool, and the XDG base directories name cache, config, data, and
 * state roots that no `HOME` override reaches. A deployment that exports one —
 * a server started from an operator's own shell, or from another agent — would
 * give every tenant one directory to read and write, while `HOME` still read as
 * isolated.
 *
 * A name the CLI ignores costs nothing: with the variable absent the child
 * falls back to the location under `HOME` this module pins, which is the
 * intended one. A name missing from this list costs a shared directory, so the
 * list covers the standard state-directory variables rather than only those a
 * particular CLI version is known to read.
 */
export const SCRUBBED_STATE_VARIABLES: readonly string[] = [
  'ANTHROPIC_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
]

/**
 * Flags that make the CLI a streaming model endpoint and nothing more.
 *
 * `--tools ""` leaves the CLI no executable tools, because the harness owns
 * tool execution; `--no-session-persistence`, `--strict-mcp-config` and
 * `--setting-sources ""` keep the run from reading or writing host state; and
 * `--permission-prompts none` denies anything that would otherwise block on a
 * prompt no one is present to answer.
 */
const PROTOCOL_ARGUMENTS: readonly string[] = [
  '--print',
  '--output-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--bare',
  '--tools', '',
  '--no-session-persistence',
  '--strict-mcp-config',
  '--setting-sources', '',
  '--permission-prompts', 'none',
]

/**
 * Build the argument vector for one invocation.
 * @param run - the prompt and the per-request generation choices.
 * @returns the CLI arguments, excluding the executable itself.
 * @throws RangeError when `maxBudgetUsd` is present but not a positive finite
 * number, since a ceiling the CLI would reject or ignore is a caller error
 * rather than an unbounded run.
 */
export function claudeCliArguments(run: ClaudeCliRun): string[] {
  if (run.maxBudgetUsd !== undefined && (!Number.isFinite(run.maxBudgetUsd) || run.maxBudgetUsd <= 0)) {
    throw new RangeError('claudeCliArguments: maxBudgetUsd must be a positive finite number')
  }
  return [
    ...PROTOCOL_ARGUMENTS,
    ...run.systemPrompt === undefined ? [] : ['--system-prompt', run.systemPrompt],
    ...run.model === undefined ? [] : ['--model', run.model],
    ...run.effort === undefined ? [] : ['--effort', run.effort],
    ...run.maxBudgetUsd === undefined ? [] : ['--max-budget-usd', String(run.maxBudgetUsd)],
    run.prompt,
  ]
}

/**
 * Build the environment overlay for one invocation.
 *
 * The result is a `dsh-subprocess` overlay: explicit strings survive that
 * seam's parent scrub, and `undefined` removes an ambient entry.
 * @param isolation - the tenant's home directory and API key.
 * @returns the overlay pinning the child to this tenant, with every
 *   provider-routing and state-directory variable tombstoned.
 * @throws RangeError when the home directory or API key is empty, since
 * neither can be defaulted without falling back to host identity.
 */
export function claudeCliEnvironment(isolation: ClaudeCliIsolation): NodeJS.ProcessEnv {
  if (isolation.home.length === 0) throw new RangeError('claudeCliEnvironment: home must not be empty')
  if (isolation.apiKey.length === 0) throw new RangeError('claudeCliEnvironment: apiKey must not be empty')
  const overlay: NodeJS.ProcessEnv = {
    HOME: isolation.home,
    ANTHROPIC_API_KEY: isolation.apiKey,
  }
  for (const name of [...SCRUBBED_ROUTING_VARIABLES, ...SCRUBBED_STATE_VARIABLES]) overlay[name] = undefined
  return overlay
}

/**
 * The credential the CLI reports having used, read from its `system`/`init`
 * frame's `apiKeySource`.
 *
 * A run is credential-isolated only when this is `ANTHROPIC_API_KEY`: that is
 * the injected tenant key. `none` means the CLI authenticated some other way —
 * an OAuth session, a bearer token, or a third-party cloud provider — and the
 * run is therefore spending someone other than the tenant.
 * @param frame - one decoded stdout frame.
 * @returns the reported source, or `undefined` when the frame is not an init frame.
 */
export function initApiKeySource(frame: { type?: string; subtype?: string; apiKeySource?: unknown }): string | undefined {
  if (frame.type !== 'system' || frame.subtype !== 'init') return undefined
  return typeof frame.apiKeySource === 'string' ? frame.apiKeySource : undefined
}

/**
 * Whether an init frame proves the run used the injected tenant credential.
 * @param frame - one decoded stdout frame.
 * @returns true only for an init frame reporting `ANTHROPIC_API_KEY`; false for
 *   an init frame reporting anything else, and undefined for any other frame,
 *   so a caller can tell "not isolated" from "not an answer".
 */
export function isCredentialIsolated(frame: { type?: string; subtype?: string; apiKeySource?: unknown }): boolean | undefined {
  const source = initApiKeySource(frame)
  return source === undefined ? undefined : source === 'ANTHROPIC_API_KEY'
}
