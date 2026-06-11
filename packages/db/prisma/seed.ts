import { prisma } from "../src/index.js";

async function main() {
  const org = await prisma.org.upsert({
    where: { id: "dev-org" },
    update: {},
    create: { id: "dev-org", name: "Dev Org" },
  });
  const asset = await prisma.asset.upsert({
    where: { id: "dev-asset" },
    update: {},
    create: {
      id: "dev-asset",
      orgId: org.id,
      title: "Test video",
      createdBy: "dev-user",
      status: "UPLOADED",
      sourceStorageKey: "uploads/test.mp4",
    },
  });
  const accounts = [
    { id: "dev-viewer", email: "viewer@vidforge.test", displayName: "Vera Viewer", role: "VIEWER" },
    { id: "dev-editor", email: "editor@vidforge.test", displayName: "Eddie Editor", role: "EDITOR" },
    { id: "dev-admin", email: "admin@vidforge.test", displayName: "Ada Admin", role: "ADMIN" },
    { id: "dev-owner", email: "owner@vidforge.test", displayName: "Olive Owner", role: "OWNER" },
  ] as const;

  for (const account of accounts) {
    await prisma.user.upsert({
      where: { id: account.id },
      update: { role: account.role },
      create: { ...account, orgId: org.id },
    });
  }

  console.log("seeded", org.id, asset.id, accounts.map((a) => a.email).join(", "));
}

main().finally(() => prisma.$disconnect());
