import { expect, test } from "@playwright/test";
import { Gateway, RENDITIONS } from "../../lib/api.js";
import { GATEWAY_URL, unique } from "../../lib/env.js";

test.describe("API keys", () => {
  test("full lifecycle: create → authenticate with role limits → list → revoke", async ({ request }) => {
    const admin = await Gateway.as(request, "admin");
    const name = unique("e2e-key");
    const created = await admin.post("/v1/org/api-keys", { name, role: "EDITOR" });
    expect(created.status(), await created.text()).toBe(201);
    const { keyId, secret } = await created.json();
    expect(secret).toMatch(/^vfk_/);

    const key = new Gateway(request, secret);
    expect((await key.get("/v1/assets")).status()).toBe(200);
    // EDITOR key: may submit work (reaches validation → 400), not administer.
    expect((await key.post("/v1/assets/x/transcode", {})).status()).toBe(400);
    expect((await key.get("/v1/org/members")).status()).toBe(403);
    // Key-authenticated work is attributed to the org like any other.
    const { assetId, storageKey } = await key.seed();
    const job = await key.transcode(assetId, { sourceStorageKey: storageKey, renditions: [RENDITIONS.r240] });
    expect((await admin.get(`/v1/jobs/${job.jobId}`)).status()).toBe(200);

    const list = await (await admin.get("/v1/org/api-keys")).json();
    const listed = list.apiKeys.find((k: { keyId: string }) => k.keyId === keyId);
    expect(listed).toMatchObject({ name, role: 2 });
    expect(JSON.stringify(list)).not.toContain(secret); // secret is never readable again

    expect((await admin.post(`/v1/org/api-keys/${keyId}/revoke`)).status()).toBe(200);
    expect((await key.get("/v1/assets")).status()).toBe(401);
  });

  test("an expired key doesn't authenticate", async ({ request }) => {
    const admin = await Gateway.as(request, "admin");
    const created = await admin.post("/v1/org/api-keys", {
      name: unique("e2e-expired"),
      role: "VIEWER",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    // Either refused up front or issued already-expired; never usable.
    if (created.status() === 201) {
      const { secret } = await created.json();
      const res = await request.get(`${GATEWAY_URL}/v1/assets`, { headers: { authorization: `Bearer ${secret}` } });
      expect(res.status()).toBe(401);
    } else {
      expect(created.status()).toBe(400);
    }
  });

  test("a key can't outrank its creator, and non-admins can't mint keys", async ({ request }) => {
    const admin = await Gateway.as(request, "admin");
    expect((await admin.post("/v1/org/api-keys", { name: "too-high", role: "OWNER" })).status()).toBe(403);
    const viewer = await Gateway.as(request, "viewer");
    expect((await viewer.post("/v1/org/api-keys", { name: "x", role: "VIEWER" })).status()).toBe(403);
    expect((await viewer.get("/v1/org/api-keys")).status()).toBe(403);
  });
});
