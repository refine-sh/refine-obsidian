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
  closeHoverTooltips,
  hoverTooltip,
  type PluginValue,
  tooltips,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import type {
  PresentedSuggestion,
  PresentationAppearance,
  PresentationSnapshot,
  SuggestionActionKind,
  SuggestionActions,
} from "../integration/types";

interface InstalledPresentation {
  readonly snapshot: PresentationSnapshot;
  readonly actions: SuggestionActions;
  readonly decorations: DecorationSet;
}

interface SuggestionHit {
  readonly suggestionId: string;
  readonly anchorX: number;
  readonly anchorY: number;
}

interface SuggestionRangeMatch {
  readonly suggestion: PresentedSuggestion;
  readonly from: number;
  readonly to: number;
}

const suggestionHoverTimeMs = 200;
const manualPopoverViewportGutterPx = 16;
let suggestionCardLabelSequence = 0;

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
  constructor(
    private readonly suggestionId: string,
    private readonly style: PresentationAppearance["highlight"]["style"],
    private readonly color: string,
  ) {
    super();
  }

  eq(other: InsertionAnchorWidget): boolean {
    return (
      other.suggestionId === this.suggestionId &&
      other.style === this.style &&
      other.color === this.color
    );
  }

  ignoreEvent(): boolean {
    return false;
  }

  toDOM(view: EditorView): HTMLElement {
    const anchor = view.dom.ownerDocument.createElement("span");
    anchor.className =
      `refine-insertion-anchor refine-insertion-anchor--${this.style}`;
    anchor.dataset.refineSuggestionId = this.suggestionId;
    anchor.setAttribute("aria-label", "Refine insertion suggestion");
    anchor.setAttribute("role", "button");
    anchor.style.setProperty("--no-tooltip", "true");
    anchor.style.setProperty("--refine-suggestion-color", this.color);
    anchor.tabIndex = 0;
    return anchor;
  }
}

class PresentationPopover implements PluginValue {
  private element: HTMLElement | undefined;
  private manualAnchorX: number | undefined;
  private manualAnchorY: number | undefined;
  private manualCardResizeObserver: ResizeObserver | undefined;
  private manualTrigger: HTMLElement | undefined;
  private primaryPointerDownInEditor = false;
  private selectionStartedOnSuggestion = false;
  private suppressHoverUntilMove = false;

  constructor(private readonly view: EditorView) {
    view.contentDOM.addEventListener("mousedown", this.handleMouseDown, true);
    view.contentDOM.addEventListener("mousemove", this.handleMouseMove, true);
    view.contentDOM.addEventListener("dragstart", this.handleDragStart, true);
    view.contentDOM.addEventListener("click", this.handleClick, true);
    view.dom.ownerDocument.addEventListener("mouseup", this.handleMouseUp, true);
    view.dom.ownerDocument.addEventListener("dragend", this.handleMouseUp, true);
    view.dom.ownerDocument.addEventListener("pointercancel", this.handlePointerCancel, true);
    view.dom.ownerDocument.defaultView?.addEventListener("blur", this.handlePointerCancel);
    view.dom.ownerDocument.defaultView?.addEventListener(
      "resize",
      this.positionManualCard,
    );
  }

  get isHoverSuppressed(): boolean {
    return (
      this.primaryPointerDownInEditor ||
      this.suppressHoverUntilMove ||
      this.element !== undefined
    );
  }

  get hasManualPopover(): boolean {
    return this.element !== undefined;
  }

  get hasActiveRefineHover(): boolean {
    return (this.view.state.field(suggestionHover.active, false)?.length ?? 0) > 0;
  }

