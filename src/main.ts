import { MarkdownView, Notice, Plugin } from "obsidian";
import type { EditorView } from "@codemirror/view";

import { createRefineIntegration } from "./integration/refine-integration";
import { ObsidianEditorRegistry } from "./obsidian/editor-registry";
import { ObsidianSessionManager } from "./obsidian/session-manager";
import { RefineTransport } from "./transport/refine-transport";

export default class RefinePlugin extends Plugin {
  private sessions: ObsidianSessionManager | undefined;
  private editors: ObsidianEditorRegistry | undefined;

  onload(): void {
    const enginePort = new RefineTransport({
      client: {
        id: "refine-obsidian",
        version: this.manifest.version,
        host: "obsidian",
      },
    });
    const integration = createRefineIntegration({ enginePort });
    this.sessions = new ObsidianSessionManager({
      integration,
      onError: (error) => {
        console.error("Refine integration stopped", error);
        new Notice("Refine is unavailable. Make sure the Refine app is running.");
      },
    });
    this.editors = new ObsidianEditorRegistry(() => {
      queueMicrotask(() => this.synchronizeActiveEditor());
    });
    this.registerEditorExtension(this.editors.extension);

    const synchronize = (): void => this.synchronizeActiveEditor();
    this.app.workspace.onLayoutReady(synchronize);
    this.registerEvent(this.app.workspace.on("active-leaf-change", synchronize));
    this.registerEvent(this.app.workspace.on("file-open", synchronize));
    this.registerEvent(this.app.workspace.on("layout-change", synchronize));
    this.registerEvent(this.app.workspace.on("editor-change", synchronize));

    this.addCommand({
      id: "check-current-note",
      name: "Check current note",
      editorCallback: (_editor, context) => {
        const view =
          context instanceof MarkdownView
            ? this.editorViewIn(context.containerEl)
            : undefined;
        if (!view) {
          new Notice("Open a Markdown note in edit mode to use Refine.");
          return;
        }
        this.sessions?.requestCheck(view);
      },
    });
  }

  onunload(): void {
    this.sessions?.dispose();
    this.sessions = undefined;
    this.editors = undefined;
  }

  private synchronizeActiveEditor(): void {
    const markdown = this.app.workspace.getActiveViewOfType(MarkdownView);
    const view =
      markdown?.getMode() === "source"
        ? this.editorViewIn(markdown.containerEl)
        : undefined;
    if (view) {
      this.sessions?.activate(view);
    } else {
      this.sessions?.deactivate();
    }
  }

  private editorViewIn(container: HTMLElement): EditorView | undefined {
    return this.editors?.findIn(container);
  }
}
