/**
 * Project one harness request onto a Claude CLI invocation, or refuse it.
 *
 * The CLI is a one-shot prompt surface, not a stateless chat endpoint, and the
 * gap between the two is this module's whole subject. `GenerateOptions` carries
 * a full conversation and a tool catalogue; the CLI's command line accepts one
 * positional prompt, a system prompt, a model, and an effort level. Nothing
 * here invents a way to close that gap: an option the CLI cannot carry is
 * refused with a specific reason rather than dropped, so a caller never
 * discovers by reading output that half its request went nowhere.
 *
 * @module dsh-llm-claude-cli/request
 */

import { CLAUDE_CLI_EFFORTS, type ClaudeCliEffort, type ClaudeCliRun } from '@deepseek-ai/dsh-claude-cli-protocol'
import { LlmError, type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'

/** Machine code for a request this adapter cannot express as a CLI invocation. */
export const UNSUPPORTED_REQUEST_CODE = 'UNSUPPORTED_REQUEST'

/** Refuse a request with the reason the CLI cannot carry it. */
function refuse(reason: string): never {
  throw new LlmError(`claude CLI adapter: ${reason}`, UNSUPPORTED_REQUEST_CODE)
}

/**
 * Read the one user turn a CLI invocation can carry.
 *
 * Multi-turn history is refused rather than flattened. The CLI's
 * `--input-format stream-json` accepts only user messages, and each one it
 * accepts starts its own turn with its own terminal frame, so it replays no
 * assistant history and cannot serve one model call. Rendering the history
 * into the prompt as text would mean inventing a transcript format this
 * repository has no evidence for, and getting it wrong degrades model output
 * silently. The decision is therefore deferred to a consumer that needs it.
 * @param messages - the request's conversation, exactly as the seam assembled it.
 * @returns the single user turn's text.
 */
function soleUserTurn(messages: readonly Message[]): string {
  if (messages.length === 0) refuse('a request must carry one user message')
  if (messages.length > 1) {
    refuse('the CLI starts a fresh turn per invocation and cannot replay assistant history, '
      + `so it cannot serve a ${String(messages.length)}-message conversation`)
  }
  const [message] = messages
  if (message === undefined || message.role !== 'user') {
    refuse('the one message must be a user message')
  }
  const texts: string[] = []
  for (const block of message.content) {
    if (block.type !== 'text') {
      refuse(`the CLI's positional prompt carries text only, not a ${block.type} block`)
    }
    texts.push(block.text)
  }
  const prompt = texts.join('')
  if (prompt.trim().length === 0) refuse('the prompt must not be empty')
  return prompt
}

/**
 * Map a caller's reasoning effort to a level the CLI accepts.
 * @param effort - the branded effort id from the request, when one was chosen.
 * @returns the CLI level, or undefined when the caller chose none.
 */
function cliEffort(effort: string | undefined): ClaudeCliEffort | undefined {
  if (effort === undefined) return undefined
  const level = CLAUDE_CLI_EFFORTS.find(candidate => candidate === effort)
  // The seam brands effort ids opaquely, so an id minted by another adapter is
  // a routing mistake rather than a value to silently drop.
  return level ?? refuse(`the CLI does not accept the reasoning effort "${effort}"`)
}

/**
 * Project one assembled request onto a CLI invocation.
 *
 * @param options - the fully-assembled harness request.
 * @param maxBudgetUsd - a per-invocation spend ceiling the adapter applies to
 *   every run it makes, when its deployment configured one.
 * @returns the invocation the CLI can be asked to perform.
 * @throws LlmError with code `UNSUPPORTED_REQUEST` when the request carries a
 * conversation, non-text content, tool schemas, or a generation control the
 * CLI has no flag for. Each is refused separately so the message names the one
 * thing that stopped the run.
 */
export function projectRequest(options: GenerateOptions, maxBudgetUsd?: number): ClaudeCliRun {
  if (options.tools !== undefined && options.tools.length > 0) {
    // The CLI's --tools selects among its own built-in tools; no flag accepts a
    // caller's schemas, and reaching them through MCP is a separate mechanism.
    refuse('the CLI accepts no caller-supplied tool schemas')
  }
  if (options.maxTokens !== undefined) refuse('the CLI has no output-token cap flag')
  if (options.temperature !== undefined) refuse('the CLI has no temperature flag')
  if (options.stop !== undefined && options.stop.length > 0) refuse('the CLI has no stop-sequence flag')
  return {
    prompt: soleUserTurn(options.messages),
    systemPrompt: options.system,
    model: options.model,
    effort: cliEffort(options.reasoningEffort),
    maxBudgetUsd,
  }
}
