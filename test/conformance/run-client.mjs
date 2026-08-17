#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const bundleDirectory = await mkdtemp(join(tmpdir(), "refine-obsidian-conformance-"));

try {
  const bundlePath = join(bundleDirectory, "client.mjs");
  execFileSync(
    fileURLToPath(new URL("../../node_modules/.bin/esbuild", import.meta.url)),
    [
      fileURLToPath(new URL("./client.ts", import.meta.url)),
      "--bundle",
      "--format=esm",
      "--log-level=silent",
      "--platform=node",
      `--outfile=${bundlePath}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const module = await import(pathToFileURL(bundlePath).href);
  await module.runClient(process.argv.slice(2));
  await new Promise((resolve) => process.stdout.write("", resolve));
} catch (error) {
  await new Promise((resolve) => process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
    resolve,
  ));
  process.exitCode = 1;
} finally {
  await rm(bundleDirectory, { recursive: true, force: true });
}

process.exit(process.exitCode ?? 0);
