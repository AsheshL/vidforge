import { expect, test } from "@playwright/test";
import { devLogin } from "../../lib/api.js";
import { ACCOUNTS, GATEWAY_URL, unique, type AccountName } from "../../lib/env.js";

const ROLE_NUM = { VIEWER: 1, EDITOR: 2, ADMIN: 3, OWNER: 4 } as const;

test.describe("authentication", () => {
  for (const who of ["viewer", "editor", "admin", "owner"] as AccountName[]) {
    test(`dev login as ${who} returns a token with the seeded role`, async ({ request }) => {
      const { token, user } = await devLogin(request, who);
      expect(token).toBeTruthy();
      expect(user.email).toBe(ACCOUNTS[who].email);
      expect(user.role).toBe(ROLE_NUM[ACCOUNTS[who].role]);
    });
  }

  test("rejects missing and invalid bearer tokens", async ({ request }) => {
    expect((await request.get(`${GATEWAY_URL}/v1/assets`)).status()).toBe(401);
    const bad = await request.get(`${GATEWAY_URL}/v1/assets`, { headers: { authorization: "Bearer not-a-token" } });
    expect(bad.status()).toBe(401);
  });

  test("unknown dev account is 404", async ({ request }) => {
    const res = await request.post(`${GATEWAY_URL}/v1/dev/login`, { data: { email: "nobody@vidforge.test" } });
    expect(res.status()).toBe(404);
  });

  test("signup → password login → change password → old password rejected", async ({ request }) => {
    const email = `${unique("e2e-signup")}@example.test`;
    const password = "First-pass-123";
    const signup = await request.post(`${GATEWAY_URL}/v1/auth/signup`, {
      data: { email, password, displayName: "E2E Signup", orgName: unique("e2e-org") },
    });
    expect(signup.status(), await signup.text()).toBe(201);
    const { token, user } = await signup.json();
    expect(token).toBeTruthy();
    expect(user.role).toBe(ROLE_NUM.OWNER); // founders own their fresh org

    // A fresh org is isolated: nothing from the seeded orgs shows up.
    const assets = await request.get(`${GATEWAY_URL}/v1/assets`, { headers: { authorization: `Bearer ${token}` } });
    expect((await assets.json()).assets).toEqual([]);

    const login = await request.post(`${GATEWAY_URL}/v1/auth/login`, { data: { email, password } });
    expect(login.status()).toBe(200);
    const wrong = await request.post(`${GATEWAY_URL}/v1/auth/login`, { data: { email, password: "Wrong-pass-123" } });
    expect(wrong.status()).toBe(401);

    const change = await request.post(`${GATEWAY_URL}/v1/auth/change-password`, {
      data: { email, currentPassword: password, newPassword: "Second-pass-456" },
    });
    expect(change.status(), await change.text()).toBe(200);
    expect((await request.post(`${GATEWAY_URL}/v1/auth/login`, { data: { email, password } })).status()).toBe(401);
    const relogin = await request.post(`${GATEWAY_URL}/v1/auth/login`, {
      data: { email, password: "Second-pass-456" },
    });
    expect(relogin.status()).toBe(200);
  });

  test("signup validates input", async ({ request }) => {
    const res = await request.post(`${GATEWAY_URL}/v1/auth/signup`, {
      data: { email: "not-an-email", password: "short", displayName: "" },
    });
    expect(res.status()).toBe(400);
  });
});
