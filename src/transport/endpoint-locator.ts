import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { isIntegerMember, parseJSONObject } from "./strict-json";
import { PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./wire";

export interface EndpointDescriptor {
  readonly version: 1;
  readonly socketPath: string;
  readonly launchToken: string;
  readonly serverEpoch: string;
  readonly protocolMajor: typeof PROTOCOL_MAJOR;
  readonly protocolMinor: typeof PROTOCOL_MINOR;
  readonly pid: number;
}

export interface EndpointProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

export type EndpointEntryKind = "file" | "directory" | "socket" | "other";

export interface EndpointFileStat {
  readonly uid: number;
  readonly mode: number;
  readonly kind: EndpointEntryKind;
}

export interface EndpointFileSystem {
  readText(path: string): Promise<string>;
  stat(path: string): Promise<EndpointFileStat>;
}

export interface EndpointLocator {
  locate(): Promise<EndpointDescriptor>;
}

export class EndpointDescriptorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EndpointDescriptorError";
  }
}

export class EndpointSecurityError extends EndpointDescriptorError {
  constructor(message: string) {
    super(message);
    this.name = "EndpointSecurityError";
  }
}

export class EndpointProtocolVersionError extends EndpointDescriptorError {
  constructor(readonly receivedProtocol: EndpointProtocolVersion) {
    super(
      `Refine protocol ${receivedProtocol.major}.${receivedProtocol.minor} is incompatible with protocol ${PROTOCOL_MAJOR}.${PROTOCOL_MINOR}`,
    );
    this.name = "EndpointProtocolVersionError";
  }
}

export interface FileEndpointLocatorOptions {
  readonly descriptorPath?: string;
  readonly currentUid?: number;
  readonly fileSystem?: EndpointFileSystem;
}

const defaultFileSystem: EndpointFileSystem = {
  readText: async (path) => new TextDecoder("utf-8", { fatal: true }).decode(
    await readFile(path),
  ),
  stat: async (path) => {
    const result = await lstat(path);
    return {
      uid: result.uid,
      mode: result.mode & 0o7777,
      kind: result.isFile()
        ? "file"
        : result.isDirectory()
          ? "directory"
          : result.isSocket()
            ? "socket"
            : "other",
    };
  },
};

export function defaultEndpointDescriptorPath(homeDirectory = homedir()): string {
  return join(
    homeDirectory,
    "Library",
    "Application Support",
    "com.runjuu.refine",
    "Integrations",
    "endpoint.json",
  );
}

export class FileEndpointLocator implements EndpointLocator {
  private readonly currentUid: number | undefined;
  private readonly descriptorPath: string;
  private readonly fileSystem: EndpointFileSystem;

  constructor(options: FileEndpointLocatorOptions = {}) {
    const processUid = process.getuid?.();
    this.currentUid = options.currentUid ?? processUid;
    this.descriptorPath = options.descriptorPath ?? defaultEndpointDescriptorPath();
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
  }

  async locate(): Promise<EndpointDescriptor> {
    const descriptorDirectory = dirname(this.descriptorPath);
    const descriptorDirectoryStat = await this.fileSystem.stat(descriptorDirectory);
    this.requirePrivateEntry(
      descriptorDirectoryStat,
      "directory",
      0o700,
      "endpoint directory",
    );
    const ownershipLockPath = join(descriptorDirectory, "owner.lock");
    const ownershipLockStat = await this.fileSystem.stat(ownershipLockPath);
    this.requirePrivateEntry(
      ownershipLockStat,
      "file",
      0o600,
      "ownership lock",
    );
    const descriptorStat = await this.fileSystem.stat(this.descriptorPath);
    this.requirePrivateEntry(descriptorStat, "file", 0o600, "endpoint descriptor");
    const descriptor = parseEndpointDescriptor(await this.fileSystem.readText(this.descriptorPath));

    const socketDirectory = dirname(descriptor.socketPath);
    const directoryStat = await this.fileSystem.stat(socketDirectory);
    this.requirePrivateEntry(directoryStat, "directory", 0o700, "socket directory");
    const socketStat = await this.fileSystem.stat(descriptor.socketPath);
    this.requirePrivateEntry(socketStat, "socket", 0o600, "integration socket");
    return descriptor;
  }

  private requirePrivateEntry(
    actual: EndpointFileStat,
    kind: EndpointEntryKind,
    mode: number,
    label: string,
  ): void {
    if (
      actual.kind !== kind ||
      (this.currentUid !== undefined && actual.uid !== this.currentUid) ||
      (actual.mode & 0o7777) !== mode
    ) {
      throw new EndpointSecurityError(
        `${label} must be a same-user ${kind} with mode ${mode.toString(8)}`,
      );
    }
  }
}

export function parseEndpointDescriptor(text: string): EndpointDescriptor {
  let value: Record<string, unknown>;
  try {
    value = parseJSONObject(text);
  } catch (error) {
    throw new EndpointDescriptorError("Endpoint descriptor is not valid JSON", { cause: error });
  }
  if (!isIntegerMember(value, "version", 1, 1)) {
    throw new EndpointDescriptorError("Endpoint descriptor version must be 1");
  }
  if (typeof value.socketPath !== "string" || !isAbsolute(value.socketPath)) {
    throw new EndpointDescriptorError("Endpoint socketPath must be an absolute path");
  }
  if (typeof value.launchToken !== "string" || !/^[0-9A-F]{64}$/.test(value.launchToken)) {
    throw new EndpointDescriptorError(
      "Endpoint launchToken must contain exactly 64 uppercase hexadecimal characters",
    );
  }
  if (typeof value.serverEpoch !== "string" || !/^[\x21-\x7e]{1,128}$/.test(value.serverEpoch)) {
    throw new EndpointDescriptorError(
      "Endpoint serverEpoch must be a 1-to-128-byte visible ASCII identifier",
    );
  }
  const protocolMajor = requireProtocolComponent(value, "protocolMajor");
  const protocolMinor = requireProtocolComponent(value, "protocolMinor");
  if (
    protocolMajor !== PROTOCOL_MAJOR ||
    protocolMinor !== PROTOCOL_MINOR
  ) {
    throw new EndpointProtocolVersionError({
      major: protocolMajor,
      minor: protocolMinor,
    });
  }
  if (!isIntegerMember(value, "pid", 1, 0x7fffffff)) {
    throw new EndpointDescriptorError("Endpoint pid must be a positive 32-bit integer");
  }

  return {
    version: 1,
    socketPath: value.socketPath,
    launchToken: value.launchToken,
    serverEpoch: value.serverEpoch,
    protocolMajor: PROTOCOL_MAJOR,
    protocolMinor: PROTOCOL_MINOR,
    pid: value.pid as number,
  };
}

function requireProtocolComponent(
  object: Record<string, unknown>,
  field: string,
): number {
  if (!isIntegerMember(object, field, 0, 0xffff)) {
    throw new EndpointDescriptorError(
      `Endpoint ${field} must be an unsigned 16-bit integer`,
    );
  }
  return object[field] as number;
}
