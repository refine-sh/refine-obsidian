import { describe, expect, it, vi } from "vitest";

import {
  EndpointProtocolVersionError,
  EndpointSecurityError,
  FileEndpointLocator,
  type EndpointFileSystem,
} from "../../src/transport/endpoint-locator";

describe("Refine endpoint discovery", () => {
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
      launchToken: "per-launch-secret",
      serverEpoch: "epoch-123",
      protocolMajor: 2,
      pid: 1234,
    });
  });

  it("rejects a descriptor readable by another user", async () => {
    const locator = new FileEndpointLocator({
      descriptorPath: "/Users/test/endpoint.json",
      currentUid: 501,
      fileSystem: endpointFileSystem({ descriptorMode: 0o644 }),
    });

    await expect(locator.locate()).rejects.toThrow(EndpointSecurityError);
  });

  it("rejects legacy credential fields instead of silently weakening launch authentication", async () => {
    const fileSystem = endpointFileSystem({
      descriptorText: JSON.stringify({
        version: 1,
        socketPath: "/private/tmp/refine-123/integration.sock",
        credential: "legacy-secret",
        serverEpoch: "epoch-123",
        protocolMajor: 2,
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
          launchToken: "per-launch-secret",
          serverEpoch: "epoch-123",
          protocolMajor: 1,
          pid: 1234,
        }),
      }),
    });

    await expect(locator.locate()).rejects.toThrow(EndpointProtocolVersionError);
  });
});

function endpointFileSystem(
  options: {
    descriptorMode?: number;
    descriptorText?: string;
  } = {},
): EndpointFileSystem {
  const socketPath = "/private/tmp/refine-123/integration.sock";
  const descriptorText =
    options.descriptorText ??
    JSON.stringify({
      version: 1,
      socketPath,
      launchToken: "per-launch-secret",
      serverEpoch: "epoch-123",
      protocolMajor: 2,
      pid: 1234,
    });
  return {
    readText: vi.fn(async () => descriptorText),
    stat: vi.fn(async (path) => {
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
