import { describe, it, expect } from "vitest";
import { encrypt, decrypt, isEncrypted } from "../../src/security/encryption";

describe("Encryption helpers", () => {
  const key = "test-encryption-key-12345";

  it("encrypts and decrypts a string", async () => {
    const plaintext = "my-secret-oauth-token";
    const ciphertext = await encrypt(plaintext, key);
    expect(ciphertext).not.toBe(plaintext);
    const decrypted = await decrypt(ciphertext, key);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertexts for same plaintext (random IV)", async () => {
    const plaintext = "same-token";
    const c1 = await encrypt(plaintext, key);
    const c2 = await encrypt(plaintext, key);
    expect(c1).not.toBe(c2);
    // Both should decrypt to the same value
    expect(await decrypt(c1, key)).toBe(plaintext);
    expect(await decrypt(c2, key)).toBe(plaintext);
  });

  it("fails to decrypt with wrong key", async () => {
    const ciphertext = await encrypt("secret", key);
    await expect(decrypt(ciphertext, "wrong-key")).rejects.toThrow();
  });

  it("handles empty strings", async () => {
    const ciphertext = await encrypt("", key);
    const decrypted = await decrypt(ciphertext, key);
    expect(decrypted).toBe("");
  });

  it("handles long strings", async () => {
    const longToken = "a".repeat(10000);
    const ciphertext = await encrypt(longToken, key);
    const decrypted = await decrypt(ciphertext, key);
    expect(decrypted).toBe(longToken);
  });

  it("handles unicode content", async () => {
    const unicode = "秘密のトークン 🔑";
    const ciphertext = await encrypt(unicode, key);
    const decrypted = await decrypt(ciphertext, key);
    expect(decrypted).toBe(unicode);
  });

  it("isEncrypted detects base64", async () => {
    const ciphertext = await encrypt("test", key);
    expect(await isEncrypted(ciphertext)).toBe(true);
    expect(await isEncrypted("not-base64!!!")).toBe(false);
  });
});
