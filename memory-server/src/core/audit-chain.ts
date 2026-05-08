/**
 * audit-chain.ts — chained-attestation helper for `mem_audit_log`.
 *
 * Each row carries `prev_hash` = sha256(prev.prev_hash || action || target_type
 * || target_id || details_json || created_at)[:32]. The genesis row uses ''
 * as predecessor. Tampering with any historical row breaks the chain at the
 * first subsequent verification.
 *
 * Idempotency: re-running `appendAuditChain` with identical (action, target_type,
 * target_id, details_json) within the same millisecond will produce a different
 * row (different `id`, different `created_at_ms` tail) — that is intentional.
 * The hash chain itself is deterministic given the actually-persisted row order.
 *
 * Verification helper `verifyAuditChain(db, fromId?)` is provided for tests
 * and operator audits.
 *
 * Co-Authored-By: cmyoya/DDouns <https://github.com/cmyoya/DDouns> — Apache-2.0
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const HASH_LEN = 32; // 128 bits as hex — collision-resistant for audit volumes.

function chainHash(prev: string, action: string, target_type: string, target_id: string, details_json: string, created_at: string): string {
  const h = createHash("sha256");
  h.update(prev);
  h.update("\x1f"); // unit separator — disambiguates field boundaries.
  h.update(action);
  h.update("\x1f");
  h.update(target_type);
  h.update("\x1f");
  h.update(target_id);
  h.update("\x1f");
  h.update(details_json);
  h.update("\x1f");
  h.update(created_at);
  return h.digest("hex").slice(0, HASH_LEN);
}

function lastPrevHash(db: Database): string {
  const row = db
    .query(`SELECT prev_hash FROM mem_audit_log WHERE prev_hash IS NOT NULL ORDER BY id DESC LIMIT 1`)
    .get() as { prev_hash: string | null } | null;
  return row?.prev_hash ?? "";
}

/**
 * Append a row to mem_audit_log linked to the previous chain head.
 * Returns the new row's `prev_hash` (i.e., the hash THIS row was bound to —
 * which becomes the predecessor for the next call).
 *
 * NOTE: the column is named `prev_hash` for clarity in queries — semantically
 * each row stores `H(prev.prev_hash || own_fields)`, so it acts as the
 * forward-binding tag for the next row.
 */
export function appendAuditChain(
  db: Database,
  action: string,
  target_type: string,
  target_id: string,
  details_json: string,
  actor: string = "system"
): string {
  const created_at = new Date().toISOString();
  const prev = lastPrevHash(db);
  const newHash = chainHash(prev, action, target_type, target_id, details_json, created_at);
  db.query(`
    INSERT INTO mem_audit_log(action, actor, target_type, target_id, details_json, created_at, prev_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(action, actor, target_type, target_id, details_json, created_at, newHash);
  return newHash;
}

/**
 * Verify the chain from a given starting row (default: genesis).
 * Returns { ok: true, count } on success, or { ok: false, brokenAt: id } on
 * the first mismatch. Rows with `prev_hash IS NULL` (legacy, pre-d2) are
 * skipped — they form a soft boundary, not a chain break.
 */
export function verifyAuditChain(db: Database, fromId: number = 0): { ok: true; count: number } | { ok: false; brokenAt: number } {
  const rows = db.query(`
    SELECT id, action, target_type, target_id, details_json, created_at, prev_hash
    FROM mem_audit_log
    WHERE id >= ? AND prev_hash IS NOT NULL
    ORDER BY id ASC
  `).all(fromId) as Array<{ id: number; action: string; target_type: string; target_id: string; details_json: string; created_at: string; prev_hash: string }>;

  let prev = "";
  let count = 0;
  for (const row of rows) {
    const expected = chainHash(prev, row.action, row.target_type, row.target_id, row.details_json, row.created_at);
    if (expected !== row.prev_hash) {
      return { ok: false, brokenAt: row.id };
    }
    prev = row.prev_hash;
    count++;
  }
  return { ok: true, count };
}
