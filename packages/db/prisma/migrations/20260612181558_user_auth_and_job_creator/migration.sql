-- AlterTable
ALTER TABLE "TranscodeJob" ADD COLUMN     "createdByUserId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "passwordExpiresAt" TIMESTAMP(3),
ADD COLUMN     "passwordHash" TEXT;

