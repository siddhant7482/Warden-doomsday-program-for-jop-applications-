import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/* ============================================================
   Secrets at rest.

   A Gmail refresh token does not expire and grants read access to the
   whole mailbox. It lives in Postgres, and Postgres gets pg_dump'd
   nightly and shipped to Backblaze — so a plaintext token would be a
   standing key to the inbox sitting in someone else's storage.

   AES-256-GCM: authenticated, so a tampered ciphertext fails loudly
   instead of decrypting to garbage.
   ============================================================ */

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. Generate one with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"\n" +
        "and put it in .env.local. Losing it means re-authorising Gmail.",
    );
  }
  // Accept a base64 32-byte key, or hash anything else up to length so a
  // hand-typed passphrase still produces a valid key rather than failing.
  const buf = Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : createHash("sha256").update(raw).digest();
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version
 *  prefix means the scheme can change later without guessing. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(".");
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Stored secret is not in the expected format — re-authorise the account.");
  }
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function hasEncryptionKey(): boolean {
  return Boolean(process.env.TOKEN_ENCRYPTION_KEY);
}
