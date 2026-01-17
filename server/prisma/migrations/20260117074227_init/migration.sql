-- CreateTable
CREATE TABLE "analyses" (
    "id" UUID NOT NULL,
    "originalText" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analyses_pkey" PRIMARY KEY ("id")
);
