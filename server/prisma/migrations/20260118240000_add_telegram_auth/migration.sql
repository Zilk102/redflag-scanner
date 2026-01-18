-- AlterTable
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "telegramId" TEXT;
ALTER TABLE "users" ADD COLUMN     "telegramUsername" TEXT;
ALTER TABLE "users" ADD COLUMN     "telegramFirstName" TEXT;
ALTER TABLE "users" ADD COLUMN     "telegramLastName" TEXT;
ALTER TABLE "users" ADD COLUMN     "telegramPhotoUrl" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_telegramId_key" ON "users"("telegramId");
