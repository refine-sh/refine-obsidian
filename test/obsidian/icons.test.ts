// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { REFINE_MENU_BAR_ICON_SVG } from "../../src/obsidian/icons";

describe("Refine Obsidian icons", () => {
  it("fills Obsidian's custom-icon viewport", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.innerHTML = REFINE_MENU_BAR_ICON_SVG;

    const mask = svg.querySelector("mask");
    const image = svg.querySelector("image");
    const fill = svg.querySelector("rect");

    expect(mask?.getAttribute("x")).toBe("0");
    expect(mask?.getAttribute("y")).toBe("0");
    expect(mask?.getAttribute("width")).toBe("100");
    expect(mask?.getAttribute("height")).toBe("100");
    expect(image?.getAttribute("width")).toBe("100");
    expect(image?.getAttribute("height")).toBe("100");
    expect(fill?.getAttribute("width")).toBe("100");
    expect(fill?.getAttribute("height")).toBe("100");
    expect(fill?.getAttribute("fill")).toBe("currentColor");
  });
});
