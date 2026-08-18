import { describe, expect, it, vi } from "vitest";
import type { Vault } from "obsidian";

import {
  documentSourceSyntax,
  onLineBreakSettingChange,
} from "../../src/obsidian/line-break-setting";

function vaultWith(overrides: Record<string, unknown>): Vault {
  return overrides as unknown as Vault;
}

describe("documentSourceSyntax", () => {
  it("declares markdownDocument only for an explicitly strict vault", () => {
    const vault = vaultWith({ getConfig: (key: string) => key === "strictLineBreaks" });
    expect(documentSourceSyntax(vault)).toBe("markdownDocument");
  });

  it("keeps the line-preserving declaration for the shipped default", () => {
    const vault = vaultWith({ getConfig: () => false });
    expect(documentSourceSyntax(vault)).toBe("markdownDocumentHardLineBreaks");
  });

  it("treats a truthy non-boolean setting as unproven", () => {
    for (const value of ["true", 1, {}, null, undefined]) {
      const vault = vaultWith({ getConfig: () => value });
      expect(documentSourceSyntax(vault)).toBe("markdownDocumentHardLineBreaks");
    }
  });

  it("keeps the line-preserving declaration without a config surface", () => {
    expect(documentSourceSyntax(vaultWith({}))).toBe(
      "markdownDocumentHardLineBreaks",
    );
    expect(documentSourceSyntax(vaultWith({ getConfig: "nope" }))).toBe(
      "markdownDocumentHardLineBreaks",
    );
  });

  it("keeps the line-preserving declaration when the config read throws", () => {
    const vault = vaultWith({
      getConfig: () => {
        throw new Error("unavailable");
      },
    });
    expect(documentSourceSyntax(vault)).toBe("markdownDocumentHardLineBreaks");
  });

  it("reads the setting with the vault as its receiver", () => {
    const vault = vaultWith({
      getConfig(this: unknown, key: string) {
        expect(this).toBe(vault);
        return key === "strictLineBreaks";
      },
    });
    expect(documentSourceSyntax(vault)).toBe("markdownDocument");
  });
});

describe("onLineBreakSettingChange", () => {
  it("re-evaluates for the strict line break key and ignores other keys", () => {
    let handler: ((...data: unknown[]) => unknown) | undefined;
    const eventRef = { detach: true };
    const vault = vaultWith({
      on: (name: string, callback: (...data: unknown[]) => unknown) => {
        expect(name).toBe("config-changed");
        handler = callback;
        return eventRef;
      },
    });
    const onChange = vi.fn();

    expect(onLineBreakSettingChange(vault, onChange)).toBe(eventRef);
    handler?.("readableLineLength");
    expect(onChange).not.toHaveBeenCalled();
    handler?.("strictLineBreaks");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("re-evaluates for an unexpected non-string payload", () => {
    let handler: ((...data: unknown[]) => unknown) | undefined;
    const vault = vaultWith({
      on: (_name: string, callback: (...data: unknown[]) => unknown) => {
        handler = callback;
        return {};
      },
    });
    const onChange = vi.fn();

    onLineBreakSettingChange(vault, onChange);
    handler?.({ strictLineBreaks: true });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("re-evaluates when an older build delivers no key", () => {
    let handler: ((...data: unknown[]) => unknown) | undefined;
    const vault = vaultWith({
      on: (_name: string, callback: (...data: unknown[]) => unknown) => {
        handler = callback;
        return {};
      },
    });
    const onChange = vi.fn();

    onLineBreakSettingChange(vault, onChange);
    handler?.();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("subscribes with the vault as its receiver", () => {
    const vault = vaultWith({
      on(
        this: unknown,
        name: string,
        _callback: (...data: unknown[]) => unknown,
      ) {
        expect(this).toBe(vault);
        expect(name).toBe("config-changed");
        return { subscribed: true };
      },
    });
    expect(onLineBreakSettingChange(vault, vi.fn())).toEqual({
      subscribed: true,
    });
  });

  it("returns undefined without an event surface", () => {
    expect(onLineBreakSettingChange(vaultWith({}), vi.fn())).toBeUndefined();
    expect(
      onLineBreakSettingChange(vaultWith({ on: "nope" }), vi.fn()),
    ).toBeUndefined();
  });
});
