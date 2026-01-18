-- AlterTable
ALTER TABLE "analyses" ADD COLUMN     "consentGiven" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "analyses" ADD COLUMN     "consentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "scans" ADD COLUMN     "consentGiven" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "scans" ADD COLUMN     "consentAt" TIMESTAMP(3);

