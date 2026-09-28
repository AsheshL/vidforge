-- AlterTable
ALTER TABLE "Asset" ADD COLUMN "publishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Org" ADD COLUMN "slug" TEXT,
ADD COLUMN "displayName" TEXT,
ADD COLUMN "logoStorageKey" TEXT;

-- Backfill: url-safe slug derived from name, with the org id's last 6
-- characters appended so uniqueness never depends on names not colliding.
UPDATE "Org"
SET "slug" = lower(regexp_replace(regexp_replace("name", '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'))
             || '-' || right("id", 6);

ALTER TABLE "Org" ALTER COLUMN "slug" SET NOT NULL;

-- CreateTable
CREATE TABLE "Viewer" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Viewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchProgress" (
    "viewerId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "positionSeconds" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchProgress_pkey" PRIMARY KEY ("viewerId","assetId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Org_slug_key" ON "Org"("slug");

-- CreateIndex
CREATE INDEX "Viewer_orgId_idx" ON "Viewer"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Viewer_orgId_email_key" ON "Viewer"("orgId", "email");

-- CreateIndex
CREATE INDEX "WatchProgress_viewerId_updatedAt_idx" ON "WatchProgress"("viewerId", "updatedAt");

-- AddForeignKey
ALTER TABLE "Viewer" ADD CONSTRAINT "Viewer_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchProgress" ADD CONSTRAINT "WatchProgress_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "Viewer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchProgress" ADD CONSTRAINT "WatchProgress_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
