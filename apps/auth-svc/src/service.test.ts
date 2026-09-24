import { status } from "@grpc/grpc-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@vidforge/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vidforge/db")>();
  return {
    ...actual,
    prisma: {
      ...actual.prisma,
      user: { findUnique: vi.fn() },
    },
  };
});

import { prisma } from "@vidforge/db";
import { authServiceImpl } from "./service.js";

describe("signUp", () => {
  it("returns an INTERNAL grpc error instead of crashing the process when the database call fails", async () => {
    // Same failure this hit in production: migrations hadn't run yet, so
    // the very first query threw. signUp had no try/catch (unlike
    // verifyToken just above it in service.ts), so that exception went
    // out as an unhandled rejection and took the whole process down —
    // not just this one request.
    vi.mocked(prisma.user.findUnique).mockRejectedValueOnce(
      new Error("The table `public.User` does not exist in the current database."),
    );

    const callback = vi.fn();
    const call = {
      request: {
        email: "smoke-test@example.com",
        password: "smoketestpassword123",
        displayName: "Smoke Test",
        orgName: "",
      },
    } as Parameters<typeof authServiceImpl.signUp>[0];

    await expect(authServiceImpl.signUp(call, callback)).resolves.toBeUndefined();

    expect(callback).toHaveBeenCalledTimes(1);
    const [err] = callback.mock.calls[0];
    expect(err).toMatchObject({ code: status.INTERNAL });
  });
});
