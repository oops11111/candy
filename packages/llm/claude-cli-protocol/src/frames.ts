/**
 * Translate Claude CLI stdout frames into the harness `StreamChunk` protocol.
 *
 * The CLI multiplexes several independent reports onto one line-delimited
 * stream. Only two of them describe the model call being made:
 * `stream_event`, which carries verbatim Anthropic Messages API streaming
 * events, and the terminal `result`. Everything else on the stream — session
 * bookkeeping, rate-limit reports, hook and task activity, and the CLI's own
 * `assistant` frames — is ignored, and the frame union is open, so unknown
 * tags fall through the documented default rather than failing the run.
 *
 * The `assistant` frames are ignored deliberately, not incidentally. They
 * duplicate content the `stream_event` deltas already delivered, and on a
 * failed run the CLI synthesizes one carrying the failure text as assistant
 * content under `model: "<synthetic>"`. Reading them would both double every
 * block and let a transport failure enter the transcript as model output.
 *
 * @module dsh-claude-cli-protocol/frames
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ContentBlock,
  FinishReason,
  StreamChunk,
  TokenUsage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { WireFrame, WireResult, WireStreamEvent, WireUsage } from './types.ts'

/**
 * The harness block types this translator opens. Narrower than `ContentBlockType`
 * so block assembly is total: every kind {@link blockKind} admits has a case in
 * {@link closeBlock}, and a later core block type cannot silently reach it.
 */
type OpenBlockKind = 'text' | 'reasoning' | 'tool-call'

/** One content block under assembly, keyed by the wire's block index. */
interface OpenBlock {
  kind: OpenBlockKind
  text: string
  callId: string
  name: string
}

/**
 * Map a Messages API content-block type to a harness block type.
 * @param type - the wire `content_block.type`.
 * @returns the harness block type, or `undefined` for a block this translator does
 *   not represent (`redacted_thinking` and any later addition), whose deltas
 *   are then dropped rather than misfiled under a block type that would render.
 */
function blockKind(type: string | undefined): OpenBlockKind | undefined {
  switch (type) {
    case 'text': return 'text'
    case 'thinking': return 'reasoning'
    case 'tool_use': return 'tool-call'
    default: return undefined
  }
}

/** Assemble the finished ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: brandString<ToolCallId>(block.callId),
      name: block.name,
      arguments: block.text,
    }
  }
}

/**
 * Map the CLI's token counts to harness `TokenUsage`.
 *
 * The counts arrive already disjoint — `input_tokens` excludes both cache
 * figures — which is the harness convention, so this maps rather than
 * subtracts. `totalTokens` is the sum of the three billed input counts and the
 * output count, present only when every contributing counter is a safe
 * non-negative integer.
 * @param usage - wire counts from a `message_delta` or `result` frame.
 * @returns disjoint harness counts.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheRead = validCount(usage.cache_read_input_tokens)
  const cacheWrite = validCount(usage.cache_creation_input_tokens)
  const reasoning = validCount(usage.output_tokens_details?.thinking_tokens)
  const parts = [input, output, cacheRead ?? 0, cacheWrite ?? 0]
  const total = parts.reduce((sum, part) => sum + part, 0)
  const exact = parts.every(part => Number.isSafeInteger(part) && part >= 0) && Number.isSafeInteger(total)
  return {
    inputTokens: validCount(input) ?? 0,
    outputTokens: validCount(output) ?? 0,
    ...exact ? { totalTokens: total } : {},
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

function validCount(count: number | undefined): number | undefined {
  return count !== undefined && Number.isSafeInteger(count) && count >= 0 ? count : undefined
}

/**
 * Classify the terminal `result` frame.
 *
 * `subtype` is not consulted: the CLI reports `subtype: "success"` on a run
 * whose every request failed authentication, so only `is_error` separates a
 * completed turn from a failed one. When it is set, `api_error_status` carries
 * the provider status and `terminal_reason` the CLI's own classification.
 * @param result - the terminal frame's fields.
 * @returns the harness finish reason for the run.
 */
export function mapFinish(result: WireResult): FinishReason {
  if (result.is_error === true) {
    const status = result.api_error_status
    return {
      kind: 'error',
      failure: {
        message: result.result ?? 'claude CLI reported a failed run',
        code: (result.terminal_reason ?? 'cli_error').toUpperCase(),
        ...typeof status === 'number' ? { status } : {},
      },
    }
  }
  switch (result.stop_reason) {
    case 'tool_use': return { kind: 'tool-calls' }
    case 'max_tokens': return { kind: 'max-tokens' }
    // `stop_sequence` and a null stop_reason are both ordinary completions.
    case 'end_turn': case 'stop_sequence': case null: case undefined: return { kind: 'stop' }
    default: return {
      kind: 'error',
      failure: {
        message: `model stopped: ${result.stop_reason}`,
        code: result.stop_reason.toUpperCase(),
      },
    }
  }
}

