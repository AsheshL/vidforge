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
  const token = await new SignJWT({ org: claims.org, role: claims.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(currentSecret());
  return { token, expiresAt };
}

export async function verifyJwt(token: string): Promise<TokenClaims & { exp: number }> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, currentSecret()));
  } catch (err) {
    const previous = previousSecret();
    if (!previous) {
      throw err;
    }
    ({ payload } = await jwtVerify(token, previous));
  }
  return {
    sub: payload.sub as string,
    org: payload.org as string,
    role: payload.role as string,
    exp: payload.exp as number,
  };
}
