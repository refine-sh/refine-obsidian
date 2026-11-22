import { CHECK_DIAGNOSTICS_CAPABILITY } from "./check-diagnostics";
import { SUGGESTION_GESTURE_CAPABILITY } from "./suggestion-binding";
import { SUGGESTION_SHORTCUT_CAPABILITY } from "./suggestion-shortcut";
import { WAVY_UNDERLINE_HIGHLIGHT_CAPABILITY } from "./wavy-underline-highlight";

/** Optional capabilities the Obsidian plugin offers in `hello`. */
export const OFFERED_CAPABILITIES: readonly string[] = [
  SUGGESTION_SHORTCUT_CAPABILITY,
  SUGGESTION_GESTURE_CAPABILITY,
  CHECK_DIAGNOSTICS_CAPABILITY,
  WAVY_UNDERLINE_HIGHLIGHT_CAPABILITY,
];
