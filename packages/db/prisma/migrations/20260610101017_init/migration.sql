-- CreateEnum
CREATE TYPE "Role" AS ENUM ('VIEWER', 'EDITOR', 'ADMIN', 'OWNER');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('UPLOADING', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Org" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "orgId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "orgId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "AssetStatus" NOT NULL DEFAULT 'UPLOADING',
    "sourceStorageKey" TEXT,
    "sourceBytes" BIGINT,
    "durationSeconds" DOUBLE PRECISION,
    "sourceWidth" INTEGER,
    "sourceHeight" INTEGER,
    "tags" TEXT[],
    "playbackUrl" TEXT,
    "thumbnailUrl" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscodeJob" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "state" "JobState" NOT NULL DEFAULT 'QUEUED',
    "profileJson" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "progressPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "idempotencyKey" TEXT,
    "manifestJson" JSONB,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "TranscodeJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionAsset" (
    "collectionId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionAsset_pkey" PRIMARY KEY ("collectionId","assetId")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "signingSecret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "detailJson" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_orgId_idx" ON "User"("orgId");

-- CreateIndex
CREATE INDEX "ApiKey_orgId_idx" ON "ApiKey"("orgId");

-- CreateIndex
CREATE INDEX "Asset_orgId_status_idx" ON "Asset"("orgId", "status");

-- CreateIndex
CREATE INDEX "Asset_orgId_createdAt_idx" ON "Asset"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TranscodeJob_idempotencyKey_key" ON "TranscodeJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TranscodeJob_orgId_state_idx" ON "TranscodeJob"("orgId", "state");

-- CreateIndex
CREATE INDEX "TranscodeJob_assetId_idx" ON "TranscodeJob"("assetId");

-- CreateIndex
CREATE INDEX "Collection_orgId_idx" ON "Collection"("orgId");

-- CreateIndex
CREATE INDEX "Webhook_orgId_idx" ON "Webhook"("orgId");

-- CreateIndex
CREATE INDEX "AuditEvent_orgId_occurredAt_idx" ON "AuditEvent"("orgId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_orgId_resourceType_idx" ON "AuditEvent"("orgId", "resourceType");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscodeJob" ADD CONSTRAINT "TranscodeJob_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionAsset" ADD CONSTRAINT "CollectionAsset_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionAsset" ADD CONSTRAINT "CollectionAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
