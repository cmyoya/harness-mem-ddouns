-- DDouns d2 — mem_audit_log prev_hash column + optional backfill.
-- Apache-2.0 (DDouns subset; carrying fork remains BUSL-1.1 until 2029-03-08).
--
-- Idempotent: safe to re-run. Apply with:
--   sqlite3 memory.db < memory-server/src/db/migrations/0001-mem-audit-log-prev-hash.sql
--
-- harness-mem itself runs the equivalent ALTER inside `initSchema(db)` on
-- startup (see memory-server/src/db/schema.ts). This file is for operators
-- who want to apply the change out-of-band, e.g. to a fleet of long-lived
-- DBs before rolling out the new server binary.

BEGIN;

-- 1. Add the column. SQLite will raise if it already exists; the bash wrapper
--    `merge-plugin-scoped-dbs.sh` style is to ignore that case.
ALTER TABLE mem_audit_log ADD COLUMN prev_hash TEXT;

-- 2. Index for cheap chain-head lookups.
CREATE INDEX IF NOT EXISTS idx_mem_audit_log_prev_hash
  ON mem_audit_log(prev_hash);

-- 3. (OPTIONAL) Backfill historical rows with a chained hash so verifyAuditChain
--    can include them. Skip this section if you only want chain coverage from
--    the migration point forward.
--
--    SQLite does not have a built-in sha256 — backfill therefore has to be
--    driven from application code (see audit-chain.ts -> backfillAuditChain
--    helper, not auto-invoked). The block below stamps a sentinel so that the
--    application-level backfill can detect "needs work" rows.

-- UPDATE mem_audit_log
--   SET prev_hash = '__pending_backfill__'
--   WHERE prev_hash IS NULL;

-- 4. Sanity check the column exists (will error and abort the txn if not).
SELECT prev_hash FROM mem_audit_log LIMIT 1;

COMMIT;

-- 5. To verify chain integrity from the application layer after rolling out
--    the new server:
--      bun -e 'import { verifyAuditChain } from "./memory-server/src/core/audit-chain.js"; \
--              import { Database } from "bun:sqlite"; \
--              const db = new Database("memory.db"); \
--              console.log(verifyAuditChain(db));'

-- end of 0001-mem-audit-log-prev-hash.sql
