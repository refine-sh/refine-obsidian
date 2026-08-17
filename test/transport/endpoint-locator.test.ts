import { describe, expect, it, vi } from "vitest";

import {
  EndpointDescriptorError,
  EndpointProtocolVersionError,
  EndpointSecurityError,
  FileEndpointLocator,
  parseEndpointDescriptor,
  type EndpointFileSystem,
} from "../../src/transport/endpoint-locator";

const VALID_LAUNCH_TOKEN = "A".repeat(64);

describe("Refine endpoint discovery", () => {
  it.each([
    "A".repeat(63),
    "a".repeat(64),
    `${"A".repeat(63)}-`,
  ])("rejects a noncanonical launch token", (launchToken) => {
    expect(() =>
      parseEndpointDescriptor(JSON.stringify({
        version: 1,
        socketPath: "/private/tmp/refine-123/integration.sock",
        launchToken,
        serverEpoch: "epoch-123",
        protocolMajor: 1,
        protocolMinor: 0,
        pid: 1234,
      })),
    ).toThrow("64 uppercase hexadecimal characters");
  });

  it("rejects a server epoch outside the protocol identifier grammar", () => {
    expect(() =>
      parseEndpointDescriptor(JSON.stringify({
        version: 1,
        socketPath: "/private/tmp/refine-123/integration.sock",
        launchToken: VALID_LAUNCH_TOKEN,
        serverEpoch: "epoch 123",
        protocolMajor: 1,
        protocolMinor: 0,
        pid: 1234,
      })),
    ).toThrow("serverEpoch");
  });

  it("accepts a private same-user descriptor and socket", async () => {
    const fileSystem = endpointFileSystem({ descriptorMode: 0o600 });
    const locator = new FileEndpointLocator({
      descriptorPath: "/Users/test/Library/Application Support/com.runjuu.refine/Integrations/endpoint.json",
      currentUid: 501,
      fileSystem,
    });

    await expect(locator.locate()).resolves.toEqual({
      version: 1,
      socketPath: "/private/tmp/refine-123/integration.sock",
      launchToken: VALID_LAUNCH_TOKEN,
      serverEpoch: "epoch-123",
      protocolMajor: 1,
      protocolMinor: 0,
      pid: 1234,
    });
    expect(fileSystem.stat).toHaveBeenCalledWith(
      "/Users/test/Library/Application Support/com.runjuu.refine/Integrations/owner.lock",
    );
  });

  it.each([
    {
      name: "is not a regular file",
      ownerLockStat: { uid: 501, mode: 0o600, kind: "directory" as const },
    },
    {
      name: "belongs to another user",
      ownerLockStat: { uid: 502, mode: 0o600, kind: "file" as const },
    },
    {
      name: "is readable by another user",
      ownerLockStat: { uid: 501, mode: 0o644, kind: "file" as const },
    },
    {
      name: "has a special mode bit",
      ownerLockStat: { uid: 501, mode: 0o1600, kind: "file" as const },
    },
  ])("rejects discovery when owner.lock $name", async ({ ownerLockStat }) => {
    const locator = new FileEndpointLocator({
      descriptorPath: "/Users/test/endpoint.json",
      currentUid: 501,
      fileSystem: endpointFileSystem({ ownerLockStat }),
    });

    await expect(locator.locate()).rejects.toThrow(EndpointSecurityError);
    await expect(locator.locate()).rejects.toThrow(
      "ownership lock must be a same-user file with mode 600",
    );
  });

  it("rejects a descriptor readable by another user", async () => {
    const locator = new FileEndpointLocator({
      descriptorPath: "/Users/test/endpoint.json",
      currentUid: 501,
      fileSystem: endpointFileSystem({ descriptorMode: 0o644 }),
    });

    await expect(locator.locate()).rejects.toThrow(EndpointSecurityError);
  });

  it("rejects a nonprivate endpoint directory", async () => {
    const locator = new FileEndpointLocator({
      descriptorPath: "/Users/test/endpoint.json",
      currentUid: 501,
      fileSystem: endpointFileSystem({ descriptorDirectoryMode: 0o755 }),
    });

    await expect(locator.locate()).rejects.toThrow(
      "endpoint directory must be a same-user directory with mode 700",
    );
  });

  it("rejects a pid outside the signed 32-bit descriptor range", () => {
    expect(() => parseEndpointDescriptor(JSON.stringify({
      version: 1,
      socketPath: "/private/tmp/refine-123/integration.sock",
      launchToken: VALID_LAUNCH_TOKEN,
      serverEpoch: "epoch-123",
      protocolMajor: 1,
      protocolMinor: 0,
      pid: 0x80000000,
    }))).toThrow("positive 32-bit integer");
  });

  it("rejects legacy credential fields instead of silently weakening launch authentication", async () => {
    const fileSystem = endpointFileSystem({
      descriptorText: JSON.stringify({
        version: 1,
        socketPath: "/private/tmp/refine-123/integration.sock",
        credential: "legacy-secret",
        serverEpoch: "epoch-123",
        protocolMajor: 1,
        protocolMinor: 0,
        pid: 1234,
      }),
    });
    const locator = new FileEndpointLocator({
      descriptorPath: "/Users/test/endpoint.json",
      currentUid: 501,
      fileSystem,
    });

    await expect(locator.locate()).rejects.toThrow("launchToken");
  });

  it("distinguishes an incompatible protocol from malformed endpoint metadata", async () => {
    const locator = new FileEndpointLocator({
      descriptorPath: "/Users/test/endpoint.json",
      currentUid: 501,
      fileSystem: endpointFileSystem({
        descriptorText: JSON.stringify({
          version: 1,
          socketPath: "/private/tmp/refine-123/integration.sock",
          launchToken: VALID_LAUNCH_TOKEN,
          serverEpoch: "epoch-123",
          protocolMajor: 2,
          protocolMinor: 0,
          pid: 1234,
        }),
      }),
    });

    await expect(locator.locate()).rejects.toThrow(EndpointProtocolVersionError);
    await expect(locator.locate()).rejects.toMatchObject({
      receivedProtocol: { major: 2, minor: 0 },
    });
  });

  it("rejects a descriptor without the required protocol minor", async () => {
    const locator = new FileEndpointLocator({
      descriptorPath: "/Users/test/endpoint.json",
      currentUid: 501,
      fileSystem: endpointFileSystem({
        descriptorText: JSON.stringify({
          version: 1,
          socketPath: "/private/tmp/refine-123/integration.sock",
          launchToken: VALID_LAUNCH_TOKEN,
          serverEpoch: "epoch-123",
          protocolMajor: 1,
          pid: 1234,
        }),
      }),
    });

    await expect(locator.locate()).rejects.toThrow("protocolMinor");
  });

  it("rejects duplicate descriptor members through the shared JSON decoder", () => {
    expect(() => parseEndpointDescriptor(`{
      "version": 1,
      "socketPath": "/private/tmp/refine-123/integration.sock",
      "launchToken": "${VALID_LAUNCH_TOKEN}",
      "serverEpoch": "epoch-123",
      "protocolMajor": 1,
      "protocolMinor": 0,
      "pid": 1234,
      "pid": 1234
    }`)).toThrow(EndpointDescriptorError);
  });

  it("rejects exponent spelling for an integer descriptor field", () => {
    expect(() => parseEndpointDescriptor(`{
      "version": 1,
      "socketPath": "/private/tmp/refine-123/integration.sock",
      "launchToken": "${VALID_LAUNCH_TOKEN}",
      "serverEpoch": "epoch-123",
      "protocolMajor": 1e0,
      "protocolMinor": 0,
      "pid": 1234
    }`)).toThrow("Endpoint descriptor is not valid JSON");
  });

  it("ignores portable unknown descriptor members after lexical validation", () => {
    expect(parseEndpointDescriptor(`{
      "version": 1,
      "socketPath": "/private/tmp/refine-123/integration.sock",
      "launchToken": "${VALID_LAUNCH_TOKEN}",
      "serverEpoch": "epoch-123",
      "protocolMajor": 1,
      "protocolMinor": 0,
      "pid": 1234,
      "com.example.future": { "ratioBasisPoints": 1500 }
    }`)).toMatchObject({
      protocolMajor: 1,
      protocolMinor: 0,
    });
  });
});