/**
 * Stateful translator for one CLI run's stdout frames.
 *
 * Blocks are assembled across frames, so one instance serves exactly one run.
 * The translator never throws on frame content: an unrecognized tag, an
 * unmodelled block type, and a delta for a block that was never opened all
 * yield no chunks, because the CLI's stream carries reports this package does
 * not own and must not fail the run over.
 */
export class ClaudeCliFrameTranslator {
  private readonly open = new Map<number, OpenBlock>()
  private latestUsage: WireUsage | undefined
  private finished = false

  /**
   * Translate one decoded stdout frame.
   * @param frame - one parsed JSON line from the CLI's stdout.
   * @returns the chunks this frame produces, in emission order; empty for the
   *   frames this translator ignores, and empty for every frame after the
   *   terminal `result`, so nothing can follow `finish`.
   */
  translate(frame: WireFrame): StreamChunk[] {
    if (this.finished) return []
    if (frame.type === 'stream_event' && frame.event !== undefined) return this.streamEvent(frame.event)
    if (frame.type === 'result') return this.result(frame)
    return []
  }

  /**
   * Close a run whose CLI exited without a terminal `result` frame.
   * @param reason - the finish the caller classified from the exit itself.
   * @returns the usage seen so far, then the terminal finish; empty when the
   *   run already finished normally.
   */
  end(reason: FinishReason): StreamChunk[] {
    if (this.finished) return []
    this.finished = true
    return [...this.usageChunk(), { type: 'finish', reason }]
  }

  /** The latest usage as a chunk, or nothing when the run reported none. */
  private usageChunk(): StreamChunk[] {
    return this.latestUsage === undefined ? [] : [{ type: 'usage', usage: mapUsage(this.latestUsage) }]
  }

  /** Translate one Messages API streaming event. */
  private streamEvent(event: WireStreamEvent): StreamChunk[] {
    switch (event.type) {
      case 'content_block_start': return this.blockStart(event)
      case 'content_block_delta': return this.blockDelta(event)
      case 'content_block_stop': return this.blockStop(event)
      case 'message_delta':
        // The last message_delta's counts stand in when the run never reaches
        // a result frame; a result frame's own counts supersede them.
        if (event.usage !== undefined) this.latestUsage = event.usage
        return []
      // message_start's counts are preliminary, and message_stop precedes the
      // result frame that actually finishes the run.
      default: return []
    }
  }

  /** Open one block and announce it. */
  private blockStart(event: WireStreamEvent): StreamChunk[] {
    const kind = blockKind(event.content_block?.type)
    if (kind === undefined || event.index === undefined) return []
    this.open.set(event.index, {
      kind,
      text: '',
      callId: event.content_block?.id ?? '',
      name: event.content_block?.name ?? '',
    })
    return [{ type: 'block-start', index: event.index, blockType: kind }]
  }

  /** Accumulate one delta into its open block and forward it. */
  private blockDelta(event: WireStreamEvent): StreamChunk[] {
    const index = event.index
    if (index === undefined) return []
    const block = this.open.get(index)
    if (block === undefined) return []
    switch (event.delta?.type) {
      case 'text_delta': {
        const text = event.delta.text ?? ''
        block.text += text
        return [{ type: 'text-delta', index, text }]
      }
      case 'thinking_delta': {
        const text = event.delta.thinking ?? ''
        block.text += text
        return [{ type: 'reasoning-delta', index, text }]
      }
      case 'input_json_delta': {
        const argumentsDelta = event.delta.partial_json ?? ''
        block.text += argumentsDelta
        return [{
          type: 'tool-call-delta',
          index,
          id: brandString<ToolCallId>(block.callId),
          name: block.name,
          argumentsDelta,
        }]
      }
      // signature_delta carries the thinking signature, which the harness does
      // not model, and later delta types are unknown to this translator.
      default: return []
    }
  }

  /** Close one open block and emit its assembled content. */
  private blockStop(event: WireStreamEvent): StreamChunk[] {
    const index = event.index
    if (index === undefined) return []
    const block = this.open.get(index)
    if (block === undefined) return []
    this.open.delete(index)
    return [{ type: 'block-end', index, block: closeBlock(block) }]
  }

  /** Finish the run from its terminal frame. */
  private result(result: WireResult): StreamChunk[] {
    this.finished = true
    if (result.usage !== undefined) this.latestUsage = result.usage
    return [...this.usageChunk(), { type: 'finish', reason: mapFinish(result) }]
  }
}
