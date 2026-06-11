import { status, type ServiceError } from "@grpc/grpc-js";
import { prisma, Role as DbRole } from "@vidforge/db";
import { Role, type AuthServiceServer, type User as ProtoUser } from "@vidforge/proto/auth";
import type { RequestContext } from "@vidforge/proto/common";
import { verifyContext } from "@vidforge/svc-auth";
import { randomBytes } from "node:crypto";
import { signToken, verifyJwt } from "./jwt.js";
import { hashPassword, verifyPassword } from "./password.js";
import { sendInviteEmail } from "./mailer.js";

const TEMP_PASSWORD_TTL_HOURS = Number(process.env.TEMP_PASSWORD_TTL_HOURS ?? 24);
const WEB_URL = process.env.WEB_ORIGIN ?? "http://localhost:3000";

const ROLE_RANK: Record<string, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3, OWNER: 4 };

function grpcError(code: status, message: string): ServiceError {
  return Object.assign(new Error(message), { code, details: message }) as ServiceError;
}

// VerifyToken/IssueDevToken are entry points and take no context; everything
// else requires a gateway-signed context.
function authenticate(ctx: RequestContext | undefined): RequestContext | ServiceError {
  const result = verifyContext(ctx);
  return result.ok ? result.context : grpcError(status.UNAUTHENTICATED, result.reason);
}

const ROLE_MAP: Record<DbRole, Role> = {
  VIEWER: Role.ROLE_VIEWER,
  EDITOR: Role.ROLE_EDITOR,
  ADMIN: Role.ROLE_ADMIN,
  OWNER: Role.ROLE_OWNER,
};

function toProtoUser(u: {
  id: string;
  email: string;
  displayName: string;
  orgId: string;
  role: DbRole;
  createdAt: Date;
  updatedAt: Date;
}): ProtoUser {
  return {
    userId: u.id,
    email: u.email,
    displayName: u.displayName,
    orgId: u.orgId,
    role: ROLE_MAP[u.role],
    audit: { createdAt: u.createdAt, updatedAt: u.updatedAt, createdBy: "" },
  };
}

