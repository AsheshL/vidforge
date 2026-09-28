import { SignJWT, jwtVerify } from "jose";

const TOKEN_TTL_HOURS = 8;

// JWT_SECRET_PREVIOUS is optional and only ever used to verify (never to
// sign). During a secret rotation, the old value is moved there so session
// tokens issued before the rollout (up to TOKEN_TTL_HOURS old) keep
// verifying against instances that have already picked up the new current
// secret. Read lazily (not cached at module load) so tests can flip
// process.env between cases; in production these are set once at process
// start anyway.
function currentSecret(): Uint8Array {
  return new TextEncoder().encode(process.env.JWT_SECRET ?? "change-me");
}

function previousSecret(): Uint8Array | undefined {
  const secret = process.env.JWT_SECRET_PREVIOUS;
  return secret ? new TextEncoder().encode(secret) : undefined;
}

export interface TokenClaims {
  sub: string; // user id
  org: string;
  role: string;
}

export async function signToken(claims: TokenClaims): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 3600_000);
  const token = await new SignJWT({ org: claims.org, role: claims.role, kind: "staff" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(currentSecret());
  return { token, expiresAt };
}

export async function verifyJwt(token: string): Promise<TokenClaims & { exp: number; kind: "staff" | "viewer" }> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, currentSecret()));
  } catch (err) {
    const previous = previousSecret();
    if (!previous) throw err;
    ({ payload } = await jwtVerify(token, previous));
  }
  return {
    sub: payload.sub as string,
    org: payload.org as string,
    role: payload.role as string,
    exp: payload.exp as number,
    kind: (payload.kind as "staff" | "viewer" | undefined) ?? "staff",
  };
}

// Consumer sessions shouldn't force a re-login every 8h the way staff
// sessions do — nobody wants to sign back in mid-movie.
const VIEWER_TOKEN_TTL_HOURS = 24 * 30;
const VIEWER_ACTIVATION_TTL_HOURS = Number(process.env.VIEWER_ACTIVATION_TTL_HOURS ?? 24 * 7);

export interface ViewerTokenClaims {
  sub: string; // viewer id
  org: string; // org id
}

export async function signViewerToken(claims: ViewerTokenClaims): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + VIEWER_TOKEN_TTL_HOURS * 3600_000);
  const token = await new SignJWT({ org: claims.org, kind: "viewer" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(currentSecret());
  return { token, expiresAt };
}

export interface ViewerActivationClaims {
  sub: string; // viewer id
}

export async function signViewerActivationToken(
  claims: ViewerActivationClaims,
): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + VIEWER_ACTIVATION_TTL_HOURS * 3600_000);
  const token = await new SignJWT({ kind: "viewer_activate" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(currentSecret());
  return { token, expiresAt };
}

// Single-purpose: a session token (kind "viewer") must never activate an
// account, and an activation token must never be usable as a session.
export async function verifyViewerActivationToken(
  token: string,
): Promise<ViewerActivationClaims & { exp: number }> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, currentSecret()));
  } catch (err) {
    const previous = previousSecret();
    if (!previous) throw err;
    ({ payload } = await jwtVerify(token, previous));
  }
  if (payload.kind !== "viewer_activate") {
    throw new Error("not an activation token");
  }
  return { sub: payload.sub as string, exp: payload.exp as number };
}