  update(update: ViewUpdate): void {
    if (
      update.docChanged ||
      update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(replacePresentation)),
      )
    ) {
      // Presentation freshness and pointer lifecycle are independent. Closing
      // the card here is enough; clearing gesture state could let a pending
      // hover timer reopen while the user is still selecting text.
      this.close();
    }
  }

  destroy(): void {
    this.view.contentDOM.removeEventListener("mousedown", this.handleMouseDown, true);
    this.view.contentDOM.removeEventListener("mousemove", this.handleMouseMove, true);
    this.view.contentDOM.removeEventListener("dragstart", this.handleDragStart, true);
    this.view.contentDOM.removeEventListener("click", this.handleClick, true);
    this.view.dom.ownerDocument.removeEventListener("mouseup", this.handleMouseUp, true);
    this.view.dom.ownerDocument.removeEventListener("dragend", this.handleMouseUp, true);
    this.view.dom.ownerDocument.removeEventListener(
      "pointercancel",
      this.handlePointerCancel,
      true,
    );
    this.view.dom.ownerDocument.defaultView?.removeEventListener(
      "blur",
      this.handlePointerCancel,
    );
    this.view.dom.ownerDocument.defaultView?.removeEventListener(
      "resize",
      this.positionManualCard,
    );
    this.primaryPointerDownInEditor = false;
    this.selectionStartedOnSuggestion = false;
    this.suppressHoverUntilMove = false;
    this.close();
  }

  open(target: HTMLElement, suggestionId: string): void {
    this.view.dispatch({ effects: closeHoverTooltips });
    const bounds = target.getBoundingClientRect();
    this.openAt(suggestionId, bounds.left, bounds.bottom, target);
  }

  dismiss(): void {
    this.view.dispatch({ effects: closeHoverTooltips });
    this.closeAndRestoreTrigger();
  }

  private openAt(
    suggestionId: string,
    anchorX: number,
    anchorY: number,
    trigger?: HTMLElement,
  ): void {
    const presentation = this.view.state.field(presentationField, false);
    const suggestion = presentation?.snapshot.suggestions.find(
      (candidate) => candidate.id === suggestionId,
    );
    if (!presentation || !suggestion) {
      this.close();
      return;
    }

    this.close();
    this.manualAnchorX = anchorX;
    this.manualAnchorY = anchorY;
    this.manualTrigger = trigger;
    this.element = renderSuggestionCard(
      this.view.dom.ownerDocument,
      suggestion,
      presentation.snapshot.appearance,
      presentation.actions,
      () => this.closeAndRestoreTrigger(),
    );
    this.element.classList.add("refine-tooltip--manual");
    this.element.style.left = `${anchorX}px`;
    this.element.style.top = `${anchorY + 4}px`;
    const ownerDocument = this.view.dom.ownerDocument;
    ownerDocument.body.append(this.element);
    this.positionManualCard();
    const ResizeObserverConstructor = ownerDocument.defaultView?.ResizeObserver;
    if (ResizeObserverConstructor) {
      this.manualCardResizeObserver = new ResizeObserverConstructor(() =>
        this.positionManualCard(),
      );
      this.manualCardResizeObserver.observe(this.element);
    }
    this.element.querySelector<HTMLElement>("button")?.focus();
  }

  close(): void {
    this.manualCardResizeObserver?.disconnect();
    this.manualCardResizeObserver = undefined;
    this.element?.remove();
    this.element = undefined;
    this.manualAnchorX = undefined;
    this.manualAnchorY = undefined;
    this.manualTrigger = undefined;
  }

  private closeAndRestoreTrigger(): void {
    const trigger = this.manualTrigger;
    this.close();
    if (trigger?.isConnected) {
      trigger.focus();
    }
  }

  private readonly positionManualCard = (): void => {
    if (
      !this.element ||
      this.manualAnchorX === undefined ||
      this.manualAnchorY === undefined
    ) {
      return;
    }

    const ownerDocument = this.view.dom.ownerDocument;
    const viewportWidth =
      ownerDocument.documentElement.clientWidth ||
      ownerDocument.defaultView?.innerWidth ||
      0;
    if (viewportWidth <= 0) {
      return;
    }

    const triggerBounds = this.manualTrigger?.isConnected
      ? this.manualTrigger.getBoundingClientRect()
      : undefined;
    const anchorX = triggerBounds?.left ?? this.manualAnchorX;
    const anchorY = triggerBounds?.bottom ?? this.manualAnchorY;
    const cardWidth = this.element.getBoundingClientRect().width;
    const maximumLeft = Math.max(
      manualPopoverViewportGutterPx,
      viewportWidth - manualPopoverViewportGutterPx - cardWidth,
    );
    const clampedLeft = Math.min(
      Math.max(anchorX, manualPopoverViewportGutterPx),
      maximumLeft,
    );
    this.element.style.left = `${clampedLeft}px`;
    this.element.style.top = `${anchorY + 4}px`;
  };

  private readonly handleMouseDown = (event: MouseEvent): void => {
    this.primaryPointerDownInEditor = event.button === 0;
    this.selectionStartedOnSuggestion = false;
    if (this.primaryPointerDownInEditor) {
      // Closing the active tooltip does not cancel CodeMirror's pending hover
      // timer. Keep its source gated until a later button-free pointer move so
      // a quick click cannot reopen the card after mouseup.
      this.suppressHoverUntilMove = true;
    }
    this.close();
    this.view.dispatch({ effects: closeHoverTooltips });
    if (
      event.button !== 0 ||
      event.detail > 1 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }

    const hit = this.suggestionHit(event);
    if (!hit) {
      return;
    }
    this.selectionStartedOnSuggestion = true;
  };

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if ((event.buttons & 1) !== 0) {
      // The press may have started outside the editor, so derive this state
      // from every captured move rather than relying only on mousedown.
      this.primaryPointerDownInEditor = true;
      this.suppressHoverUntilMove = true;
      return;
    }
    this.primaryPointerDownInEditor = false;
    this.selectionStartedOnSuggestion = false;
    this.suppressHoverUntilMove = false;
  };

  private readonly handleDragStart = (event: DragEvent): void => {
    if (!this.selectionStartedOnSuggestion) {
      return;
    }
    const candidate = event.target as {
      closest?: (selector: string) => Element | null;
    } | null;
    if (candidate?.closest?.("a, [draggable='true']")) {
      // Live Preview link labels are draggable DOM links. Cancel only that
      // browser drag operation so CodeMirror can keep extending text selection.
      event.preventDefault();
    }
  };

  private readonly handleMouseUp = (): void => {
    this.primaryPointerDownInEditor = false;
    this.selectionStartedOnSuggestion = false;
  };

  private readonly handlePointerCancel = (): void => {
    this.primaryPointerDownInEditor = false;
    this.selectionStartedOnSuggestion = false;
    this.suppressHoverUntilMove = true;
    this.close();
    this.view.dispatch({ effects: closeHoverTooltips });
  };

  private readonly handleClick = (event: MouseEvent): void => {
    if (event.detail !== 0) {
      return;
    }

    const hit = this.suggestionHit(event);
    if (!hit) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.view.dispatch({ effects: closeHoverTooltips });
    this.openAt(
      hit.suggestionId,
      hit.anchorX,
      hit.anchorY,
      suggestionTarget(event.target),
    );
  };

  private suggestionHit(event: MouseEvent): SuggestionHit | undefined {
    const directTarget = suggestionTarget(event.target);
    const directSuggestionId = directTarget?.dataset.refineSuggestionId;
    if (directTarget && directSuggestionId) {
      const bounds = directTarget.getBoundingClientRect();
      return {
        suggestionId: directSuggestionId,
        anchorX: bounds.left,
        anchorY: bounds.bottom,
      };
    }

    const presentation = this.view.state.field(presentationField, false);
    const position = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (!presentation || position === null) {
      return undefined;
    }
    const suggestion = presentation.snapshot.suggestions
      .filter((candidate) => candidate.sourceId === "document")
      .flatMap((candidate) =>
        candidate.highlightRanges.map((range) => ({ candidate, range })),
      )
      .filter(
        ({ range }) =>
          range.length > 0 &&
          position >= range.location &&
          position <= range.location + range.length,
      )
      .sort((left, right) =>
        compareSuggestionMatches(
          {
            suggestion: left.candidate,
            from: left.range.location,
            to: left.range.location + left.range.length,
          },
          {
            suggestion: right.candidate,
            from: right.range.location,
            to: right.range.location + right.range.length,
          },
        ),
      )[0]?.candidate;
    if (!suggestion) {
      return undefined;
    }
    return {
      suggestionId: suggestion.id,
      anchorX: event.clientX,
      anchorY: event.clientY,
    };
  }

}

