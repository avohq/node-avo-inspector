import * as crypto from "crypto";
import { AvoEncryption } from "../AvoEncryption";
import { AvoNetworkCallsHandler } from "../AvoNetworkCallsHandler";
import { AvoInspectorEnv } from "../AvoInspectorEnv";
import { AvoGuid } from "../AvoGuid";
import { mockedReturns } from "./constants";

// Generate a test key pair for encryption tests
function generateTestKeyPair() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey("hex"),
    privateKey: ecdh.getPrivateKey(),
    ecdh,
  };
}

describe("AvoEncryption", () => {
  describe("shouldEncrypt", () => {
    const dummyHexKey = "deadbeef";

    test("dev + key => true", () => {
      expect(AvoEncryption.shouldEncrypt(AvoInspectorEnv.Dev, dummyHexKey)).toBe(true);
    });

    test("staging + key => true", () => {
      expect(AvoEncryption.shouldEncrypt(AvoInspectorEnv.Staging, dummyHexKey)).toBe(true);
    });

    test("prod + key => false", () => {
      expect(AvoEncryption.shouldEncrypt(AvoInspectorEnv.Prod, dummyHexKey)).toBe(false);
    });

    test("dev + null => false", () => {
      expect(AvoEncryption.shouldEncrypt(AvoInspectorEnv.Dev, undefined)).toBe(false);
    });

    test("dev + empty string => false", () => {
      expect(AvoEncryption.shouldEncrypt(AvoInspectorEnv.Dev, "")).toBe(false);
    });
  });

  describe("wire format", () => {
    const testKeyPair = generateTestKeyPair();

    test("base64Decode(output).length >= 99", () => {
      const encrypted = AvoEncryption.encryptValue("hello", testKeyPair.publicKey);
      expect(encrypted).not.toBeNull();
      const decoded = Buffer.from(encrypted!, "base64");
      // 1 (version) + 65 (ephemeral pubkey) + 16 (IV) + 16 (auth tag) + ciphertext >= 1
      expect(decoded.length).toBeGreaterThanOrEqual(99);
    });

    test("output[0] == 0x00 (version byte)", () => {
      const encrypted = AvoEncryption.encryptValue("hello", testKeyPair.publicKey);
      const decoded = Buffer.from(encrypted!, "base64");
      expect(decoded[0]).toBe(0x00);
    });

    test("output[1] == 0x04 (uncompressed pubkey marker)", () => {
      const encrypted = AvoEncryption.encryptValue("hello", testKeyPair.publicKey);
      const decoded = Buffer.from(encrypted!, "base64");
      expect(decoded[1]).toBe(0x04);
    });

    test("ephemeral public key is 65 bytes (uncompressed)", () => {
      const encrypted = AvoEncryption.encryptValue("test data", testKeyPair.publicKey);
      const decoded = Buffer.from(encrypted!, "base64");
      // bytes 1..65 are the ephemeral public key
      const ephemeralPubKey = decoded.subarray(1, 66);
      expect(ephemeralPubKey.length).toBe(65);
      expect(ephemeralPubKey[0]).toBe(0x04); // uncompressed marker
    });
  });

  describe("round-trip encrypt/decrypt", () => {
    test("can decrypt back to original plaintext", () => {
      const ecdh = crypto.createECDH("prime256v1");
      ecdh.generateKeys();
      const recipientPubKeyHex = ecdh.getPublicKey("hex");

      const plaintext = "Hello, encryption!";
      const encrypted = AvoEncryption.encryptValue(plaintext, recipientPubKeyHex);
      expect(encrypted).not.toBeNull();

      // Decrypt: parse wire format
      const wire = Buffer.from(encrypted!, "base64");
      const version = wire[0]; // 0x00
      expect(version).toBe(0x00);

      const ephemeralPubKey = wire.subarray(1, 66);
      const iv = wire.subarray(66, 82);
      const authTag = wire.subarray(82, 98);
      const ciphertext = wire.subarray(98);

      // Compute shared secret the same way
      const sharedSecret = ecdh.computeSecret(ephemeralPubKey);
      const aesKey = crypto.createHash("sha256").update(sharedSecret).digest();

      const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv, {
        authTagLength: 16,
      });
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(ciphertext);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      expect(decrypted.toString("utf8")).toBe(plaintext);
    });

    test("different encryptions of same value produce different ciphertext", () => {
      const ecdh = crypto.createECDH("prime256v1");
      ecdh.generateKeys();
      const pubKey = ecdh.getPublicKey("hex");

      const enc1 = AvoEncryption.encryptValue("same", pubKey);
      const enc2 = AvoEncryption.encryptValue("same", pubKey);
      // Ephemeral keys differ each time, so output differs
      expect(enc1).not.toBe(enc2);
    });
  });

  describe("encryption failure handling", () => {
    test("returns null and warns on invalid key", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const result = AvoEncryption.encryptValue("hello", "not-a-valid-hex-key");
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[Avo Inspector] Warning:")
      );
      warnSpy.mockRestore();
    });
  });

  describe("isListType", () => {
    test("detects list types", () => {
      expect(AvoEncryption.isListType("list(string)")).toBe(true);
      expect(AvoEncryption.isListType("list(int)")).toBe(true);
      expect(AvoEncryption.isListType("list(object)")).toBe(true);
    });

    test("non-list types return false", () => {
      expect(AvoEncryption.isListType("string")).toBe(false);
      expect(AvoEncryption.isListType("int")).toBe(false);
      expect(AvoEncryption.isListType("object")).toBe(false);
    });
  });
});

