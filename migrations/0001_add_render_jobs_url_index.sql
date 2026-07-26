-- Kostnadsfix: engine-cronen (*/5) och ingest-pathen kör upprepade
--   NOT EXISTS (SELECT 1 FROM render_jobs WHERE url = ? AND type = ? AND status IN (...))
-- Utan index på url föll de tillbaka på idx_render_jobs_claimable(status, ...)
-- och scannade alla pending/leased-rader per anrop. I kombination med
-- SCAN över products gav det ~15 miljoner lästa rader per cron-körning,
-- 288 körningar/dygn => ~79 miljarder rader lästa i juli 2026 (kvot: 25
-- miljarder), vilket stod för hela överdebiteringen på Cloudflare-fakturan.
-- Med detta täckande index: ~44 500 rader per körning (337x mindre).
CREATE INDEX IF NOT EXISTS idx_render_jobs_url_type_status
  ON render_jobs(url, type, status);