function endpointFileSystem(
  options: {
    descriptorDirectoryMode?: number;
    descriptorMode?: number;
    descriptorText?: string;
    ownerLockStat?: {
      readonly uid: number;
      readonly mode: number;
      readonly kind: "file" | "directory" | "socket" | "other";
    };
  } = {},
): EndpointFileSystem {
  const socketPath = "/private/tmp/refine-123/integration.sock";
  const descriptorText =
    options.descriptorText ??
    JSON.stringify({
      version: 1,
      socketPath,
      launchToken: VALID_LAUNCH_TOKEN,
      serverEpoch: "epoch-123",
      protocolMajor: 1,
      protocolMinor: 0,
      pid: 1234,
    });
  return {
    readText: vi.fn(async () => descriptorText),
    stat: vi.fn(async (path) => {
      if (
        path === "/Users/test" ||
        path === "/Users/test/Library/Application Support/com.runjuu.refine/Integrations"
      ) {
        return {
          uid: 501,
          mode: options.descriptorDirectoryMode ?? 0o700,
          kind: "directory" as const,
        };
      }
      if (path.endsWith("/owner.lock")) {
        return options.ownerLockStat ?? {
          uid: 501,
          mode: 0o600,
          kind: "file" as const,
        };
      }
      if (path === socketPath) {
        return { uid: 501, mode: 0o600, kind: "socket" as const };
      }
      if (path === "/private/tmp/refine-123") {
        return { uid: 501, mode: 0o700, kind: "directory" as const };
      }
      return {
        uid: 501,
        mode: options.descriptorMode ?? 0o600,
        kind: "file" as const,
      };
    }),
  };
}
