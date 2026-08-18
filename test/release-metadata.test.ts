import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { RefineTransport } from "../src/transport/refine-transport";

interface PluginManifest {
  readonly version: string;
  readonly minAppVersion: string;
}

interface PackageMetadata {
  readonly version: string;
}

type ObsidianVersionHistory = Readonly<Record<string, string>>;

describe("plugin release metadata", () => {
  it("declares one release version across the manifest, package, and version history", async () => {
    const manifest = await loadJson<PluginManifest>("../manifest.json");
    const packageMetadata = await loadJson<PackageMetadata>("../package.json");
    const versions = await loadJson<ObsidianVersionHistory>("../versions.json");

    expect(packageMetadata.version).toBe(manifest.version);
    expect(Object.keys(versions).at(-1)).toBe(manifest.version);
    expect(versions[manifest.version]).toBe(manifest.minAppVersion);
  });

  it("carries the manifest version as the handshake client version", async () => {
    const manifest = await loadJson<PluginManifest>("../manifest.json");

    expect(() =>
      new RefineTransport({
        client: {
          id: "refine-obsidian",
          version: manifest.version,
          host: "obsidian",
        },
      })).not.toThrow();
  });
});

async function loadJson<Value>(path: string): Promise<Value> {
  return JSON.parse(
    await readFile(new URL(path, import.meta.url), "utf8"),
  ) as Value;
}
