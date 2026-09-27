import { expect, test } from "@playwright/test";
import { Gateway } from "../../lib/api.js";
import { GATEWAY_URL, unique } from "../../lib/env.js";
import { makeTestVideo } from "../../lib/media.js";

test.describe("uploads (tus) and asset registration", () => {
  test("editor uploads a video and registers it as an asset", async ({ request }) => {
    const editor = await Gateway.as(request, "editor");
    const title = unique("e2e-upload");
    const file = makeTestVideo(`${title}.mp4`, { seconds: 3 });
    const { assetId, uploadKey } = await editor.upload(file, title);
    expect(uploadKey).toMatch(/^tus-[0-9a-f-]{36}$/);

    const list = await (await editor.get("/v1/assets?pageSize=100")).json();
    const asset = list.assets.find((a: { assetId: string }) => a.assetId === assetId);
    expect(asset).toMatchObject({ title, status: "UPLOADED" });
    expect(Number(asset.sourceBytes)).toBeGreaterThan(0);

    // The upload key is a one-time claim ticket.
    const again = await editor.post("/v1/assets/register", { uploadKey, title: "dup" });
    expect(again.status()).toBe(409);
  });

  test("registering an unknown or malformed upload key fails", async ({ request }) => {
    const editor = await Gateway.as(request, "editor");
    const missing = await editor.post("/v1/assets/register", {
      uploadKey: "tus-00000000-0000-0000-0000-000000000000",
      title: "ghost",
    });
    expect(missing.status()).toBe(404);
    expect((await editor.post("/v1/assets/register", { uploadKey: "../etc/passwd", title: "x" })).status()).toBe(400);
  });

  test("viewers cannot upload or register", async ({ request }) => {
    const viewer = await Gateway.as(request, "viewer");
    const create = await request.post(`${GATEWAY_URL}/v1/uploads`, {
      headers: { authorization: `Bearer ${viewer.token}`, "tus-resumable": "1.0.0", "upload-length": "10" },
    });
    expect(create.status()).toBe(403);
    const reg = await viewer.post("/v1/assets/register", {
      uploadKey: "tus-00000000-0000-0000-0000-000000000000",
      title: "x",
    });
    expect(reg.status()).toBe(403);
  });
});
