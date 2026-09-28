import { afterEach, describe, expect, it, vi } from "vitest";
import { portalFetch } from "./api";

function stubBrowserGlobals() {
  const localStorageStub = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
  const windowStub = { location: { href: "" } };
  vi.stubGlobal("localStorage", localStorageStub);
  vi.stubGlobal("window", windowStub);
  return { localStorageStub, windowStub };
}

describe("portalFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears this org's session and redirects to its login page on a 401", async () => {
    const { localStorageStub, windowStub } = stubBrowserGlobals();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    await portalFetch("acme-inc", "/v1/portal/library");

    expect(localStorageStub.removeItem).toHaveBeenCalledWith("vidforge.viewer.token.acme-inc");
    expect(localStorageStub.removeItem).toHaveBeenCalledWith("vidforge.viewer.user.acme-inc");
    expect(windowStub.location.href).toBe("/acme-inc/login");
  });

  it("does not touch the session or redirect on a successful response", async () => {
    const { localStorageStub, windowStub } = stubBrowserGlobals();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })));

    await portalFetch("acme-inc", "/v1/portal/library");

    expect(localStorageStub.removeItem).not.toHaveBeenCalled();
    expect(windowStub.location.href).toBe("");
  });
});
