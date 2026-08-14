import type { RequiredCompatibilityUpdate } from "../transport/refine-transport";

export function incompatibleProtocolNotice(
  requiredUpdate: RequiredCompatibilityUpdate,
): string {
  return requiredUpdate === "server"
    ? "This version of the Refine Obsidian plugin requires a newer version of the Refine app. Update Refine and try again."
    : "The installed version of the Refine app requires a newer version of the Refine Obsidian plugin. Update the plugin and try again.";
}

export function incompatibleProtocolStatus(
  requiredUpdate: RequiredCompatibilityUpdate,
): string {
  return requiredUpdate === "server"
    ? "Refine: Update the Refine app to continue. Open Refine menu"
    : "Refine: Update the Refine Obsidian plugin to continue. Open Refine menu";
}
