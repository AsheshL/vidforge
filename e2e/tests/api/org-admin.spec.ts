import { expect, test } from "@playwright/test";
import { Gateway } from "../../lib/api.js";
import { GATEWAY_URL, unique } from "../../lib/env.js";
import { tempPasswordFrom, waitForMail } from "../../lib/mailpit.js";

test.describe("org administration", () => {
  test("members and audit log are admin-only", async ({ request }) => {
    const viewer = await Gateway.as(request, "viewer");
    const editor = await Gateway.as(request, "editor");
    const admin = await Gateway.as(request, "admin");
    for (const g of [viewer, editor]) {
      expect((await g.get("/v1/org/members")).status()).toBe(403);
      expect((await g.get("/v1/org/audit")).status()).toBe(403);
    }
    const members = await (await admin.get("/v1/org/members")).json();
    const emails = members.users.map((u: { email: string }) => u.email);
    expect(emails).toEqual(expect.arrayContaining(["viewer@vidforge.test", "owner@vidforge.test"]));
    expect(emails).not.toContain("owner@other.test"); // org-scoped
    expect((await admin.get("/v1/org/audit")).status()).toBe(200);
  });

  test("admin changes a member's role (audited), but can't grant OWNER", async ({ request }) => {
    const admin = await Gateway.as(request, "admin");
    const target = await Gateway.as(request, "viewer2");
    const userId = target.session.user.userId;
    try {
      const promote = await admin.post(`/v1/org/members/${userId}/role`, { role: "EDITOR" });
      expect(promote.status(), await promote.text()).toBe(200);
      // A fresh login carries the new role.
      expect((await Gateway.as(request, "viewer2")).session.user.role).toBe(2);

      const audit = await (await admin.get("/v1/org/audit")).json();
      expect(audit.events.some((e: { resourceId: string; action: string }) => e.resourceId.includes(userId))).toBe(true);

      const tooHigh = await admin.post(`/v1/org/members/${userId}/role`, { role: "OWNER" });
      expect(tooHigh.status()).toBe(403);
    } finally {
      await admin.post(`/v1/org/members/${userId}/role`, { role: "VIEWER" });
    }
  });

  test("invite → email with temporary password → forced change on first login", async ({ request }) => {
    const admin = await Gateway.as(request, "admin");
    const email = `${unique("e2e-invitee")}@example.test`;
    const invite = await admin.post("/v1/org/invites", { email, displayName: "E2E Invitee", role: "EDITOR" });
    expect(invite.status(), await invite.text()).toBe(201);

    const mail = await waitForMail(request, email);
    expect(mail.subject).toContain("invited");
    const temp = tempPasswordFrom(mail.text);

    // The temporary password authenticates but can't be used as-is.
    const first = await request.post(`${GATEWAY_URL}/v1/auth/login`, { data: { email, password: temp } });
    expect(first.status()).toBe(403);
    expect((await first.json()).code).toBe("PASSWORD_CHANGE_REQUIRED");

    const change = await request.post(`${GATEWAY_URL}/v1/auth/change-password`, {
      data: { email, currentPassword: temp, newPassword: "Invitee-pass-123" },
    });
    expect(change.status(), await change.text()).toBe(200);
    const login = await request.post(`${GATEWAY_URL}/v1/auth/login`, {
      data: { email, password: "Invitee-pass-123" },
    });
    expect(login.status()).toBe(200);
    const { user } = await login.json();
    expect(user).toMatchObject({ email, orgId: admin.session.user.orgId, role: 2 });
  });

  test("re-inviting a pending member rotates their temporary password", async ({ request }) => {
    const admin = await Gateway.as(request, "admin");
    const email = `${unique("e2e-reinvite")}@example.test`;
    const invite = () => admin.post("/v1/org/invites", { email, displayName: "Re Invitee", role: "VIEWER" });
    expect((await invite()).status()).toBe(201);
    const first = tempPasswordFrom((await waitForMail(request, email)).text);
    expect((await invite()).status()).toBe(201);
    let second = first;
    await expect
      .poll(async () => (second = tempPasswordFrom((await waitForMail(request, email)).text)))
      .not.toBe(first);

    const login = (password: string) => request.post(`${GATEWAY_URL}/v1/auth/login`, { data: { email, password } });
    expect((await login(first)).status()).toBe(401);
    expect((await login(second)).status()).toBe(403); // valid, but must be changed
  });

  test("bulk invite reports per-row results without aborting the batch", async ({ request }) => {
    const admin = await Gateway.as(request, "admin");
    const fresh = `${unique("e2e-bulk")}@example.test`;
    const res = await admin.post("/v1/org/invites/bulk", {
      invites: [
        { email: fresh, displayName: "Bulk One", role: "VIEWER" },
        { email: "viewer@vidforge.test", displayName: "Already Here", role: "VIEWER" },
      ],
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ invited: 1, failed: 1 });
    expect(body.results.find((r: { email: string }) => r.email === fresh).ok).toBe(true);
    await waitForMail(request, fresh);
  });

  test("non-admins can't invite", async ({ request }) => {
    const editor = await Gateway.as(request, "editor");
    const res = await editor.post("/v1/org/invites", {
      email: `${unique("nope")}@example.test`,
      displayName: "Nope",
      role: "VIEWER",
    });
    expect(res.status()).toBe(403);
  });
});
