import { prisma } from "../src/index.js";

// All password-less — sign in via POST /v1/dev/login (dev-only route,
// disabled when NODE_ENV=production). Covers every Role enum value, two
// deep on VIEWER/EDITOR since those are the roles most flows branch on,
// plus a second org so org-isolation (each org only sees its own
// assets/jobs) has something to actually test against.
const orgs = [
  {
    id: "dev-org",
    name: "Dev Org",
    accounts: [
      { id: "dev-viewer", email: "viewer@vidforge.test", displayName: "Vera Viewer", role: "VIEWER" },
      { id: "dev-viewer-2", email: "viewer2@vidforge.test", displayName: "Victor Viewer", role: "VIEWER" },
      { id: "dev-editor", email: "editor@vidforge.test", displayName: "Eddie Editor", role: "EDITOR" },
      { id: "dev-editor-2", email: "editor2@vidforge.test", displayName: "Edith Editor", role: "EDITOR" },
      { id: "dev-admin", email: "admin@vidforge.test", displayName: "Ada Admin", role: "ADMIN" },
      { id: "dev-owner", email: "owner@vidforge.test", displayName: "Olive Owner", role: "OWNER" },
    ],
  },
  {
    id: "other-org",
    name: "Other Org",
    accounts: [
      { id: "other-viewer", email: "viewer@other.test", displayName: "Val Viewer", role: "VIEWER" },
      { id: "other-owner", email: "owner@other.test", displayName: "Owen Owner", role: "OWNER" },
    ],
  },
] as const;

async function main() {
  const seeded: string[] = [];

  for (const { id: orgId, name, accounts } of orgs) {
    const org = await prisma.org.upsert({
      where: { id: orgId },
      update: {},
      create: { id: orgId, name },
    });

    for (const account of accounts) {
      await prisma.user.upsert({
        where: { id: account.id },
        update: { role: account.role },
        create: { ...account, orgId: org.id },
      });
      seeded.push(account.email);
    }
  }

  const asset = await prisma.asset.upsert({
    where: { id: "dev-asset" },
    update: {},
    create: {
      id: "dev-asset",
      orgId: "dev-org",
      title: "Test video",
      createdBy: "dev-user",
      status: "UPLOADED",
      sourceStorageKey: "uploads/test.mp4",
    },
  });

  console.log("seeded", orgs.map((o) => o.id).join(", "), asset.id);
  console.log("accounts:", seeded.join(", "));
}

main().finally(() => prisma.$disconnect());
