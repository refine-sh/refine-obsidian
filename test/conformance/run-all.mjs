#!/usr/bin/env node

import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scenarios = [
  "base-handshake",
  "golden-writing-session",
  "typed-rejections",
  "fatal-fault",
  "reconnect-resumed",
  "reconnect-lost-state",
  "sequence-exhaustion",
  "invalid-server-inputs",
];

const configuredRoot = process.env.REFINE_PROTOCOL_ROOT;
if (configuredRoot === undefined || configuredRoot.length === 0) {
  fail(
    "REFINE_PROTOCOL_ROOT must name a refine-protocol checkout; " +
      "for example: REFINE_PROTOCOL_ROOT=../refine-protocol npm run test:conformance",
  );
}

const protocolRoot = resolve(configuredRoot);
const runner = resolve(protocolRoot, "runner", "conformance.py");
const client = fileURLToPath(new URL("./run-client.sh", import.meta.url));
try {
  accessSync(runner, constants.R_OK);
} catch {
  fail(`No readable conformance runner at ${runner}`);
}

for (const scenario of scenarios) {
  process.stdout.write(`conformance: ${scenario}\n`);
  const result = spawnSync(
    "python3",
    [
      runner,
      "--root",
      protocolRoot,
      "socket",
      "--scenario",
      scenario,
      "--client",
      client,
    ],
    { stdio: "inherit" },
  );
  if (result.error !== undefined) {
    fail(`Could not run ${scenario}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  process.stdout.write("\n");
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
