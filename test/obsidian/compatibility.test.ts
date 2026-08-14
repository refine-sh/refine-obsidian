import { describe, expect, it } from "vitest";

import { incompatibleProtocolNotice } from "../../src/obsidian/compatibility";

describe("Obsidian compatibility messages", () => {
  it.each([
    [
      "server",
      "This version of the Refine Obsidian plugin requires a newer version of the Refine app. Update Refine and try again.",
    ],
    [
      "client",
      "The installed version of the Refine app requires a newer version of the Refine Obsidian plugin. Update the plugin and try again.",
    ],
  ] as const)("directs the user to update %s", (requiredUpdate, expected) => {
    expect(incompatibleProtocolNotice(requiredUpdate)).toBe(expected);
  });
});