describe("AvoNetworkCallsHandler encryption integration", () => {
  const inspectorVersion = process.env.npm_package_version || "";

  beforeEach(() => {
    const now = new Date();
    // @ts-ignore
    jest.spyOn(global, "Date").mockImplementation(() => now);
    jest
      .spyOn(AvoGuid as any, "newGuid")
      .mockImplementation(() => mockedReturns.GUID);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("publicEncryptionKey included in base body when non-null and non-empty", () => {
    const pubKey = "deadbeef";
    const handler = new AvoNetworkCallsHandler(
      "api-key",
      AvoInspectorEnv.Dev,
      "app",
      "1.0",
      inspectorVersion,
      pubKey
    );

    const body = handler.bodyForEventSchemaCall(
      "anon-id",
      "test-event",
      [{ propertyName: "prop1", propertyType: "string" }],
      null,
      null
    );

    expect((body as any).publicEncryptionKey).toBe(pubKey);
  });

  test("publicEncryptionKey NOT included in base body when null", () => {
    const handler = new AvoNetworkCallsHandler(
      "api-key",
      AvoInspectorEnv.Dev,
      "app",
      "1.0",
      inspectorVersion,
      undefined
    );

    const body = handler.bodyForEventSchemaCall(
      "anon-id",
      "test-event",
      [{ propertyName: "prop1", propertyType: "string" }],
      null,
      null
    );

    expect((body as any).publicEncryptionKey).toBeUndefined();
  });

  test("publicEncryptionKey NOT included in base body when empty string", () => {
    const handler = new AvoNetworkCallsHandler(
      "api-key",
      AvoInspectorEnv.Dev,
      "app",
      "1.0",
      inspectorVersion,
      ""
    );

    const body = handler.bodyForEventSchemaCall(
      "anon-id",
      "test-event",
      [{ propertyName: "prop1", propertyType: "string" }],
      null,
      null
    );

    expect((body as any).publicEncryptionKey).toBeUndefined();
  });

  test("dev env with key: properties are encrypted with encryptedPropertyValue", () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const pubKey = ecdh.getPublicKey("hex");

    const handler = new AvoNetworkCallsHandler(
      "api-key",
      AvoInspectorEnv.Dev,
      "app",
      "1.0",
      inspectorVersion,
      pubKey
    );

    const body = handler.bodyForEventSchemaCall(
      "anon-id",
      "test-event",
      [{ propertyName: "username", propertyType: "string" }],
      null,
      null,
      { username: "alice" }
    );

    // Should have encryptedPropertyValue alongside propertyType
    expect(body.eventProperties.length).toBe(1);
    expect(body.eventProperties[0].propertyName).toBe("username");
    expect((body.eventProperties[0] as any).encryptedPropertyValue).toBeDefined();
    expect((body.eventProperties[0] as any).propertyType).toBe("string");
  });

  test("prod env: no encryptedPropertyValue, propertyType kept as-is", () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const pubKey = ecdh.getPublicKey("hex");

    const handler = new AvoNetworkCallsHandler(
      "api-key",
      AvoInspectorEnv.Prod,
      "app",
      "1.0",
      inspectorVersion,
      pubKey
    );

    const body = handler.bodyForEventSchemaCall(
      "anon-id",
      "test-event",
      [{ propertyName: "username", propertyType: "string" }],
      null,
      null
    );

    expect(body.eventProperties.length).toBe(1);
    expect((body.eventProperties[0] as any).propertyType).toBe("string");
    expect((body.eventProperties[0] as any).encryptedPropertyValue).toBeUndefined();
  });

  test("list-type properties are omitted entirely when encryption is active", () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const pubKey = ecdh.getPublicKey("hex");

    const handler = new AvoNetworkCallsHandler(
      "api-key",
      AvoInspectorEnv.Dev,
      "app",
      "1.0",
      inspectorVersion,
      pubKey
    );

    const body = handler.bodyForEventSchemaCall(
      "anon-id",
      "test-event",
      [
        { propertyName: "name", propertyType: "string" },
        { propertyName: "tags", propertyType: "list(string)" },
        { propertyName: "scores", propertyType: "list(int)" },
      ],
      null,
      null,
      { name: "Alice", tags: ["a", "b"], scores: [1, 2] }
    );

    // List types should be omitted
    expect(body.eventProperties.length).toBe(1);
    expect(body.eventProperties[0].propertyName).toBe("name");
  });

  test("encryption failure: property is omitted, warning logged", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const handler = new AvoNetworkCallsHandler(
      "api-key",
      AvoInspectorEnv.Dev,
      "app",
      "1.0",
      inspectorVersion,
      "invalid-key-that-will-fail"
    );

    const body = handler.bodyForEventSchemaCall(
      "anon-id",
      "test-event",
      [{ propertyName: "prop1", propertyType: "string" }],
      null,
      null,
      { prop1: "hello" }
    );

    // Property should be omitted on failure
    expect(body.eventProperties.length).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Avo Inspector] Warning:")
    );
    warnSpy.mockRestore();
  });

  test("non-string value (number) is JSON.stringify'd before encryption", () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const pubKey = ecdh.getPublicKey("hex");

    const handler = new AvoNetworkCallsHandler(
      "api-key",
      AvoInspectorEnv.Dev,
      "app",
      "1.0",
      inspectorVersion,
      pubKey
    );

    const body = handler.bodyForEventSchemaCall(
      "anon-id",
      "test-event",
      [{ propertyName: "count", propertyType: "int" }],
      null,
      null,
      { count: 42 }
    );

    expect(body.eventProperties.length).toBe(1);
    const encryptedValue = (body.eventProperties[0] as any).encryptedPropertyValue;
    expect(encryptedValue).toBeDefined();

    // Decrypt and verify the value is the JSON-stringified number "42"
    const wire = Buffer.from(encryptedValue, "base64");
    const ephemeralPubKey = wire.subarray(1, 66);
    const iv = wire.subarray(66, 82);
    const authTag = wire.subarray(82, 98);
    const ciphertext = wire.subarray(98);

    const sharedSecret = ecdh.computeSecret(ephemeralPubKey);
    const aesKey = crypto.createHash("sha256").update(sharedSecret).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv, {
      authTagLength: 16,
    });
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    expect(decrypted.toString("utf8")).toBe("42");
  });

  test("missing property in rawEventProperties encrypts 'null' instead of crashing", () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const pubKey = ecdh.getPublicKey("hex");

    const handler = new AvoNetworkCallsHandler(
      "api-key",
      AvoInspectorEnv.Dev,
      "app",
      "1.0",
      inspectorVersion,
      pubKey
    );

    // Schema says "missing_prop" exists, but rawEventProperties does NOT have it
    const body = handler.bodyForEventSchemaCall(
      "anon-id",
      "test-event",
      [{ propertyName: "missing_prop", propertyType: "string" }],
      null,
      null,
      { other_prop: "value" }
    );

    expect(body.eventProperties.length).toBe(1);
    const encryptedValue = (body.eventProperties[0] as any).encryptedPropertyValue;
    expect(encryptedValue).toBeDefined();

    // Decrypt and verify the value is "null"
    const wire = Buffer.from(encryptedValue, "base64");
    const ephemeralPubKey = wire.subarray(1, 66);
    const iv = wire.subarray(66, 82);
    const authTag = wire.subarray(82, 98);
    const ciphertext = wire.subarray(98);

    const sharedSecret = ecdh.computeSecret(ephemeralPubKey);
    const aesKey = crypto.createHash("sha256").update(sharedSecret).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv, {
      authTagLength: 16,
    });
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    expect(decrypted.toString("utf8")).toBe("null");
  });

  test("children are preserved in encrypted property output", () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const pubKey = ecdh.getPublicKey("hex");

    const handler = new AvoNetworkCallsHandler(
      "api-key",
      AvoInspectorEnv.Dev,
      "app",
      "1.0",
      inspectorVersion,
      pubKey
    );

    const children = [
      { propertyName: "street", propertyType: "string" },
      { propertyName: "zip", propertyType: "int" },
    ];

    const body = handler.bodyForEventSchemaCall(
      "anon-id",
      "test-event",
      [{ propertyName: "address", propertyType: "object", children }],
      null,
      null,
      { address: { street: "123 Main St", zip: 12345 } }
    );

    expect(body.eventProperties.length).toBe(1);
    const prop = body.eventProperties[0] as any;
    expect(prop.propertyName).toBe("address");
    expect(prop.encryptedPropertyValue).toBeDefined();
    expect(prop.children).toEqual(children);
  });

  test("cross-SDK interop: encrypted wire format structure is correct", () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const pubKey = ecdh.getPublicKey("hex");

    const handler = new AvoNetworkCallsHandler(
      "api-key",
      AvoInspectorEnv.Dev,
      "app",
      "1.0",
      inspectorVersion,
      pubKey
    );

    const body = handler.bodyForEventSchemaCall(
      "anon-id",
      "test-event",
      [{ propertyName: "email", propertyType: "string" }],
      null,
      null,
      { email: "user@example.com" }
    );

    const encryptedValue = (body.eventProperties[0] as any).encryptedPropertyValue;
    expect(encryptedValue).toBeDefined();

    const wire = Buffer.from(encryptedValue, "base64");
    // Verify wire format: [0x00][65-byte ephemeral pubkey][16-byte IV][16-byte auth tag][ciphertext]
    expect(wire.length).toBeGreaterThanOrEqual(99);
    expect(wire[0]).toBe(0x00); // version
    expect(wire[1]).toBe(0x04); // uncompressed pubkey marker

    // Verify we can decrypt it
    const ephemeralPubKey = wire.subarray(1, 66);
    const iv = wire.subarray(66, 82);
    const authTag = wire.subarray(82, 98);
    const ciphertext = wire.subarray(98);

    const sharedSecret = ecdh.computeSecret(ephemeralPubKey);
    const aesKey = crypto.createHash("sha256").update(sharedSecret).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv, {
      authTagLength: 16,
    });
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    expect(decrypted.toString("utf8")).toBe('"user@example.com"');
  });
});
