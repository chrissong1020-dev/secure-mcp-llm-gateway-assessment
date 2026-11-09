import { fileURLToPath } from "node:url";
import { createTestToken, type UserRole } from "./shared/auth.js";

async function main(): Promise<void> {
  const role = process.argv[2] as UserRole | undefined;
  const secret = process.env.AUTH_SECRET;
  if (role !== "admin" && role !== "viewer") {
    throw new Error("Usage: npm run token -- admin|viewer");
  }
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SECRET must contain at least 32 characters");
  }
  process.stdout.write(`${await createTestToken(role, secret)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
