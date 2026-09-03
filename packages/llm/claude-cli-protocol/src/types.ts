/**
 * The subset of the Claude CLI's `--output-format stream-json` line protocol
 * this package reads. The CLI writes one JSON object per line; the frame union
 * is open and version-specific, so these types describe only the members the
 * translator acts on and deliberately leave every other member unmodelled.
 *
 * Field names are the CLI's own, verified against `claude` 2.1.259 output and
 * the `@anthropic-ai/claude-agent-sdk` 0.3.241 declarations that ship with it.
 */

/** One `stream_event` frame's payload: an Anthropic Messages API streaming event. */
export interface WireStreamEvent {
  type: string
  index?: number
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string | null
  }
  content_block?: {
    type?: string
    id?: string
    name?: string
  }
  usage?: WireUsage
}

/**
 * Messages API token counts as the CLI reports them. These are already
 * DISJOINT — `input_tokens` excludes both cache figures — which is the harness
 * `TokenUsage` convention, so no subtraction is required here.
 */
export interface WireUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens_details?: {
    thinking_tokens?: number
  }
}

/**
 * The terminal `result` frame.
 *
 * `subtype` is NOT a success signal: an authentication failure that exhausted
 * the CLI's internal retries still reports `subtype: "success"` alongside
 * `is_error: true`. Only `is_error` and `api_error_status` classify the run.
 */
export interface WireResult {
  subtype?: string
  is_error?: boolean
  api_error_status?: number | null
  stop_reason?: string | null | undefined
  terminal_reason?: string
  result?: string
  usage?: WireUsage
  /**
   * What the CLI billed for the whole invocation, in US dollars, including the
   * auxiliary models it ran for itself. Only a `result` frame reports one.
   */
  total_cost_usd?: number
  session_id?: string
}

/**
 * One decoded stdout line, narrowed only by its `type` tag.
 *
 * It carries the terminal frame's fields directly because every one of them is
 * optional: a decoded line is not yet known to be a `result`, and reading it as
 * one must not require a cast that would also admit a frame of any other type.
 */
export interface WireFrame extends WireResult {
  type?: string
  event?: WireStreamEvent
  message?: { model?: string }
}
