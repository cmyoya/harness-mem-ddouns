/**
 * privacy-tags.ts — Ingest-time sanitizer for <private>...</private> blocks.
 *
 * Strip <private>...</private> blocks from observation content BEFORE embedding
 * and BEFORE persisted content write. This is a default-on, no-opt-out sanitizer.
 *
 * Design notes:
 *   - Applied at the ingest choke point (recordEvent) before buildObservationFromEvent.
 *   - tags / privacy_tags arrays on an observation are NOT affected.
 *   - Strips the block entirely (not replaced with [REDACTED]).
 *   - If the entire content is private blocks, result is "". No error is thrown.
 *   - Malformed tags (no matching close tag) are left as-is to avoid data loss.
 *
 * DDouns fork addendum (Apache-2.0):
 *   - `stripPrivateBlocksAudited` adds an emit callback so callers can record
 *     a row into `mem_audit_log` whenever content is silently sanitized.
 *     The callback receives (count, hashes[]) where each hash is the first
 *     16 hex chars of sha256(block_with_tags). The plaintext is NEVER
 *     surfaced to the callback — only the hash, so audit rows stay PII-safe.
 *   - `stripPrivateBlocks` is preserved verbatim as a thin alias to the raw
 *     implementation for backward compatibility with existing callers and
 *     the unit-test suite (tests/unit/privacy-tags.test.ts).
 *
 * Co-Authored-By: cmyoya/DDouns <https://github.com/cmyoya/DDouns> — Apache-2.0
 */

import { createHash } from "node:crypto";

const PRIVATE_TAG_RE = /<private\b[^>]*>[\s\S]*?<\/private>/gi;

export interface StripAuditOptions {
  onStrip?: (count: number, hashes: string[]) => void;
}

/**
 * Raw strip — identical semantics to the original `stripPrivateBlocks`.
 * No audit, no callback. Reserved for hot-path callers that have already
 * audited (or for testing the regex in isolation).
 */
export function stripPrivateBlocksRaw(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  return text.replace(PRIVATE_TAG_RE, "");
}

/**
 * Strip all well-formed `<private>...</private>` blocks (case-insensitive, multi-line).
 *
 * - Returns input unchanged when it is null, undefined, or empty string.
 * - Handles attributes: `<private reason="credentials">...</private>` is stripped.
 * - Multiple blocks are all stripped independently (non-greedy).
 * - Unbalanced / malformed tags (no closing `</private>`) are left untouched.
 * - Whitespace between stripped blocks is preserved as-is (two spaces is acceptable).
 *
 * Backward-compatible alias of `stripPrivateBlocksRaw`. Call
 * `stripPrivateBlocksAudited` instead in new code paths.
 */
export function stripPrivateBlocks(text: string | null | undefined): string | null | undefined {
  return stripPrivateBlocksRaw(text);
}

/**
 * Audit-emitting strip. Same semantics as `stripPrivateBlocks` for the
 * returned value, plus an optional callback fired once per call when at
 * least one block was stripped. Hashes are sha256(block)[..16].
 */
export function stripPrivateBlocksAudited(
  text: string | null | undefined,
  opts: StripAuditOptions = {}
): string | null | undefined {
  if (!text) return text;
  const matches = text.match(PRIVATE_TAG_RE);
  const stripped = text.replace(PRIVATE_TAG_RE, "");
  if (matches && matches.length > 0 && typeof opts.onStrip === "function") {
    const hashes = matches.map((m) => createHash("sha256").update(m).digest("hex").slice(0, 16));
    opts.onStrip(matches.length, hashes);
  }
  return stripped;
}