export const authServiceImpl: AuthServiceServer = {
  verifyToken: async (call, callback) => {
    try {
      const claims = await verifyJwt(call.request.token);
      // Role and org come fresh from the DB, not the token, so role
      // changes and deleted users take effect within a token's lifetime.
      const user = await prisma.user.findUnique({ where: { id: claims.sub } });
      // A user on a temporary password has no business holding a session:
      // any token from before the invite (or a leak) is rejected here.
      if (!user || user.mustChangePassword) {
        return callback(null, { valid: false, context: undefined, expiresAt: undefined });
      }
      callback(null, {
        valid: true,
        context: {
          userId: user.id,
          orgId: user.orgId,
          roles: [user.role],
          traceId: "",
          // The gateway signs the context after attaching its trace id.
          issuedAtMs: 0,
          signature: "",
        },
        expiresAt: new Date(claims.exp * 1000),
      });
    } catch {
      callback(null, { valid: false, context: undefined, expiresAt: undefined });
    }
  },

  signUp: async (call, callback) => {
    const { email, password, displayName } = call.request;
    if (!email.includes("@") || password.length < 8 || !displayName.trim()) {
      return callback(
        grpcError(status.INVALID_ARGUMENT, "valid email, display name and a password of 8+ characters required"),
      );
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return callback(grpcError(status.ALREADY_EXISTS, "an account with this email already exists"));
    }
    const passwordHash = await hashPassword(password);
    // Each signup gets its own org: org scoping then isolates their assets
    // and jobs, and as OWNER they can manage everything inside it.
    const user = await prisma.$transaction(async (tx) => {
      const org = await tx.org.create({
        data: { name: call.request.orgName.trim() || `${displayName.trim()}'s org` },
      });
      return tx.user.create({
        data: { email, displayName: displayName.trim(), passwordHash, orgId: org.id, role: "OWNER" },
      });
    });
    await prisma.auditEvent.create({
      data: {
        orgId: user.orgId,
        actorUserId: user.id,
        action: "user.sign_up",
        resourceType: "user",
        resourceId: user.id,
      },
    });
    const { token, expiresAt } = await signToken({ sub: user.id, org: user.orgId, role: user.role });
    callback(null, { token, user: toProtoUser(user), expiresAt, passwordChangeRequired: false });
  },

  login: async (call, callback) => {
    const user = await prisma.user.findUnique({ where: { email: call.request.email } });
    // Same error for unknown email and wrong password: no account probing.
    if (!user?.passwordHash || !(await verifyPassword(call.request.password, user.passwordHash))) {
      return callback(grpcError(status.UNAUTHENTICATED, "invalid email or password"));
    }
    if (user.mustChangePassword) {
      if (user.passwordExpiresAt && user.passwordExpiresAt < new Date()) {
        return callback(
          grpcError(status.UNAUTHENTICATED, "temporary password expired — ask your admin to invite you again"),
        );
      }
      // Correct temp password, but no session until they set their own.
      return callback(null, {
        token: "",
        user: toProtoUser(user),
        expiresAt: undefined,
        passwordChangeRequired: true,
      });
    }
    const { token, expiresAt } = await signToken({ sub: user.id, org: user.orgId, role: user.role });
    callback(null, { token, user: toProtoUser(user), expiresAt, passwordChangeRequired: false });
  },

  inviteUser: async (call, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    const inviterRank = Math.max(...ctx.roles.map((r) => ROLE_RANK[r] ?? 0), 0);
    if (inviterRank < ROLE_RANK.ADMIN) {
      return callback(grpcError(status.PERMISSION_DENIED, "only admins can invite members"));
    }
    const { email, displayName } = call.request;
    if (!email.includes("@") || !displayName.trim()) {
      return callback(grpcError(status.INVALID_ARGUMENT, "valid email and display name required"));
    }
    const roleName = (Role[call.request.role]?.replace("ROLE_", "") ?? "") as DbRole;
    if (!(roleName in ROLE_RANK)) {
      return callback(grpcError(status.INVALID_ARGUMENT, "invalid role"));
    }
    if (ROLE_RANK[roleName] > inviterRank) {
      return callback(grpcError(status.PERMISSION_DENIED, "cannot grant a role above your own"));
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && !(existing.orgId === ctx.orgId && existing.mustChangePassword)) {
      return callback(grpcError(status.ALREADY_EXISTS, "an account with this email already exists"));
    }

    const tempPassword = randomBytes(9).toString("base64url"); // 12 chars
    const passwordHash = await hashPassword(tempPassword);
    const passwordExpiresAt = new Date(Date.now() + TEMP_PASSWORD_TTL_HOURS * 3_600_000);
    const data = {
      displayName: displayName.trim(),
      passwordHash,
      mustChangePassword: true,
      passwordExpiresAt,
      role: roleName,
    };
    // Re-inviting a pending member rotates their temporary password.
    const user = existing
      ? await prisma.user.update({ where: { id: existing.id }, data })
      : await prisma.user.create({ data: { ...data, email, orgId: ctx.orgId } });

    const [org, inviter] = await Promise.all([
      prisma.org.findUnique({ where: { id: ctx.orgId } }),
      prisma.user.findUnique({ where: { id: ctx.userId } }),
    ]);
    try {
      await sendInviteEmail({
        to: email,
        displayName: user.displayName,
        orgName: org?.name ?? "your team",
        inviterName: inviter?.displayName ?? "An admin",
        tempPassword,
        expiresAt: passwordExpiresAt,
        loginUrl: `${WEB_URL}/signup`,
      });
    } catch (err) {
      // Without the email the invite is unusable; surface the failure.
      return callback(grpcError(status.INTERNAL, `failed to send invite email: ${(err as Error).message}`));
    }
    await prisma.auditEvent.create({
      data: {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        action: existing ? "user.reinvite" : "user.invite",
        resourceType: "user",
        resourceId: user.id,
        detailJson: { role: roleName },
      },
    });
    callback(null, toProtoUser(user));
  },

  changePassword: async (call, callback) => {
    const { email, currentPassword, newPassword } = call.request;
    if (newPassword.length < 8) {
      return callback(grpcError(status.INVALID_ARGUMENT, "new password must be at least 8 characters"));
    }
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user?.passwordHash || !(await verifyPassword(currentPassword, user.passwordHash))) {
      return callback(grpcError(status.UNAUTHENTICATED, "invalid email or password"));
    }
    if (user.mustChangePassword && user.passwordExpiresAt && user.passwordExpiresAt < new Date()) {
      return callback(
        grpcError(status.UNAUTHENTICATED, "temporary password expired — ask your admin to invite you again"),
      );
    }
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(newPassword),
        mustChangePassword: false,
        passwordExpiresAt: null,
      },
    });
    await prisma.auditEvent.create({
      data: {
        orgId: user.orgId,
        actorUserId: user.id,
        action: "user.change_password",
        resourceType: "user",
        resourceId: user.id,
      },
    });
    const { token, expiresAt } = await signToken({ sub: updated.id, org: updated.orgId, role: updated.role });
    callback(null, { token, user: toProtoUser(updated), expiresAt, passwordChangeRequired: false });
  },

  issueDevToken: async (call, callback) => {
    if (process.env.NODE_ENV === "production") {
      return callback(grpcError(status.PERMISSION_DENIED, "dev tokens are disabled in production"));
    }
    const user = await prisma.user.findUnique({ where: { email: call.request.email } });
    if (!user) {
      return callback(grpcError(status.NOT_FOUND, `no user with email ${call.request.email}`));
    }
    const { token, expiresAt } = await signToken({ sub: user.id, org: user.orgId, role: user.role });
    callback(null, { token, user: toProtoUser(user), expiresAt });
  },

  getUser: async (call, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    const user = await prisma.user.findUnique({ where: { id: call.request.userId } });
    if (!user || user.orgId !== ctx.orgId) {
      return callback(grpcError(status.NOT_FOUND, "user not found"));
    }
    callback(null, toProtoUser(user));
  },

  listOrgMembers: async (call, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    const users = await prisma.user.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { createdAt: "asc" },
      take: Math.min(call.request.page?.pageSize || 50, 100),
    });
    callback(null, {
      users: users.map(toProtoUser),
      pageInfo: { nextPageToken: "", totalCount: users.length },
    });
  },

  assignRole: async (call, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    if (!ctx.roles.some((r) => r === "ADMIN" || r === "OWNER")) {
      return callback(grpcError(status.PERMISSION_DENIED, "only admins can assign roles"));
    }
    const target = await prisma.user.findUnique({ where: { id: call.request.userId } });
    if (!target || target.orgId !== ctx.orgId) {
      return callback(grpcError(status.NOT_FOUND, "user not found"));
    }
    const roleName = Role[call.request.role]?.replace("ROLE_", "") as DbRole | undefined;
    if (!roleName || !(roleName in ROLE_MAP)) {
      return callback(grpcError(status.INVALID_ARGUMENT, "invalid role"));
    }
    // An actor can neither grant a role above their own nor change someone
    // who outranks them (an ADMIN cannot demote the OWNER).
    const actorRank = Math.max(...ctx.roles.map((r) => ROLE_RANK[r] ?? 0), 0);
    if (ROLE_RANK[roleName] > actorRank || ROLE_RANK[target.role] > actorRank) {
      return callback(grpcError(status.PERMISSION_DENIED, "cannot assign a role above your own"));
    }
    if (target.id === ctx.userId && ROLE_RANK[roleName] < actorRank) {
      return callback(grpcError(status.PERMISSION_DENIED, "you cannot demote yourself"));
    }
    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { role: roleName },
    });
    await prisma.auditEvent.create({
      data: {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        action: "user.assign_role",
        resourceType: "user",
        resourceId: target.id,
        detailJson: { role: roleName },
      },
    });
    callback(null, toProtoUser(updated));
  },

  recordAuditEvent: async (call, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    const event = await prisma.auditEvent.create({
      data: {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        action: call.request.action,
        resourceType: call.request.resourceType,
        resourceId: call.request.resourceId,
        detailJson: call.request.detailJson ? JSON.parse(call.request.detailJson) : undefined,
      },
    });
    callback(null, { eventId: event.id });
  },

  listAuditEvents: async (call, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    if (!ctx.roles.some((r) => r === "ADMIN" || r === "OWNER")) {
      return callback(grpcError(status.PERMISSION_DENIED, "only admins can read the audit log"));
    }
    const events = await prisma.auditEvent.findMany({
      where: {
        orgId: ctx.orgId,
        ...(call.request.resourceType ? { resourceType: call.request.resourceType } : {}),
        ...(call.request.actorUserId ? { actorUserId: call.request.actorUserId } : {}),
      },
      orderBy: { occurredAt: "desc" },
      take: Math.min(call.request.page?.pageSize || 50, 100),
    });
    callback(null, {
      events: events.map((e) => ({
        eventId: e.id,
        orgId: e.orgId,
        actorUserId: e.actorUserId,
        action: e.action,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        detailJson: e.detailJson ? JSON.stringify(e.detailJson) : "",
        occurredAt: e.occurredAt,
      })),
      pageInfo: { nextPageToken: "", totalCount: events.length },
    });
  },

  createApiKey: (_call, callback) =>
    callback(grpcError(status.UNIMPLEMENTED, "CreateApiKey not implemented yet")),
  revokeApiKey: (_call, callback) =>
    callback(grpcError(status.UNIMPLEMENTED, "RevokeApiKey not implemented yet")),
};
