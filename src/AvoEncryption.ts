import * as crypto from "crypto";

export class AvoEncryption {
  /**
   * Determines whether encryption should be applied.
   *
   * Truth table:
   *   dev + key    => true
   *   staging + key => true
   *   prod + key   => false
   *   dev + null   => false
   *   dev + ""     => false
   */
  static shouldEncrypt(
    env: string,
    publicEncryptionKey: string | undefined | null
  ): boolean {
    if (!publicEncryptionKey || publicEncryptionKey.length === 0) {
      return false;
    }
    if (env === "prod") {
      return false;
    }
    return true;
  }

  /**
   * Returns true if the propertyType represents a list type (e.g. "list(string)").
   */
  static isListType(propertyType: string): boolean {
    return propertyType.startsWith("list(");
  }

  /**
   * Encrypts a string value using ECIES with prime256v1.
   *
   * Wire format: [0x00][65-byte ephemeral pubkey][16-byte IV][16-byte auth tag][ciphertext]
   * Output is base64-encoded.
   *
   * Returns null on failure, logging a warning.
   */
  static encryptValue(
    value: string,
    recipientPubKeyHex: string
  ): string | null {
    try {
      const recipientPubKey = Buffer.from(recipientPubKeyHex, "hex");

      // Generate ephemeral key pair
      const ecdh = crypto.createECDH("prime256v1");
      ecdh.generateKeys();
      const ephemeralPubKey = ecdh.getPublicKey(); // 65 bytes, uncompressed

      // Compute shared secret (raw 32-byte X-coordinate)
      const sharedSecret = ecdh.computeSecret(recipientPubKey);

      // Derive AES key via SHA-256
      const aesKey = crypto.createHash("sha256").update(sharedSecret).digest();

      // Generate random 16-byte IV
      const iv = crypto.randomBytes(16);

      // Encrypt with AES-256-GCM
      const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv, {
        authTagLength: 16,
      });
      const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag(); // 16 bytes

      // Assemble wire format: [version][ephemeralPubKey][IV][authTag][ciphertext]
      const wire = Buffer.concat([
        Buffer.from([0x00]), // version byte
        ephemeralPubKey, // 65 bytes
        iv, // 16 bytes
        authTag, // 16 bytes
        encrypted, // variable length
      ]);

      return wire.toString("base64");
    } catch (e) {
      console.warn(
        `[Avo Inspector] Warning: encryption failed for value, omitting property. ${e}`
      );
      return null;
    }
  }
}
