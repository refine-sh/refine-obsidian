import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

// Obsidian's community-plugin review lints the shipped stylesheet: it rejects
// !important and warns about CSS features its minimum supported app version
// only partially supports.
const PARTIALLY_SUPPORTED_PROPERTIES = [
  "text-decoration-line",
  "text-decoration-style",
  "text-decoration-color",
  "text-decoration-thickness",
  "text-underline-offset",
  "clip-path",
  "mask",
  "column-gap",
];

describe("Refine stylesheet", () => {
  it("passes the Obsidian review rules for the shipped stylesheet", async () => {
    const styles = await declarations();

    expect(styles.filter((line) => line.includes("!important"))).toEqual([]);
    for (const property of PARTIALLY_SUPPORTED_PROPERTIES) {
      expect(styles.filter((line) => line.startsWith(`${property}:`))).toEqual([]);
    }
  });
});

async function declarations(): Promise<readonly string[]> {
  const stylesheet = await readFile(
    new URL("../../styles.css", import.meta.url),
    "utf8",
  );

  return stylesheet
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trim());
}