const presentationPopover = ViewPlugin.fromClass(PresentationPopover, {
  eventHandlers: {
    keydown(event): boolean {
      if (
        event.key === "Escape" &&
        (this.hasManualPopover || this.hasActiveRefineHover)
      ) {
        event.preventDefault();
        this.dismiss();
        return true;
      }
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

const suggestionHover = hoverTooltip(
  (view, position, side) => {
    if (view.plugin(presentationPopover)?.isHoverSuppressed) {
      return null;
    }
    const presentation = view.state.field(presentationField, false);
    const match = presentation && suggestionAtPosition(presentation.snapshot, position, side);
    if (!presentation || !match) {
      return null;
    }
    return {
      pos: match.from,
      end: match.to,
      create: () => {
        const card = renderSuggestionCard(
          view.dom.ownerDocument,
          match.suggestion,
          presentation.snapshot.appearance,
          presentation.actions,
          () => view.dispatch({ effects: closeHoverTooltips }),
        );
        return {
          dom: card,
          mount: () => card.parentElement?.classList.add("refine-tooltip-shell"),
        };
      },
    };
  },
  {
    hoverTime: suggestionHoverTimeMs,
    hideOnChange: true,
    hideOn: (transaction) =>
      transaction.docChanged ||
      transaction.effects.some((effect) => effect.is(replacePresentation)),
  },
);

export function refinePresentationExtension(ownerDocument: Document): Extension {
  return [
    presentationField,
    tooltips({ parent: ownerDocument.body }),
    suggestionHover,
    presentationPopover,
  ];
}

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

function suggestionAtPosition(
  snapshot: PresentationSnapshot,
  position: number,
  side: -1 | 1,
): SuggestionRangeMatch | undefined {
  return snapshot.suggestions
    .filter((suggestion) => suggestion.sourceId === "document")
    .flatMap((suggestion) =>
      suggestion.highlightRanges.map((range) => ({
        suggestion,
        from: range.location,
        to: range.location + range.length,
      })),
    )
    .filter(({ from, to }) => {
      if (from === to) {
        return position === from;
      }
      return (
        position >= from &&
        position <= to &&
        !(position === from && side < 0) &&
        !(position === to && side > 0)
      );
    })
    .sort(compareSuggestionMatches)[0];
}

function compareSuggestionMatches(
  left: SuggestionRangeMatch,
  right: SuggestionRangeMatch,
): number {
  // Highlight fragments are independent hover targets. Their enclosing
  // suggestion may carry a sentence- or paragraph-wide diff and Apply group,
  // so the envelope of every fragment is not a presentation scope.
  const fragmentLength = (left.to - left.from) - (right.to - right.from);
  if (fragmentLength !== 0) {
    return fragmentLength;
  }
  const kind = suggestionKindRank(left.suggestion.kind) -
    suggestionKindRank(right.suggestion.kind);
  if (kind !== 0) {
    return kind;
  }
  return left.suggestion.id < right.suggestion.id
    ? -1
    : left.suggestion.id > right.suggestion.id
      ? 1
      : 0;
}

function suggestionKindRank(kind: PresentedSuggestion["kind"]): number {
  return kind === "grammar" ? 0 : 1;
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
      const style = snapshot.appearance.highlight.style;
      const color = suggestionColor(snapshot.appearance, suggestion.kind);
      const from = range.location;
      const to = from + range.length;
      if (from < 0 || to < from || to > view.state.doc.length) {
        continue;
      }
      if (range.length === 0) {
        ranges.push(
          Decoration.widget({
            side: 1,
            widget: new InsertionAnchorWidget(suggestion.id, style, color),
          }).range(from),
        );
      } else {
        ranges.push(
          Decoration.mark({
            attributes: {
              "aria-label": "Refine writing suggestion",
              "data-refine-suggestion-id": suggestion.id,
              role: "button",
              style: [
                "--no-tooltip: true",
                `--refine-suggestion-color: ${color}`,
                `text-decoration-color: ${color} !important`,
              ].join("; "),
              tabindex: "0",
            },
            class: `refine-suggestion refine-suggestion--${style}`,
            inclusive: false,
          }).range(from, to),
        );
      }
    }
  }
  return Decoration.set(ranges, true);
}

function suggestionColor(
  appearance: PresentationAppearance,
  kind: PresentedSuggestion["kind"],
): string {
  return kind === "grammar"
    ? appearance.highlight.grammarColor
    : appearance.highlight.fluencyColor;
}

function renderSuggestionCard(
  ownerDocument: Document,
  suggestion: PresentedSuggestion,
  appearance: PresentationAppearance,
  actions: SuggestionActions,
  close: () => void,
): HTMLElement {
  const card = ownerDocument.createElement("div");
  card.className = "refine-tooltip";
  card.setAttribute("role", "dialog");
  card.style.setProperty("--no-tooltip", "true");
  card.style.setProperty("--refine-addition-color", appearance.diff.additionColor);
  card.style.setProperty("--refine-deletion-color", appearance.diff.deletionColor);
  const label = ownerDocument.createElement("span");
  label.id = `refine-tooltip-label-${++suggestionCardLabelSequence}`;
  label.className = "refine-tooltip__accessible-label";
  label.textContent = "Refine writing suggestion";
  card.setAttribute("aria-labelledby", label.id);
  card.append(label);
  card.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    close();
  });

  const diff = ownerDocument.createElement("div");
  diff.className = "refine-tooltip__diff";
  for (const run of suggestion.diff) {
    const part = ownerDocument.createElement("span");
    part.className = `refine-tooltip__${run.kind}`;
    part.textContent = run.text;
    if (run.kind !== "unchanged" && /^ +$/.test(run.text)) {
      const change = run.kind === "insert" ? "Inserted" : "Deleted";
      part.classList.add("refine-tooltip__whitespace");
      part.setAttribute(
        "aria-label",
        `${change} ${run.text.length === 1 ? "space" : `${run.text.length} spaces`}`,
      );
      if (appearance.diff.showHiddenWhitespace) {
        part.dataset.refineWhitespaceMarker = "·".repeat(run.text.length);
      }
    }
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
