import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export interface EndpointDescriptor {
  readonly version: 1;
  readonly socketPath: string;
  readonly launchToken: string;
  readonly serverEpoch: string;
  readonly protocolMajor: 1;
  readonly pid: number;
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

export interface FileEndpointLocatorOptions {
  readonly descriptorPath?: string;
  readonly currentUid?: number;
  readonly fileSystem?: EndpointFileSystem;
}

const defaultFileSystem: EndpointFileSystem = {
  readText: (path) => readFile(path, "utf8"),
  stat: async (path) => {
    const result = await lstat(path);
    return {
      uid: result.uid,
      mode: result.mode & 0o777,
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
  private readonly currentUid: number;
  private readonly descriptorPath: string;
  private readonly fileSystem: EndpointFileSystem;

  constructor(options: FileEndpointLocatorOptions = {}) {
    const processUid = process.getuid?.();
    this.currentUid = options.currentUid ?? processUid ?? -1;
    this.descriptorPath = options.descriptorPath ?? defaultEndpointDescriptorPath();
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
  }

  async locate(): Promise<EndpointDescriptor> {
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
    if (actual.kind !== kind || actual.uid !== this.currentUid || (actual.mode & 0o777) !== mode) {
      throw new EndpointSecurityError(
        `${label} must be a same-user ${kind} with mode ${mode.toString(8)}`,
      );
    }
  }
}

export function parseEndpointDescriptor(text: string): EndpointDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new EndpointDescriptorError("Endpoint descriptor is not valid JSON", { cause: error });
  }
  if (!isRecord(value)) {
    throw new EndpointDescriptorError("Endpoint descriptor must be a JSON object");
  }
  if (value.version !== 1) {
    throw new EndpointDescriptorError("Endpoint descriptor version must be 1");
  }
  if (typeof value.socketPath !== "string" || !isAbsolute(value.socketPath)) {
    throw new EndpointDescriptorError("Endpoint socketPath must be an absolute path");
  }
  if (typeof value.launchToken !== "string" || value.launchToken.length === 0) {
    throw new EndpointDescriptorError("Endpoint launchToken must be a nonempty string");
  }
  if (typeof value.serverEpoch !== "string" || value.serverEpoch.length === 0) {
    throw new EndpointDescriptorError("Endpoint serverEpoch must be a nonempty string");
  }
  if (value.protocolMajor !== 1) {
    throw new EndpointDescriptorError("Endpoint protocolMajor must be 1");
  }
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) {
    throw new EndpointDescriptorError("Endpoint pid must be a positive integer");
  }

  return {
    version: 1,
    socketPath: value.socketPath,
    launchToken: value.launchToken,
    serverEpoch: value.serverEpoch,
    protocolMajor: 1,
    pid: value.pid as number,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
