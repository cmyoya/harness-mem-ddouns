/**
 * ddouns-gate.ts — substrate gate for `recordEvent` chokepoint.
 *
 * L1 (hot-path, synchronous, no LLM):
 *   - dedupCheckL1: takes the SAME `content_dedupe_hash` the storage layer
 *     uses (computed by event-recorder's `buildContentDedupeHash`) and
 *     queries `mem_observations.content_dedupe_hash` directly. The column is
 *     indexed and used by the canonical UNIQUE-constraint dedup path, so
 *     the gate now decides on the same hash space the corpus persists.
 *   - closureCheckL1: scans content for `<closure_evidence tag="..."/>`;
 *     if a marker is present, the referenced tag MUST resolve via
 *     `git rev-parse <tag>^{commit}`. Tag-not-found = reject.
 *
 * L2 (semantic LLM judge): TODO — see `evaluateGateL2`.
 *
 * Configuration is fully env-driven so this module is safe to no-op when
 * DDOUNS_GATE_ENABLED is unset, which is the default.
 *
 *   DDOUNS_GATE_ENABLED   "1" -> on. Anything else -> off.
 *   DDOUNS_GATE_MODE      "block" (default) | "warn" | "audit"
 *   DDOUNS_GATE_GIT_ROOT  optional override for git rev-parse cwd.
 *
 * Co-Authored-By: cmyoya/DDouns <https://github.com/cmyoya/DDouns> — Apache-2.0
 */

import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import type { EventEnvelope } from "./types.js";

export type GateMode = "block" | "warn" | "audit";

export interface GateConfig {
  enabled: boolean;
  mode: GateMode;
  gitRoot: string | undefined;
}

export interface GateContext {
  db: Database;
  observationType: string;
  project: string;
  /**
   * Canonical dedupe hash already computed by the caller via
   * `buildContentDedupeHash(event, observationType, redactedContent)`.
   * Pass-through is intentional: the gate must NOT re-derive the hash
   * with a different format — that was the W2.3 bug. May be null when
   * the content is empty / not dedupable; in that case L1 dedup is skipped.
   */
  contentDedupeHash: string | null;
}

export interface GateVerdict {
  decision: "accept" | "reject" | "warn";
  reasons: string[];
  closure_evidence?: string;
}

export function resolveGateConfig(): GateConfig {
  const enabled = process.env["DDOUNS_GATE_ENABLED"] === "1";
  const rawMode = (process.env["DDOUNS_GATE_MODE"] ?? "block").toLowerCase();
  const mode: GateMode = rawMode === "warn" || rawMode === "audit" ? rawMode : "block";
  const gitRoot = process.env["DDOUNS_GATE_GIT_ROOT"];
  return { enabled, mode, gitRoot };
}

// --- L1 dedup ---------------------------------------------------------------

/**
 * Synchronous indexed-SQL dedup probe. The `mem_observations.content_dedupe_hash`
 * column already backs the production UNIQUE-handling logic in event-recorder;
 * we mirror its lookup path so the gate's verdict and the storage layer agree
 * on the hash space (W2.5 fix — earlier impl computed a different sha256
 * over raw content, which never intersected the JSON-of-fields hash the
 * corpus actually stores).
 */
export function dedupCheckL1(db: Database, candidateHash: string | null): { hit: boolean; hash: string | null } {
  if (!candidateHash) {
    return { hit: false, hash: null };
  }
  try {
    const row = db
      .query(
        "SELECT id FROM mem_observations WHERE content_dedupe_hash = ? AND archived_at IS NULL LIMIT 1"
      )
      .get(candidateHash) as { id: string } | null;
    return { hit: row !== null && row !== undefined, hash: candidateHash };
  } catch {
    // Table may not exist yet on first-run init — degrade gracefully.
    return { hit: false, hash: candidateHash };
  }
}

/** Test/operator helper — clears the closure-evidence tag cache. */
export function _resetGateCachesForTest(): void {
  closureTagCache.clear();
}

// --- L1 closure-evidence ----------------------------------------------------

const CLOSURE_RE = /<closure_evidence\b[^>]*\btag\s*=\s*["']([^"']+)["'][^>]*\/?>/i;
const closureTagCache = new Map<string, boolean>();

function gitTagExists(tag: string, gitRoot: string | undefined): boolean {
  const cacheKey = `${gitRoot ?? "."}::${tag}`;
  const cached = closureTagCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const r = spawnSync("git", ["rev-parse", "--verify", `${tag}^{commit}`], {
      cwd: gitRoot,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 2000,
    });
    const ok = r.status === 0;
    closureTagCache.set(cacheKey, ok);
    return ok;
  } catch {
    closureTagCache.set(cacheKey, false);
    return false;
  }
}

export function closureCheckL1(content: string, gitRoot: string | undefined): { decision: "accept" | "reject"; reason?: string; tag?: string } {
  const m = content.match(CLOSURE_RE);
  if (!m) return { decision: "accept" };
  const tag = m[1].trim();
  if (!tag) return { decision: "reject", reason: "closure_evidence marker has empty tag" };
  if (!gitTagExists(tag, gitRoot)) {
    return { decision: "reject", reason: `closure_evidence tag '${tag}' does not resolve via git rev-parse`, tag };
  }
  return { decision: "accept", tag };
}

// --- L2 semantic (stub) -----------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function evaluateGateL2(_event: EventEnvelope, _content: string): GateVerdict {
  // TODO(ddouns): wire to LLM judge with cached verdicts. For now: accept.
  return { decision: "accept", reasons: [] };
}

// --- Top-level orchestrator -------------------------------------------------

export function evaluateGate(
  event: EventEnvelope,
  content: string,
  ctx: GateContext
): GateVerdict {
  const cfg = resolveGateConfig();

  // Closure evidence FIRST — a missing-tag marker is the strongest reject signal.
  const closure = closureCheckL1(content, cfg.gitRoot);
  if (closure.decision === "reject") {
    return { decision: "reject", reasons: [closure.reason ?? "closure_evidence rejected"], closure_evidence: closure.tag };
  }

  // L1 dedup — uses the SAME indexed hash the storage layer keys on. A hit
  // here is a true byte-exact-after-normalization duplicate, so we promote
  // it to a hard reject. The recordEvent transaction would otherwise treat
  // it as a soft `{duplicated: true}` outcome via the SQL UNIQUE constraint;
  // the gate short-circuits before any insert work happens.
  const dedup = dedupCheckL1(ctx.db, ctx.contentDedupeHash);
  if (dedup.hit) {
    return {
      decision: "reject",
      reasons: ["dedup_collision_l1"],
      closure_evidence: closure.tag,
    };
  }

  // L2 stub.
  return evaluateGateL2(event, content);
}
