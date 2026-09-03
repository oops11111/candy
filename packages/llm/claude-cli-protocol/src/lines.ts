/**
 * Decode the Claude CLI's stdout into frames.
 *
 * The CLI writes one JSON object per line and nothing else on that stream, so
 * decoding is line splitting plus `JSON.parse`. The only subtlety is where a
 * run is cut short: killing the CLI can leave a final line unterminated, which
 * is why an unterminated tail is discarded by {@link ClaudeCliLineDecoder.flush}
 * while a *complete* line that is not a JSON object throws — a terminated line
 * the CLI wrote is always one, so anything else means this decoder is not
 * reading what it believes it is.
 *
 * @module dsh-claude-cli-protocol/lines
 */

import type { WireFrame } from './types.ts'

/** Thrown when a complete stdout line is not a JSON object. */
export class ClaudeCliProtocolError extends Error {
  /**
   * @param line - the offending complete line, retained for diagnostics.
   * @param cause - the underlying parse failure, when there was one.
   */
  constructor(readonly line: string, cause?: unknown) {
    super('claude CLI wrote a stdout line that is not a JSON object')
    this.name = 'ClaudeCliProtocolError'
    if (cause !== undefined) this.cause = cause
  }
}

/** Parse one complete line into a frame. */
function parseLine(line: string): WireFrame {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    throw new ClaudeCliProtocolError(line, error)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ClaudeCliProtocolError(line)
  }
  return value
}

/**
 * Incremental line decoder for one run's stdout.
 *
 * Holds the partial trailing line between reads, so one instance serves
 * exactly one process and its buffer must not be shared across runs.
 */
export class ClaudeCliLineDecoder {
  private partial = ''

  /**
   * Decode every complete line in one read.
   * @param chunk - stdout text as read, which may begin or end mid-line.
   * @returns the frames completed by this chunk, in stream order.
   * @throws ClaudeCliProtocolError when a complete line is not a JSON object.
   */
  push(chunk: string): WireFrame[] {
    const text = this.partial + chunk
    const lastBreak = text.lastIndexOf('\n')
    // Everything after the final newline is the next read's problem; a chunk
    // ending exactly on one leaves an empty partial, the same state as having
    // consumed nothing yet.
    this.partial = text.slice(lastBreak + 1)
    if (lastBreak === -1) return []
    return text.slice(0, lastBreak).split('\n').filter(line => line.trim().length > 0).map(parseLine)
  }

  /**
   * Finish decoding after stdout closes.
   * @returns the frame held in a complete-but-unterminated final line, if the
   *   stream ended without a newline; empty when the tail is blank or when the
   *   process was killed mid-line, since a truncated JSON object is not a
   *   frame this decoder can honestly report.
   */
  flush(): WireFrame[] {
    const tail = this.partial
    this.partial = ''
    if (tail.trim().length === 0) return []
    try {
      return [parseLine(tail)]
    } catch {
      // A killed CLI leaves a half-written line. Losing it is correct: the
      // caller classifies the run from the exit it observed, not from a
      // fragment whose fields cannot be trusted to be complete.
      return []
    }
  }
}
