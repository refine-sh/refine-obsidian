import {
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import type {
  PresentedSuggestion,
  PresentationSnapshot,
  SuggestionActionKind,
  SuggestionActions,
} from "../integration/types";

interface InstalledPresentation {
  readonly snapshot: PresentationSnapshot;
  readonly actions: SuggestionActions;
  readonly decorations: DecorationSet;
}

const replacePresentation = StateEffect.define<InstalledPresentation | undefined>();

const presentationField = StateField.define<InstalledPresentation | undefined>({
  create: () => undefined,
  update(value, transaction) {
    let next = transaction.docChanged ? undefined : value;
    for (const effect of transaction.effects) {
      if (effect.is(replacePresentation)) {
        next = effect.value;
      }
    }
    return next;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value?.decorations ?? Decoration.none),
});

class InsertionAnchorWidget extends WidgetType {
  constructor(private readonly suggestionId: string) {
    super();
  }

  eq(other: InsertionAnchorWidget): boolean {
    return other.suggestionId === this.suggestionId;
  }

  toDOM(view: EditorView): HTMLElement {
    const anchor = view.dom.ownerDocument.createElement("span");
    anchor.className = "refine-insertion-anchor";
    anchor.dataset.refineSuggestionId = this.suggestionId;
    anchor.setAttribute("aria-label", "Refine insertion suggestion");
    anchor.setAttribute("role", "button");
    anchor.tabIndex = 0;
    return anchor;
  }
}

class PresentationPopover implements PluginValue {
  private element: HTMLElement | undefined;

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    if (
      update.docChanged ||
      update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(replacePresentation)),
      )
    ) {
      this.close();
    }
  }

  destroy(): void {
    this.close();
  }

  open(target: HTMLElement, suggestionId: string): void {
    const presentation = this.view.state.field(presentationField, false);
    const suggestion = presentation?.snapshot.suggestions.find(
      (candidate) => candidate.id === suggestionId,
    );
    if (!presentation || !suggestion) {
      this.close();
      return;
    }

    this.close();
    this.element = renderSuggestionCard(
      target.ownerDocument,
      suggestion,
      presentation.actions,
      () => this.close(),
    );
    const bounds = target.getBoundingClientRect();
    this.element.style.left = `${bounds.left}px`;
    this.element.style.top = `${bounds.bottom + 4}px`;
    target.ownerDocument.body.append(this.element);
    this.element.querySelector<HTMLElement>("button")?.focus();
  }

  close(): void {
    this.element?.remove();
    this.element = undefined;
  }
}

const presentationPopover = ViewPlugin.fromClass(PresentationPopover, {
  eventHandlers: {
    click(event): boolean {
      const target = suggestionTarget(event.target);
      const suggestionId = target?.dataset.refineSuggestionId;
      if (!target || !suggestionId) {
        return false;
      }
      this.open(target, suggestionId);
      return true;
    },
    keydown(event): boolean {
      if (event.key !== "Enter" && event.key !== " ") {
        return false;
      }
      const target = suggestionTarget(event.target);
      const suggestionId = target?.dataset.refineSuggestionId;
      if (!target || !suggestionId) {
        return false;
      }
      event.preventDefault();
      this.open(target, suggestionId);
      return true;
    },
  },
});

export const refinePresentationExtension: Extension = [
  presentationField,
  presentationPopover,
];

export function installPresentation(
  view: EditorView,
  snapshot: PresentationSnapshot,
  actions: SuggestionActions,
): void {
  view.dispatch({
    effects: replacePresentation.of({
      snapshot,
      actions,
      decorations: buildDecorations(view, snapshot),
    }),
  });
}

export function clearPresentation(view: EditorView): void {
  view.dispatch({ effects: replacePresentation.of(undefined) });
}

function buildDecorations(
  view: EditorView,
  snapshot: PresentationSnapshot,
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const suggestion of snapshot.suggestions) {
    if (suggestion.sourceId !== "document") {
      continue;
    }
    for (const range of suggestion.highlightRanges) {
      const from = range.location;
      const to = from + range.length;
      if (from < 0 || to < from || to > view.state.doc.length) {
        continue;
      }
      if (range.length === 0) {
        ranges.push(
          Decoration.widget({
            side: 1,
            widget: new InsertionAnchorWidget(suggestion.id),
          }).range(from),
        );
      } else {
        ranges.push(
          Decoration.mark({
            attributes: {
              "aria-label": "Refine writing suggestion",
              "data-refine-suggestion-id": suggestion.id,
              role: "button",
              tabindex: "0",
            },
            class: "refine-suggestion",
            inclusive: false,
          }).range(from, to),
        );
      }
    }
  }
  return Decoration.set(ranges, true);
}

function renderSuggestionCard(
  ownerDocument: Document,
  suggestion: PresentedSuggestion,
  actions: SuggestionActions,
  close: () => void,
): HTMLElement {
  const card = ownerDocument.createElement("div");
  card.className = "refine-tooltip";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Refine writing suggestion");

  const diff = ownerDocument.createElement("div");
  diff.className = "refine-tooltip__diff";
  for (const run of suggestion.diff) {
    const part = ownerDocument.createElement("span");
    part.className = `refine-tooltip__${run.kind}`;
    part.textContent = run.text;
    diff.append(part);
  }
  card.append(diff);

  const explanation = ownerDocument.createElement("div");
  explanation.className = "refine-tooltip__explanation";
  card.append(explanation);

  const actionRow = ownerDocument.createElement("div");
  actionRow.className = "refine-tooltip__actions";
  for (const action of suggestion.availableActions) {
    actionRow.append(
      actionButton(ownerDocument, action, async (button) => {
        button.disabled = true;
        if (action === "explain") {
          for await (const update of actions.explain(suggestion.id)) {
            if (update.status === "streaming" || update.status === "completed") {
              explanation.textContent = update.text;
            } else {
              explanation.textContent =
                update.status === "stale" ? "This suggestion is stale." : "Explanation unavailable.";
            }
          }
          button.disabled = false;
          return;
        }

        const outcome = await actions[action](suggestion.id);
        if (outcome.status === "completed") {
          close();
        } else {
          explanation.textContent =
            outcome.status === "stale" ? "This suggestion is stale." : "Action unavailable.";
          button.disabled = false;
        }
      }),
    );
  }
  card.append(actionRow);
  return card;
}

function suggestionTarget(target: EventTarget | null): HTMLElement | undefined {
  const candidate = target as { closest?: (selector: string) => Element | null } | null;
  return (candidate?.closest?.("[data-refine-suggestion-id]") as HTMLElement | null) ??
    undefined;
}

function actionButton(
  ownerDocument: Document,
  action: SuggestionActionKind,
  run: (button: HTMLButtonElement) => Promise<void>,
): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.textContent = `${action[0]?.toUpperCase() ?? ""}${action.slice(1)}`;
  button.addEventListener("click", () => {
    void run(button).catch(() => {
      button.disabled = false;
    });
  });
  return button;
}
