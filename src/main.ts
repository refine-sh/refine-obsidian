import {
  Component,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  setIcon,
  setTooltip,
} from "obsidian";
import type { EditorView } from "@codemirror/view";

import { createRefineIntegration } from "./integration/refine-integration";
import { incompatibleProtocolNotice } from "./obsidian/compatibility";
import { ObsidianEditorRegistry } from "./obsidian/editor-registry";
import { ObsidianSessionManager } from "./obsidian/session-manager";
import {
  createRefineStatusBarController,
  type RefineStatusBarActivationEvent,
  type RefineStatusBarController,
  type RefineStatusBarState,
  statusBarStateForSession,
  statusMenuShowsCheckControls,
} from "./obsidian/status-bar";
import {
  IncompatibleProtocolError,
  RefineTransport,
} from "./transport/refine-transport";

export default class RefinePlugin extends Plugin {
  private sessions: ObsidianSessionManager | undefined;
  private editors: ObsidianEditorRegistry | undefined;
  private statusBar: RefineStatusBarController | undefined;
  private statusItem: HTMLElement | undefined;
  private statusState: RefineStatusBarState = { type: "noEditor" };

  onload(): void {
    const statusItem = this.addStatusBarItem();
    this.statusItem = statusItem;
    this.statusBar = createRefineStatusBarController({
      element: statusItem,
      renderIcon: setIcon,
      onActivate: (event) => this.openStatusMenu(event),
    });
    this.refreshStatusTooltip();
    this.registerDomEvent(statusItem, "contextmenu", (event) => {
      event.preventDefault();
      this.openStatusMenu(event);
    });

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
      renderExplanation: (markdown, element) => {
        const component = new Component();
        component.load();
        const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
        void MarkdownRenderer.render(
          this.app,
          markdown,
          element,
          sourcePath,
          component,
        ).catch(() => {
          element.textContent = markdown;
        });
        return () => component.unload();
      },
      onError: (error) => {
        console.error("Refine integration stopped");
        new Notice(
          error instanceof IncompatibleProtocolError
            ? incompatibleProtocolNotice(error.requiredUpdate)
            : "Refine is unavailable. Make sure the Refine app is running.",
        );
      },
      onStateChange: (state) => {
        this.statusState = statusBarStateForSession(state);
        this.statusBar?.setState(this.statusState);
        this.refreshStatusTooltip();
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
      editorCallback: () => this.requestCheckForActiveEditor(),
    });
  }

  onunload(): void {
    this.sessions?.dispose();
    this.statusBar?.dispose();
    this.sessions = undefined;
    this.editors = undefined;
    this.statusBar = undefined;
    this.statusItem = undefined;
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

  private activeEditorView(): EditorView | undefined {
    const markdown = this.app.workspace.getActiveViewOfType(MarkdownView);
    return markdown?.getMode() === "source"
      ? this.editorViewIn(markdown.containerEl)
      : undefined;
  }

  private requestCheckForActiveEditor(): void {
    const view = this.activeEditorView();
    if (!view) {
      new Notice("Open a Markdown note in edit mode to use Refine.");
      return;
    }
    this.sessions?.requestCheck(view);
  }

  private openStatusMenu(event: RefineStatusBarActivationEvent): void {
    const menu = new Menu();
    const status =
      this.statusItem?.getAttribute("aria-label")
        ?.replace(/\. Open Refine menu$/, "") ?? "Refine";
    menu.addItem((item) => item.setTitle(status).setIsLabel(true));
    if (statusMenuShowsCheckControls(this.statusState)) {
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("Check current note")
          .setIcon("spell-check-2")
          .setDisabled(this.activeEditorView() === undefined)
          .onClick(() => this.requestCheckForActiveEditor()),
      );
      menu.addItem((item) =>
        item
          .setTitle("Automatic checks follow Refine settings")
          .setIcon("settings-2")
          .setDisabled(true),
      );
    }

    if (event instanceof MouseEvent) {
      menu.showAtMouseEvent(event);
      return;
    }
    const bounds = this.statusItem?.getBoundingClientRect();
    menu.showAtPosition({
      x: bounds?.right ?? 0,
      y: bounds?.top ?? 0,
    });
  }

  private refreshStatusTooltip(): void {
    const statusItem = this.statusItem;
    if (!statusItem) {
      return;
    }
    setTooltip(
      statusItem,
      statusItem.getAttribute("aria-label") ?? "Refine",
      { placement: "top" },
    );
  }
}
