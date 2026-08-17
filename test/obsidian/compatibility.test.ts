import { describe, expect, it } from "vitest";

import { incompatibleProtocolNotice } from "../../src/obsidian/compatibility";

describe("Obsidian compatibility messages", () => {
  it("reports both exact protocol versions without guessing an update direction", () => {
    expect(incompatibleProtocolNotice(
      { major: 1, minor: 0 },
      { major: 2, minor: 0 },
    )).toBe(
      "This Refine Obsidian plugin requires Integration Protocol 1.0, but the Refine app reports Integration Protocol 2.0. Install compatible Refine and plugin versions, then try again.",
    );
  });
});
