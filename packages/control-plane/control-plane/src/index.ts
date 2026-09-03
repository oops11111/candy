/**
 * Candy control-plane identity: the branded ids the control plane is the sole
 * authority for, plus the run-ancestry record a child run's authorization
 * check walks.
 *
 * These ids name the entities enumerated in
 * {@link https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/candy-runtime-boundaries.md | Candy Runtime Boundaries}:
 * `userId`, `deviceId`, `accountId`, `workspaceGrantId`, `conversationId`,
 * `sessionId`, and child-run ancestry. `sessionId` is `SessionId` from
 * `@deepseek-ai/dsh-session`, reused unchanged — this package does not
 * redefine it, since dsh-session already owns that brand and its Harness
 * session-log semantics.
 *
 * @module @deepseek-ai/dsh-control-plane
 */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/**
 * Which provider a run executes and a provider account authenticates against.
 *
 * The set is closed because the delivery plan names exactly these three: the
 * DeepSeek API, the Claude CLI, and the Codex CLI. A fourth provider is a plan
 * change, not a configuration value. The kind lives here rather than beside
 * the runtime-pool key because an account, an assertion, and a pool all name
 * it, and it is a union of string literals with no dependency of its own.
 */
export type ProviderKind = 'deepseek-api' | 'claude-cli' | 'codex-cli'

/** Identifies one authenticated Candy user across devices, provider accounts, and runs. */
export type UserId = Branded<'UserId'>

/**
 * Brand a string as a {@link UserId}.
 * @param id - the control-plane-issued user id.
 * @returns the same string, branded; no validation is performed.
 */
export function UserId(id: string): UserId {
  return brandString<UserId>(id)
}

/** Identifies one paired device — a Windows Harness Host or a browser client — bound to one user. */
export type DeviceId = Branded<'DeviceId'>

/**
 * Brand a string as a {@link DeviceId}.
 * @param id - the control-plane-issued device id.
 * @returns the same string, branded; no validation is performed.
 */
export function DeviceId(id: string): DeviceId {
  return brandString<DeviceId>(id)
}

/** Identifies one provider account record — a DeepSeek API key or a Claude/Codex CLI login — owned by one user. */
export type ProviderAccountId = Branded<'ProviderAccountId'>

/**
 * Brand a string as a {@link ProviderAccountId}.
 * @param id - the control-plane-issued provider-account id.
 * @returns the same string, branded; no validation is performed.
 */
export function ProviderAccountId(id: string): ProviderAccountId {
  return brandString<ProviderAccountId>(id)
}

/** Identifies one grant authorizing a device to operate on a named workspace root and operation class. */
export type WorkspaceGrantId = Branded<'WorkspaceGrantId'>

/**
 * Brand a string as a {@link WorkspaceGrantId}.
 * @param id - the control-plane-issued workspace-grant id.
 * @returns the same string, branded; no validation is performed.
 */
export function WorkspaceGrantId(id: string): WorkspaceGrantId {
  return brandString<WorkspaceGrantId>(id)
}

/**
 * Identifies one control-plane conversation: the tenant-visible thread that
 * owns one or more Harness sessions over its lifetime (for example across a
 * fork or resume). Distinct from `SessionId`, which names one Harness
 * session-log identity.
 */
export type ConversationId = Branded<'ConversationId'>

/**
 * Brand a string as a {@link ConversationId}.
 * @param id - the control-plane-issued conversation id.
 * @returns the same string, branded; no validation is performed.
 */
export function ConversationId(id: string): ConversationId {
  return brandString<ConversationId>(id)
}

/** Identifies one agent run: one provider invocation, root or child. */
export type RunId = Branded<'RunId'>

/**
 * Brand a string as a {@link RunId}.
 * @param id - the control-plane-issued run id.
 * @returns the same string, branded; no validation is performed.
 */
export function RunId(id: string): RunId {
  return brandString<RunId>(id)
}

/**
 * One run's position in its ancestry chain. `parentRunId` is `undefined` for
 * a root run and the scheduling run's id for a child run.
 *
 * This is the complete ancestry record this package defines: a "child run"
 * is a `RunId` whose lineage carries a `parentRunId`, not a separate id
 * brand, because nothing distinguishes a child run's identity from a root
 * run's except that link. Verifying that a child run's account, workspace,
 * tool, token, time, and concurrency grants stay within its parent's is the
 * orchestration authorization check the control plane runs when it admits a
 * child run — this record names the chain that check walks, and does not
 * itself perform or encode that check.
 */
export interface RunLineage {
  /** This run's own id. */
  readonly runId: RunId
  /** The run that scheduled this one, or `undefined` for a root run. */
  readonly parentRunId: RunId | undefined
}
