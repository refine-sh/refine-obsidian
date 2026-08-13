import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";

export class ObsidianEditorRegistry {
  readonly extension: Extension;
  private readonly views = new Set<EditorView>();

  constructor(onViewsChanged: () => void = () => undefined) {
    this.extension = ViewPlugin.define((view) => {
      this.views.add(view);
      onViewsChanged();
      return {
        destroy: () => {
          this.views.delete(view);
          onViewsChanged();
        },
      };
    });
  }

  findIn(container: HTMLElement): EditorView | undefined {
    for (const view of this.views) {
      if (container.contains(view.dom)) {
        return view;
      }
    }
    return undefined;
  }
}
