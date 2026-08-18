import { describe, expect, it } from "vitest";

import { EngineFaultError } from "../../src/integration/refine-integration";
import {
  incompatibleProtocolNotice,
  integrationFailureNotice,
  isIncompatibleEngineError,
} from "../../src/obsidian/compatibility";
import { IncompatibleProtocolError } from "../../src/transport/refine-transport";

describe("Obsidian compatibility messages", () => {
  it("reports both exact protocol versions without guessing an update direction", () => {
    expect(incompatibleProtocolNotice(
      { major: 1, minor: 0 },
      { major: 2, minor: 0 },
    )).toBe(
      "This Refine Obsidian plugin requires Integration Protocol 1.0, but the Refine app reports Integration Protocol 2.0. Install compatible Refine and plugin versions, then try again.",
    );
  });

  it("names a Refine update when Refine cannot read what the plugin sends", () => {
    expect(
      integrationFailureNotice(new EngineFaultError("malformedMessage")),
    ).toBe(
      "The Refine app did not understand a message from this Refine Obsidian plugin. Update Refine for Mac to a version that supports this plugin, then try again.",
    );
  });

  it("keeps reporting both protocol versions for a rejected handshake", () => {
    expect(
      integrationFailureNotice(new IncompatibleProtocolError({ major: 2, minor: 0 })),
    ).toBe(incompatibleProtocolNotice({ major: 1, minor: 0 }, { major: 2, minor: 0 }));
  });

  it.each([
    new Error("connection refused"),
    new EngineFaultError("internalError"),
    new EngineFaultError("resourceLimit"),
  ])("asks for a running Refine app for %s", (error) => {
    expect(integrationFailureNotice(error)).toBe(
      "Refine is unavailable. Make sure the Refine app is running.",
    );
    expect(isIncompatibleEngineError(error)).toBe(false);
  });

  it("classifies only a malformed-message fault as a Refine version skew", () => {
    expect(isIncompatibleEngineError(new EngineFaultError("malformedMessage"))).toBe(
      true,
    );
    expect(isIncompatibleEngineError("malformedMessage")).toBe(false);
  });
});
