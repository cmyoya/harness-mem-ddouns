# harness-mem-ddouns

> A fork of [harness-mem](https://github.com/Chachamaru127/harness-mem) with **DDouns Wave-1 substrate invariants** baked in.

## What this fork adds

This fork wires the DDouns Wave-1 substrate (closure invariant, L1 dedup gate, chained-attestation audit log, and audit-emit on privacy strip) into harness-mem's `recordEvent` path. Everything is **opt-in** via `DDOUNS_GATE_ENABLED`; with the gate disabled the fork is byte-identical in behavior to upstream at the pinned baseline `5f2f9ec`. The DDouns subset is **Apache-2.0**; the combined work stays under upstream **BUSL-1.1** until the 2029-03-08 Change Date.

## Quick start

```bash
git clone https://github.com/cmyoya/harness-mem-ddouns
cd harness-mem-ddouns
bun install
(cd memory-server && bun install)

# Gate disabled (default): byte-identical to upstream
bun test

# Gate enabled in warn mode: log violations, don't block
DDOUNS_GATE_ENABLED=1 DDOUNS_GATE_MODE=warn bun test

# Gate enabled in block mode: reject violating writes
DDOUNS_GATE_ENABLED=1 DDOUNS_GATE_MODE=block bun test
```

The gate sits at the synchronous transform window inside `recordEvent`, so no separate daemon, sidecar, or migration step is required for the substrate behavior — `bun install` and an env var flip are the entire opt-in.

## What you get

- **L1 dedup gate** — synchronous indexed-SQL probe against `mem_observations.content_dedupe_hash`. Reuses the same hash space the storage layer keys on (the W2.5 fix), so the gate's verdict and the `UNIQUE`-constraint dedup path can never disagree. A hit short-circuits to `dedup_collision_l1` before any insert work happens.
- **Closure-evidence validation** — content scanned for `<closure_evidence tag="..."/>` markers; if present, the referenced tag MUST resolve via `git rev-parse <tag>^{commit}`. Tag-not-found is a hard reject. Cached per `(gitRoot, tag)` to avoid repeated `spawnSync` cost.
- **Chained-attestation audit log** — `mem_audit_log.prev_hash = sha256(prev.prev_hash || action || target_type || target_id || details_json || created_at)[:32]`. Tampering with any historical row breaks the chain at the first subsequent `verifyAuditChain()`. Genesis row uses `""` as predecessor; legacy rows with `prev_hash IS NULL` form a soft boundary, not a chain break.
- **Audit-emit on privacy strip** — `<private>...</private>` blocks are still removed from stored content as upstream does, but each strip now also writes a `privacy_strip` audit row carrying the strip count and `sha256[:16]` digest of each removed block, so post-hoc audit can see *that* a strip happened without seeing the secret.
- **Three env-controlled enforcement modes** — `block` (default, fail-close on violation, mirrors upstream's `getManagedRequired` pattern), `warn` (log via `ddouns_gate_warn` audit row, allow the write), `audit` (alias of `warn` for ops use).

## Architecture

```text
recordEvent(event)
  -> normalize project, tags
  -> stripPrivateBlocksAudited     [emits audit row when content was changed]
  -> redactContent
  -> buildContentDedupeHash         [canonical hash; storage layer indexes it]
  -> evaluateGate (DDouns)          [closure check, then dedup probe via SAME hash]
       -> reject + block mode  -> makeErrorResponse, no insert
       -> reject + warn mode   -> appendAuditChain('ddouns_gate_warn'), continue
       -> accept               -> continue
  -> SQL transaction (events / observations / vectors / nuggets / ...)
```

The gate is intentionally a thin wrapper around `evaluateGate(event, content, ctx)`; it owns no state beyond a small in-process closure-tag cache. All persistence remains upstream's responsibility.

## License

DDouns substrate code (`memory-server/src/core/audit-chain.ts`, `memory-server/src/core/ddouns-gate.ts`, the `mem_audit_log.prev_hash` migration, plus additive changes to `schema.ts`, `privacy-tags.ts`, `event-recorder.ts`) is licensed under the **Apache License 2.0** by cmyoya/DDouns. The combined work remains under the upstream **BUSL-1.1** until the **2029-03-08 Change Date**, after which both subsets convert to Apache-2.0 per BUSL §License Grant.

Per BUSL-1.1 Additional Use Grant: this fork is a substrate gate for write-time verification, NOT a "Memory Service" — it does not host or provide memory-as-a-service. The gate runs in-process inside the existing harness-mem daemon and has no remote/multi-tenant surface.

See [`NOTICE`](./NOTICE) for the full license walkthrough.

## Specs

- [DDouns Wave-1 Invariants v1](https://github.com/cmyoya/DDouns/blob/spec-v1/docs/spec/wave-1-invariants-v1.md) — closure invariant, dedup gate, attestation chain.
- [Companion Contract v1](https://github.com/cmyoya/DDouns/blob/spec-v1/docs/spec/companion-contract-v1.md) — substrate handshake (`ddouns-substrate.v1`).

## Upstream relationship

The fork pins the upstream baseline at `5f2f9ec` (DDouns Wave-1 patch sits at HEAD `6639a44`). This fork does **not** auto-track `Chachamaru127/harness-mem` `main`. To sync:

1. Fetch upstream and pick a tagged release.
2. Rebase the single DDouns substrate commit onto the new baseline.
3. Re-run `bun test` with `DDOUNS_GATE_ENABLED=0` to confirm the byte-identical-to-upstream invariant still holds, then with `DDOUNS_GATE_ENABLED=1` for substrate-mode regression coverage.

The substrate patch is intentionally additive (`+496 / -4` lines across 7 files) so rebases stay mechanical.

## Related

- [DDouns](https://github.com/cmyoya/DDouns) — the substrate-of-record manage-axis project that defines the invariants this fork enforces.
- [harness-mem upstream](https://github.com/Chachamaru127/harness-mem) — the retrieve-axis memory daemon this forks.

---

DDouns Wave-1 substrate © 2026 cmyoya/DDouns (Apache-2.0)
harness-mem © 2026 Claude Code Harness (BUSL-1.1)
