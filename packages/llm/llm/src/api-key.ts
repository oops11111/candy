/**
 * The one definition of a well-formed provider API key, shared by every
 * adapter that puts one in an HTTP header, and the one way to take it back out
 * of what a provider says about it.
 * @module @deepseek-ai/dsh-llm/api-key
 */

import type { StreamChunk } from './types.ts'

/**
 * Characters an HTTP header value carries verbatim and every known provider
 * key uses: printable ASCII, space excluded. A key outside this set cannot
 * reach any provider — `fetch` refuses to build the header — so this is a
 * transport invariant rather than one provider's policy. Latin-1 is excluded
 * deliberately: a header could carry it, but no provider issues it, and
 * admitting it trades a local explained refusal for an opaque 401.
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/** Why a supplied API key cannot be used. */
export type ApiKeyRejection = 'empty' | 'illegalCharacters'

/** The verdict on one supplied API key. */
export type ApiKeyCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: ApiKeyRejection }

/**
 * Judge one *supplied* API key, trimming surrounding whitespace first.
 *
 * Trimming is silent because a padded key has one unambiguous reading; every
 * other defect is reported. Absence is a configuration state this function
 * never sees — a profile naming no credential authenticates through the
 * provider's own ambient discovery or OAuth — so callers decide whether a
 * value was supplied before asking.
 * @param raw - the key exactly as configured, stored, or typed.
 * @returns the trimmed key, or why it cannot be used.
 */
export function normalizeApiKey(raw: string): ApiKeyCheck {
  const value = raw.trim()
  if (value.length === 0) return { ok: false, reason: 'empty' }
  if (!LEGAL_API_KEY.test(value)) return { ok: false, reason: 'illegalCharacters' }
  return { ok: true, value }
}

/** Stands in for a provider credential wherever diagnostics quote it back. */
export const REDACTED_API_KEY = '[redacted]'

/**
 * Take a provider credential back out of text a caller will see.
 *
 * Provider diagnostics quote the request that failed, and the request carried
 * the credential, so an error body naming the rejected key puts it wherever
 * the adapter's failure goes — a session log, an operator's console, a model's
 * transcript. An adapter holds the key and the provider's text at the same
 * moment; nothing downstream does, because a failure that has left the adapter
 * no longer says which secret it was made with.
 *
 * The match is on the literal key rather than a pattern: a pattern would need
 * every provider's key shape, and would still miss the one it did not know.
 *
 * @param text - provider-authored text about to become a failure a caller reads.
 * @param apiKey - the credential this run authenticated with.
 * @returns the text with every occurrence of the credential replaced; unchanged
 *   when there is no credential to look for.
 */
export function redactApiKey(text: string, apiKey: string): string {
  // An empty key would split the text into its characters and rejoin them
  // around the placeholder, so the one value that cannot be searched for is
  // refused rather than mangled.
  if (apiKey.length === 0) return text
  return text.split(apiKey).join(REDACTED_API_KEY)
}

/**
 * Take a provider credential out of a terminal chunk's failure text.
 *
 * Only the failure is rewritten. Model output is the caller's own content, and
 * editing it silently would corrupt a legitimate answer that happens to
 * discuss a key.
 *
 * @param chunk - one chunk about to leave an adapter.
 * @param apiKey - the credential this run authenticated with.
 * @returns the chunk, with the credential replaced in any failure it carries.
 */
export function redactChunkApiKey(chunk: StreamChunk, apiKey: string): StreamChunk {
  if (chunk.type !== 'finish' || !('failure' in chunk.reason)) return chunk
  const { failure } = chunk.reason
  return {
    ...chunk,
    reason: {
      ...chunk.reason,
      failure: {
        ...failure,
        message: redactApiKey(failure.message, apiKey),
        code: redactApiKey(failure.code, apiKey),
      },
    },
  }
}
