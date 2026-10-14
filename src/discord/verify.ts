import { createPublicKey, verify } from "node:crypto";

// Ed25519 public keys from Discord are raw 32-byte hex; wrap them in an SPKI header for node:crypto.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Verify Discord's X-Signature-Ed25519 / X-Signature-Timestamp headers (required for every interaction). */
export function verifyDiscordRequest(
  rawBody: string,
  signatureHex: string | null,
  timestamp: string | null,
  publicKeyHex: string | undefined,
): boolean {
  if (!signatureHex || !timestamp || !publicKeyHex) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(timestamp + rawBody), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}
