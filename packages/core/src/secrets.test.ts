import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateApiKey, hashApiKey, isSecretsKeyValid, SecretUnreadableError } from "./secrets";

const BINDING = "paypal_connection:project-a:sandbox";
const useNewKey = () => {
  process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
};

describe("secrets", () => {
  beforeEach(useNewKey);

  it("round trips, with a new ciphertext each time", () => {
    const first = encryptSecret("the-secret", BINDING);
    expect(decryptSecret(first, BINDING)).toBe("the-secret");
    expect(first).not.toContain("the-secret");
    expect(encryptSecret("the-secret", BINDING)).not.toBe(first);
  });

  it("rejects a value copied to another record", () => {
    const encoded = encryptSecret("the-secret", BINDING);
    expect(() => decryptSecret(encoded, "paypal_connection:project-b:sandbox")).toThrow(SecretUnreadableError);
    expect(() => decryptSecret(encoded, "paypal_connection:project-a:live")).toThrow(SecretUnreadableError);
  });

  it("rejects a changed ciphertext or a malformed value", () => {
    const parts = encryptSecret("the-secret", BINDING).split(".");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    ciphertext[0]! ^= 1;
    parts[3] = ciphertext.toString("base64url");
    expect(() => decryptSecret(parts.join("."), BINDING)).toThrow(SecretUnreadableError);
    expect(() => decryptSecret("not-encrypted", BINDING)).toThrow(SecretUnreadableError);
  });

  it("rejects the wrong key without revealing anything", () => {
    const encoded = encryptSecret("the-secret", BINDING);
    useNewKey();
    expect(() => decryptSecret(encoded, BINDING)).toThrow("Secret can't be decrypted");
  });

  it("refuses to encrypt with a missing or short key", () => {
    delete process.env.SECRETS_ENCRYPTION_KEY;
    expect(isSecretsKeyValid()).toBe(false);
    expect(() => encryptSecret("the-secret", BINDING)).toThrow("SECRETS_ENCRYPTION_KEY");
    process.env.SECRETS_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    expect(isSecretsKeyValid()).toBe(false);
  });
});

describe("API keys", () => {
  it("makes a long random key and shows its environment", () => {
    const { key } = generateApiKey("sandbox");
    expect(key).toMatch(/^br_sandbox_[A-Za-z0-9_-]{43}$/);
    expect(generateApiKey("sandbox").key).not.toBe(key);
  });

  it("stores only a hash and the last 4 characters", () => {
    const { key, keyHash, lastFour } = generateApiKey("sandbox");
    expect(keyHash).toBe(hashApiKey(key));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keyHash).not.toContain(key);
    expect(lastFour).toBe(key.slice(-4));
  });

  it("hashes different keys differently", () => {
    expect(hashApiKey("br_sandbox_a")).not.toBe(hashApiKey("br_sandbox_b"));
  });
});
