import { createHash, randomBytes } from "node:crypto";

export function newToken() {
  return randomBytes(32).toString("base64url");
}

// Tokens are 256 random bits, so a plain SHA-256 is enough to keep stolen rows useless.
export function hashToken(token: string) {
  return createHash("sha256").update(token).digest();
}
