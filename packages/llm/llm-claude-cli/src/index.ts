/**
 * Serves a provider route by running the Claude CLI as a model endpoint.
 *
 * The plugin registers one {@link ClaudeCliAdapter} on the `dsh-llm` seam from
 * its configuration: one executable, one home directory, and one credential.
 * That is the single-tenant composition. A multi-tenant runtime does not load
 * this plugin once and vary identity per request — it constructs one adapter
 * per runtime pool, because the isolation lives on the instance and there is
 * no request parameter through which one tenant could reach another's
 * credential.
 *
 * @module @deepseek-ai/dsh-llm-claude-cli
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ClaudeCliAdapter, type ClaudeCliAdapterOptions } from './adapter.ts'

export { ClaudeCliAdapter, CLI_EXIT_CODE, CREDENTIAL_LEAK_CODE } from './adapter.ts'
export type { ClaudeCliAdapterOptions } from './adapter.ts'
export { projectRequest, UNSUPPORTED_REQUEST_CODE } from './request.ts'

export const name = 'llm-claude-cli'
export const inject = ['llm', 'subprocess']

/** Provider route this plugin serves. */
export const PROVIDER = 'claude-cli'

/** Deployment-varying facts for one Claude CLI route. */
export interface Config {
  /** Absolute path to the `claude` executable; defaults to `claude` on PATH. */
  executable?: string
  /** Working directory for each run. */
  cwd: string
  /** `HOME` for each run: the runtime pool root whose provider state this route owns. */
  home: string
  /** Environment variable holding the API key to inject. */
  apiKeyEnv?: string
  /** Process-tree termination grace in milliseconds. */
  graceMs?: number
  /** Per-invocation spend ceiling in US dollars; omitted applies none. */
  maxBudgetUsd?: number
  /** Fail a run the CLI authenticated with another credential; defaults to true. */
  requireCredentialIsolation?: boolean
}

export const Config: z<Config> = z.object({
  executable: z.string().default('claude'),
  cwd: z.string(),
  home: z.string(),
  apiKeyEnv: z.string().role('credential-ref').default('ANTHROPIC_API_KEY'),
  graceMs: z.number().step(1).min(1).default(5_000),
  maxBudgetUsd: z.number().min(Number.MIN_VALUE),
  requireCredentialIsolation: z.boolean().default(true),
})

/** Defaults a composition may omit, named once here rather than inside `apply`. */
export const DEFAULT_EXECUTABLE = 'claude'
/** Environment variable a composition reads its credential from by default. */
export const DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY'
/** Process-tree termination grace a composition gets when it names none. */
export const DEFAULT_GRACE_MS = 5_000

/**
 * Resolve one configuration into the exact facts an adapter instance runs on.
 *
 * Schemastery fills every defaulted field for a `cordis.yml` composition, but a
 * programmatic one may bypass it, so defaulting happens here — one explicit
 * step with a result — rather than as fallbacks scattered through `apply`.
 * @param config - the route's configuration, as written or as normalized.
 * @param environment - the variables to read the credential from.
 * @returns the adapter facts, minus the process capability the caller supplies.
 * @throws Error when the configured credential variable is absent or empty,
 * since a route that cannot authenticate is a composition error rather than a
 * run that fails later with a confusing provider message.
 */
export function resolveAdapterOptions(
  config: Config,
  environment: Readonly<Record<string, string | undefined>>,
): Omit<ClaudeCliAdapterOptions, 'spawn'> {
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const apiKey = environment[apiKeyEnv]
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`llm-claude-cli: ${apiKeyEnv} is not set, so this route has no credential to inject`)
  }
  return {
    executable: config.executable ?? DEFAULT_EXECUTABLE,
    cwd: config.cwd,
    isolation: { home: config.home, apiKey },
    graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
    maxBudgetUsd: config.maxBudgetUsd,
    requireCredentialIsolation: config.requireCredentialIsolation ?? true,
  }
}

/**
 * Register the Claude CLI route for this composition's configuration.
 * @param ctx - the plugin fiber's context, carrying `llm` and `subprocess`.
 * @param config - the executable, isolation, and process facts for this route.
 */
export function apply(ctx: Context, config: Config): void {
  const adapter = new ClaudeCliAdapter({
    ...resolveAdapterOptions(config, process.env),
    spawn: spec => ctx.subprocess.spawn(spec),
  })
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter))
}
