/**
 * The Claude CLI's `--output-format stream-json` line protocol, as a pure
 * library: frame decoding, translation into the harness `StreamChunk`
 * vocabulary, and composition of an isolated invocation.
 *
 * This package owns what the CLI's output means and what an invocation must
 * say; it spawns nothing. The `dsh-llm` adapter that runs the CLI supplies the
 * process, so the protocol can be tested against recorded output with no
 * credential, no network, and no child process.
 *
 * The behavior encoded here was derived from `claude` 2.1.259 and the
 * `@anthropic-ai/claude-agent-sdk` declarations shipped with it, not from the
 * CLI's documentation. Three findings are load-bearing and are each documented
 * where they are acted on: the terminal frame's `subtype` says `success` on a
 * wholly failed run ({@link mapFinish}), the CLI's `assistant` frames both
 * duplicate streamed content and carry failure text as if the model wrote it
 * ({@link ClaudeCliFrameTranslator}), and only `--bare` confines the run to the
 * credential the caller injected ({@link claudeCliEnvironment}).
 *
 * @module @deepseek-ai/dsh-claude-cli-protocol
 */

export { ClaudeCliFrameTranslator, mapFinish, mapUsage } from './frames.ts'
export { ClaudeCliLineDecoder, ClaudeCliProtocolError } from './lines.ts'
export {
  CLAUDE_CLI_EFFORTS,
  claudeCliArguments,
  claudeCliEnvironment,
  initApiKeySource,
  isCredentialIsolated,
  SCRUBBED_ROUTING_VARIABLES,
  SCRUBBED_STATE_VARIABLES,
} from './launch.ts'
export type { ClaudeCliEffort, ClaudeCliIsolation, ClaudeCliRun } from './launch.ts'
export type { WireFrame, WireResult, WireStreamEvent, WireUsage } from './types.ts'
