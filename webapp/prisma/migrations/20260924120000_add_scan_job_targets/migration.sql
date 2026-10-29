-- Record the project roots a scan run was started over (multi-root partial recon).
ALTER TABLE "scan_jobs"
  ADD COLUMN "targets" TEXT[] DEFAULT ARRAY[]::TEXT[];
