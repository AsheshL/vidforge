import { SignJWT, jwtVerify } from "jose";

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? "change-me");
const TOKEN_TTL_HOURS = 8;

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
    .sign(secret);
  return { token, expiresAt };
}

export async function verifyJwt(token: string): Promise<TokenClaims & { exp: number }> {
  const { payload } = await jwtVerify(token, secret);
  return {
    sub: payload.sub as string,
    org: payload.org as string,
    role: payload.role as string,
    exp: payload.exp as number,
  };
}
