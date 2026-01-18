-- AlterTable
ALTER TABLE "analyses" ADD COLUMN     "autoDeleteAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "analyses" ADD COLUMN     "anonymization" JSONB;

-- AlterTable
ALTER TABLE "scans" ADD COLUMN     "autoDeleteAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "scans" ADD COLUMN     "anonymization" JSONB;

-- CreateIndex
CREATE INDEX "analyses_autoDeleteAt_idx" ON "analyses"("autoDeleteAt");

-- CreateIndex
CREATE INDEX "scans_autoDeleteAt_idx" ON "scans"("autoDeleteAt");
