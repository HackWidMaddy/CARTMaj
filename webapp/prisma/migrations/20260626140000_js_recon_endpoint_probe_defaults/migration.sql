-- Endpoint probing is now opt-in (default off) and gets its own parallelism dial.
ALTER TABLE "projects" ALTER COLUMN "js_recon_validate_endpoints" SET DEFAULT false;
ALTER TABLE "projects" ADD COLUMN "js_recon_endpoint_concurrency" INTEGER NOT NULL DEFAULT 10;
