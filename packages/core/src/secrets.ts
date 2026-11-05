import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const API_KEY_BYTES = 32;

/** Deliberately carries no detail: anything here could end up in a log. */
export class SecretUnreadableError extends Error {
  constructor() {
    super("Secret can't be decrypted");
    this.name = "SecretUnreadableError";
  }
}

function loadKey(): Buffer | null {
  const key = Buffer.from(process.env.SECRETS_ENCRYPTION_KEY ?? "", "base64");
  return key.length === KEY_BYTES ? key : null;
}

export function isSecretsKeyValid(): boolean {
  return loadKey() !== null;
}

/**
 * `binding` names the record the secret belongs to. It's authenticated, not stored, so a
 * value copied onto another record fails to decrypt.
 */
export function encryptSecret(plaintext: string, binding: string): string {
  const key = loadKey();
  if (!key) throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv).setAAD(Buffer.from(binding));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function decryptSecret(encoded: string, binding: string): string {
  const key = loadKey();
  const [version, iv, tag, ciphertext, ...rest] = encoded.split(".");
  if (!key || version !== VERSION || !iv || !tag || !ciphertext || rest.length > 0) {
    throw new SecretUnreadableError();
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64url"))
      .setAAD(Buffer.from(binding))
      .setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretUnreadableError();
  }
}

// SHA-256 is enough: slow hashes protect guessable passwords, and an API key is 256 random bits.
export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** Only the hash and the last 4 characters get stored. `key` is shown to the operator once. */
export function generateApiKey(environment: "sandbox" | "live") {
  const key = `br_${environment}_${randomBytes(API_KEY_BYTES).toString("base64url")}`;
  return { key, keyHash: hashApiKey(key), lastFour: key.slice(-4) };
}
