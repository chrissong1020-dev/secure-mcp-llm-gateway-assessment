import { jwtVerify, SignJWT } from "jose";

export type UserRole = "admin" | "viewer";

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function roleFromAuthorization(
  authorization: string | undefined,
  secret: string,
): Promise<UserRole | null> {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      algorithms: ["HS256"],
      issuer: "assessment-gateway",
      audience: "mcp-gateway",
    });
    return payload.role === "admin" || payload.role === "viewer"
      ? payload.role
      : null;
  } catch {
    return null;
  }
}

export function createTestToken(role: UserRole, secret: string): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("assessment-gateway")
    .setAudience("mcp-gateway")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secretKey(secret));
}
