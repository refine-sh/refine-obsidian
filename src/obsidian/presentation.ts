import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  type ReferenceElement,
  type VirtualElement,
} from "@floating-ui/dom";
import {
  StateEffect,
  StateField,
  type ChangeDesc,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  Direction,
  EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import type {
  PresentedSuggestion,
  PresentationAppearance,
  PresentationSnapshot,
  SuggestionActions,
} from "../integration/types";
import {
  disposeSuggestionCard,
  plainExplanationRenderer,
  renderSuggestionCard,
  type ExplanationRenderer,
} from "./suggestion-card";

export type { ExplanationRenderer } from "./suggestion-card";

interface InstalledPresentation {
  readonly type: "live";
  readonly snapshot: PresentationSnapshot;
  readonly actions: SuggestionActions;
  readonly decorations: DecorationSet;
  readonly renderExplanation: ExplanationRenderer;
}

interface ProvisionalSuggestion {
  readonly style: PresentationAppearance["highlight"]["style"];
  readonly color: string;
  readonly highlightRanges: readonly {
    readonly location: number;
    readonly length: number;
  }[];
}

interface ProvisionalPresentation {
  // Deliberately retains neither suggestion IDs nor action closures from the
  // retired document revision.
  readonly type: "provisional";
  readonly decorations: DecorationSet;
  readonly suggestions: readonly ProvisionalSuggestion[];
}

type PresentationState = InstalledPresentation | ProvisionalPresentation;

interface SuggestionHit {
  readonly suggestionId: string;
  readonly match?: SuggestionRangeMatch;
  readonly trigger?: HTMLElement;
}

interface SuggestionRangeMatch {
  readonly suggestion: PresentedSuggestion;
  readonly from: number;
  readonly to: number;
}

interface HoverCandidate {
  readonly match: SuggestionRangeMatch;
  readonly presentationRevision: number;
}

interface PointerPoint {
  readonly x: number;
  readonly y: number;
}

interface HoverBridge {
  readonly origin: PointerPoint;
  previous: PointerPoint;
  readonly target: "card" | "suggestion";
}

type SuggestionCardMode = "hover" | "manual";

const suggestionHoverOpenDelayMs = 100;
const suggestionHoverCloseDelayMs = 120;
const suggestionHoverBridgeBufferPx = 6;
const suggestionCardViewportGutterPx = 16;
const suggestionCardGapPx = 4;

const replacePresentation = StateEffect.define<InstalledPresentation | undefined>();
const clearLivePresentationEffect = StateEffect.define<null>();

const presentationField = StateField.define<PresentationState | undefined>({
  create: () => undefined,
  update(value, transaction) {
    const documentTextChanged = transaction.docChanged &&
      !transaction.startState.doc.eq(transaction.newDoc);
    let next = documentTextChanged
      ? provisionalPresentation(value, transaction.changes)
      : value;
    for (const effect of transaction.effects) {
      if (effect.is(replacePresentation)) {
        // Pending is lifecycle state only. Keep inert mapped pixels until the
        // first authoritative presentation for the new revision arrives.
        next =
          effect.value !== undefined &&
          effect.value.snapshot.state.type === "pending" &&
          effect.value.snapshot.suggestions.length === 0 &&
          next?.type === "provisional"
            ? next
            : effect.value;
      } else if (
        effect.is(clearLivePresentationEffect) &&
        next?.type === "live"
      ) {
        next = undefined;
      }
    }
    return next;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value?.decorations ?? Decoration.none),
});

class InsertionAnchorWidget extends WidgetType {
  constructor(
    private readonly suggestionId: string | undefined,
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
    anchor.style.setProperty("--no-tooltip", "true");
    anchor.style.setProperty("--refine-suggestion-color", this.color);
    if (this.suggestionId === undefined) {
      anchor.classList.add("refine-insertion-anchor--provisional");
      anchor.setAttribute("aria-hidden", "true");
      anchor.style.pointerEvents = "none";
    } else {
      anchor.dataset.refineSuggestionId = this.suggestionId;
      anchor.setAttribute("aria-label", "Refine insertion suggestion");
      anchor.setAttribute("role", "button");
      anchor.tabIndex = 0;
    }
    return anchor;
  }
}

function livePresentation(
  presentation: PresentationState | undefined,
): InstalledPresentation | undefined {
  return presentation?.type === "live" ? presentation : undefined;
}

function provisionalPresentation(
  presentation: PresentationState | undefined,
  changes: ChangeDesc,
): ProvisionalPresentation | undefined {
  if (!presentation) {
    return undefined;
  }
  const candidates = presentation.type === "provisional"
    ? presentation.suggestions
    : provisionalSuggestions(
      presentation.snapshot,
      changes.length,
    );
  const changedRanges: Array<{ readonly from: number; readonly to: number }> = [];
  changes.iterChangedRanges((from, to) => {
    changedRanges.push({ from, to });
  }, true);
  const suggestions = candidates.flatMap((suggestion) => {
    if (suggestion.highlightRanges.some((range) =>
      changedRanges.some((change) => rangesTouch(range, change))
    )) {
      return [];
    }
    return [{
      ...suggestion,
      highlightRanges: suggestion.highlightRanges.map((range) => {
        const location = changes.mapPos(range.location, 1);
        const end = range.length === 0
          ? location
          : changes.mapPos(range.location + range.length, -1);
        return { location, length: end - location };
      }),
    }];
  });
  if (suggestions.length === 0) {
    return undefined;
  }
  return {
    type: "provisional",
    suggestions,
    decorations: buildProvisionalDecorations(changes.newLength, suggestions),
  };
}

function provisionalSuggestions(
  snapshot: PresentationSnapshot,
  documentLength: number,
): ProvisionalSuggestion[] {
  const style = snapshot.appearance.highlight.style;
  return snapshot.suggestions.flatMap((suggestion) => {
    if (
      suggestion.sourceId !== "document" ||
      suggestion.highlightRanges.length === 0 ||
      suggestion.highlightRanges.some(({ location, length }) =>
        location < 0 || length < 0 || location + length > documentLength
      )
    ) {
      return [];
    }
    return [{
      style,
      color: suggestionColor(snapshot.appearance, suggestion.kind),
      highlightRanges: suggestion.highlightRanges,
    }];
  });
}

function rangesTouch(
  range: { readonly location: number; readonly length: number },
  change: { readonly from: number; readonly to: number },
): boolean {
  const end = range.location + range.length;
  // Treat shared boundaries as touched so insertion anchors and replacement
  // edges fail closed instead of acquiring ambiguous ownership.
  return change.from <= end && range.location <= change.to;
}

class PresentationPopover implements PluginValue {
  private element: HTMLElement | undefined;
  private cardMode: SuggestionCardMode | undefined;
  private floatingCleanup: (() => void) | undefined;
  private hoverBridge: HoverBridge | undefined;
  private hoverCloseTimer: number | undefined;
  private hoverOpenTimer: number | undefined;
  private hoverReference: ReferenceElement | undefined;
  private manualTrigger: HTMLElement | undefined;
  private pendingHover: HoverCandidate | undefined;
  private primaryPointerDownInEditor = false;
  private selectionStartedOnSuggestion = false;
  private suppressHoverUntilMove = false;

  constructor(private readonly view: EditorView) {
    view.contentDOM.addEventListener("mousedown", this.handleMouseDown, true);
    view.contentDOM.addEventListener("mousemove", this.handleMouseMove, true);
    view.contentDOM.addEventListener("dragstart", this.handleDragStart, true);
    view.contentDOM.addEventListener("click", this.handleClick, true);
    view.contentDOM.addEventListener("mouseleave", this.handleEditorMouseLeave);
    view.dom.ownerDocument.addEventListener("mouseup", this.handleMouseUp, true);
    view.dom.ownerDocument.addEventListener("dragend", this.handleMouseUp, true);
    view.dom.ownerDocument.addEventListener("pointercancel", this.handlePointerCancel, true);
    view.dom.ownerDocument.defaultView?.addEventListener("blur", this.handlePointerCancel);
  }

  get hasCard(): boolean {
    return this.element !== undefined;
  }

  update(update: ViewUpdate): void {
    const activeElement = this.view.dom.ownerDocument.activeElement;
    const presentation = this.view.state.field(presentationField, false);
    const shouldRestoreEditorFocus =
      presentation?.type !== "live" &&
      activeElement !== null &&
      this.view.contentDOM.contains(activeElement) &&
      activeElement.matches(
        ".refine-suggestion, .refine-insertion-anchor",
      );
    if (
      update.docChanged ||
      update.transactions.some((transaction) =>
        transaction.effects.some((effect) =>
          effect.is(replacePresentation) ||
          effect.is(clearLivePresentationEffect)
        ),
      )
    ) {
      // Presentation freshness and pointer lifecycle are independent. Closing
      // the card here is enough; clearing gesture state could let a pending
      // hover timer reopen while the user is still selecting text.
      this.close();
    }
    if (shouldRestoreEditorFocus) {
      // CodeMirror may reuse the focused live mark DOM node for an inert
      // provisional decoration. Move focus back to the editor while leaving
      // its already-mapped selection untouched.
      this.view.focus();
    }
  }

  destroy(): void {
    this.view.contentDOM.removeEventListener("mousedown", this.handleMouseDown, true);
    this.view.contentDOM.removeEventListener("mousemove", this.handleMouseMove, true);
    this.view.contentDOM.removeEventListener("dragstart", this.handleDragStart, true);
    this.view.contentDOM.removeEventListener("click", this.handleClick, true);
    this.view.contentDOM.removeEventListener("mouseleave", this.handleEditorMouseLeave);
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
    this.primaryPointerDownInEditor = false;
    this.selectionStartedOnSuggestion = false;
    this.suppressHoverUntilMove = false;
    this.close();
  }

  open(target: HTMLElement, suggestionId: string): void {
    this.openCard(suggestionId, target, "manual", target);
  }

  dismiss(): void {
    if (this.cardMode === "manual") {
      this.closeAndRestoreTrigger();
    } else {
      this.close();
    }
  }

  private openCard(
    suggestionId: string,
    reference: ReferenceElement,
    mode: SuggestionCardMode,
    trigger?: HTMLElement,
  ): void {
    const presentation = livePresentation(
      this.view.state.field(presentationField, false),
    );
    const suggestion = presentation?.snapshot.suggestions.find(
      (candidate) => candidate.id === suggestionId,
    );
    if (!presentation || !suggestion) {
      this.close();
      return;
    }

    this.close();
    this.cardMode = mode;
    this.hoverReference = mode === "hover" ? reference : undefined;
    this.manualTrigger = trigger;
    const card = renderSuggestionCard(
      this.view.dom.ownerDocument,
      suggestion,
      presentation.snapshot.appearance,
      presentation.actions,
      presentation.renderExplanation,
      () => mode === "manual" ? this.closeAndRestoreTrigger() : this.close(),
    );
    card.classList.add(
      "refine-tooltip--floating",
      `refine-tooltip--${mode}`,
    );
    card.style.left = "0px";
    card.style.top = "0px";
    card.style.visibility = "hidden";
    card.dataset.refineSuggestionId = suggestionId;
    this.element = card;
    const ownerDocument = this.view.dom.ownerDocument;
    ownerDocument.body.append(card);
    this.floatingCleanup = autoUpdate(reference, card, () => {
      void this.positionCard(reference, card);
    });
    if (mode === "hover") {
      card.addEventListener("mouseenter", this.handleCardMouseEnter);
      card.addEventListener("mouseleave", this.handleCardMouseLeave);
      card.addEventListener("focusin", this.handleCardFocusIn);
      card.addEventListener("focusout", this.handleCardFocusOut);
      ownerDocument.addEventListener("mousemove", this.handleDocumentMouseMove, true);
    } else {
      card.querySelector<HTMLElement>("button")?.focus();
    }
  }

  close(): void {
    this.cancelPendingHover();
    this.cancelHoverClose();
    this.floatingCleanup?.();
    this.floatingCleanup = undefined;
    this.view.dom.ownerDocument.removeEventListener(
      "mousemove",
      this.handleDocumentMouseMove,
      true,
    );
    if (this.element) {
      disposeSuggestionCard(this.element);
      this.element.remove();
    }
    this.element = undefined;
    this.cardMode = undefined;
    this.hoverBridge = undefined;
    this.hoverReference = undefined;
    this.manualTrigger = undefined;
  }

  private closeAndRestoreTrigger(): void {
    const trigger = this.manualTrigger;
    this.close();
    if (trigger?.isConnected) {
      trigger.focus();
    }
  }

  private async positionCard(
    reference: ReferenceElement,
    card: HTMLElement,
  ): Promise<void> {
    const { x, y, placement } = await computePosition(reference, card, {
      strategy: "fixed",
      placement: "top-end",
      middleware: [
        offset(suggestionCardGapPx),
        flip({
          padding: suggestionCardViewportGutterPx,
          fallbackPlacements: ["bottom-end"],
        }),
        shift({ padding: suggestionCardViewportGutterPx }),
      ],
    });
    if (this.element !== card) {
      return;
    }
    const ownerWindow = this.view.dom.ownerDocument.defaultView;
    card.style.left = `${roundByDevicePixelRatio(x, ownerWindow)}px`;
    card.style.top = `${roundByDevicePixelRatio(y, ownerWindow)}px`;
    card.style.visibility = "";
    card.dataset.refinePlacement = placement;
  }

  private readonly handleMouseDown = (event: MouseEvent): void => {
    this.primaryPointerDownInEditor = event.button === 0;
    this.selectionStartedOnSuggestion = false;
    if (this.primaryPointerDownInEditor) {
      // Keep hover gated until a later button-free pointer move so a quick
      // click cannot become a delayed card after mouseup.
      this.suppressHoverUntilMove = true;
    }
    this.close();
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
      this.cancelPendingHover();
      return;
    }
    this.primaryPointerDownInEditor = false;
    this.selectionStartedOnSuggestion = false;
    this.suppressHoverUntilMove = false;
    if (this.cardMode === "manual") {
      return;
    }

    const match = this.hoverMatch(event);
    if (!match) {
      this.cancelPendingHover();
      if (this.cardMode === "hover") {
        this.beginHoverClose(event, "card");
      }
      return;
    }
    if (
      this.cardMode === "hover" &&
      this.element &&
      this.element.dataset.refineSuggestionId === match.suggestion.id
    ) {
      this.cancelPendingHover();
      this.cancelHoverClose();
      this.hoverBridge = undefined;
      return;
    }
    this.scheduleHoverOpen(match);
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
    const reference = hit.trigger ??
      (hit.match ? this.rangeReference(hit.match) : pointerReference(event));
    this.openCard(
      hit.suggestionId,
      reference,
      "manual",
      hit.trigger,
    );
  };

  private suggestionHit(event: MouseEvent): SuggestionHit | undefined {
    const directTarget = suggestionTarget(event.target);
    const directSuggestionId = directTarget?.dataset.refineSuggestionId;
    if (directTarget && directSuggestionId) {
      return {
        suggestionId: directSuggestionId,
        trigger: directTarget,
      };
    }

    const match = this.hoverMatch(event);
    return match
      ? { suggestionId: match.suggestion.id, match }
      : undefined;
  }

  private hoverMatch(event: MouseEvent): SuggestionRangeMatch | undefined {
    const presentation = livePresentation(
      this.view.state.field(presentationField, false),
    );
    const position = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (!presentation || position === null) {
      return undefined;
    }
    const directTarget = suggestionTarget(event.target);
    const coordinates = this.view.coordsAtPos(position);
    if (
      !directTarget &&
      coordinates &&
      (
        event.clientY < coordinates.top ||
        event.clientY > coordinates.bottom ||
        event.clientX < coordinates.left - this.view.defaultCharacterWidth ||
        event.clientX > coordinates.right + this.view.defaultCharacterWidth
      )
    ) {
      return undefined;
    }
    return suggestionAtPosition(
      presentation.snapshot,
      position,
      pointerSide(this.view, event.clientX, coordinates),
    );
  }

  private scheduleHoverOpen(match: SuggestionRangeMatch): void {
    const presentation = livePresentation(
      this.view.state.field(presentationField, false),
    );
    const ownerWindow = this.view.dom.ownerDocument.defaultView;
    if (!presentation || !ownerWindow) {
      return;
    }
    this.cancelPendingHover();
    const candidate: HoverCandidate = {
      match,
      presentationRevision: presentation.snapshot.presentationRevision,
    };
    this.pendingHover = candidate;
    this.hoverOpenTimer = ownerWindow.setTimeout(() => {
      this.hoverOpenTimer = undefined;
      if (this.pendingHover !== candidate) {
        return;
      }
      const current = livePresentation(
        this.view.state.field(presentationField, false),
      );
      if (
        !current ||
        current.snapshot.presentationRevision !== candidate.presentationRevision ||
        this.primaryPointerDownInEditor ||
        this.suppressHoverUntilMove ||
        this.cardMode === "manual"
      ) {
        this.pendingHover = undefined;
        return;
      }
      this.openCard(
        candidate.match.suggestion.id,
        this.rangeReference(candidate.match),
        "hover",
      );
    }, suggestionHoverOpenDelayMs);
  }

  private cancelPendingHover(): void {
    const ownerWindow = this.view.dom.ownerDocument.defaultView;
    if (this.hoverOpenTimer !== undefined) {
      ownerWindow?.clearTimeout(this.hoverOpenTimer);
    }
    this.hoverOpenTimer = undefined;
    this.pendingHover = undefined;
  }

  private beginHoverClose(
    event: Pick<MouseEvent, "clientX" | "clientY">,
    target: HoverBridge["target"],
  ): void {
    if (this.cardMode !== "hover") {
      return;
    }
    const origin = { x: event.clientX, y: event.clientY };
    this.hoverBridge = { origin, previous: origin, target };
    this.scheduleHoverClose(true);
  }

  private scheduleHoverClose(reset = false): void {
    if (
      this.cardMode !== "hover" ||
      (this.element && this.element.contains(this.view.dom.ownerDocument.activeElement))
    ) {
      return;
    }
    const ownerWindow = this.view.dom.ownerDocument.defaultView;
    if (!ownerWindow || (this.hoverCloseTimer !== undefined && !reset)) {
      return;
    }
    this.cancelHoverClose();
    this.hoverCloseTimer = ownerWindow.setTimeout(() => {
      this.hoverCloseTimer = undefined;
      if (this.cardMode === "hover") {
        this.close();
      }
    }, suggestionHoverCloseDelayMs);
  }

  private cancelHoverClose(): void {
    if (this.hoverCloseTimer !== undefined) {
      this.view.dom.ownerDocument.defaultView?.clearTimeout(this.hoverCloseTimer);
    }
    this.hoverCloseTimer = undefined;
  }

  private rangeReference(match: SuggestionRangeMatch): VirtualElement {
    return {
      contextElement: this.view.contentDOM,
      getBoundingClientRect: () => {
        const coordinates = this.view.coordsAtPos(match.to, -1) ??
          this.view.coordsAtPos(match.from, 1);
        if (!coordinates) {
          return zeroClientRect();
        }
        const right = Math.max(coordinates.left, coordinates.right);
        return clientRect(
          right,
          coordinates.top,
          0,
          Math.max(0, coordinates.bottom - coordinates.top),
        );
      },
    };
  }

  private readonly handleEditorMouseLeave = (event: MouseEvent): void => {
    this.cancelPendingHover();
    if (
      this.cardMode === "hover" &&
      this.element &&
      event.relatedTarget instanceof Node &&
      this.element.contains(event.relatedTarget)
    ) {
      this.cancelHoverClose();
      return;
    }
    this.beginHoverClose(event, "card");
  };

  private readonly handleCardMouseEnter = (): void => {
    this.hoverBridge = undefined;
    this.cancelHoverClose();
  };

  private readonly handleCardMouseLeave = (event: MouseEvent): void => {
    this.beginHoverClose(event, "suggestion");
  };

  private readonly handleCardFocusIn = (): void => {
    this.hoverBridge = undefined;
    this.cancelHoverClose();
  };

  private readonly handleCardFocusOut = (event: FocusEvent): void => {
    if (
      this.element &&
      event.relatedTarget instanceof Node &&
      this.element.contains(event.relatedTarget)
    ) {
      return;
    }
    this.scheduleHoverClose(true);
  };

  private readonly handleDocumentMouseMove = (event: MouseEvent): void => {
    if (this.cardMode !== "hover" || !this.element) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && this.element.contains(target)) {
      this.hoverBridge = undefined;
      this.cancelHoverClose();
      return;
    }
    if (target instanceof Node && this.view.contentDOM.contains(target)) {
      return;
    }
    if (!this.hoverBridge) {
      this.scheduleHoverClose();
      return;
    }
    const point = { x: event.clientX, y: event.clientY };
    const bridge = this.hoverBridge;
    const targetBounds = bridge.target === "card"
      ? this.element.getBoundingClientRect()
      : this.hoverReference?.getBoundingClientRect();
    const safelyBridging = targetBounds && pointerWithinSafeBridge(
      point,
      bridge.previous,
      bridge.origin,
      targetBounds,
    );
    bridge.previous = point;
    this.scheduleHoverClose(Boolean(safelyBridging));
  };
}

const presentationPopover = ViewPlugin.fromClass(PresentationPopover, {
  eventHandlers: {
    keydown(event): boolean {
      if (
        event.key === "Escape" &&
        this.hasCard
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

export function refinePresentationExtension(_ownerDocument: Document): Extension {
  return [
    presentationField,
    presentationPopover,
  ];
}

export function installPresentation(
  view: EditorView,
  snapshot: PresentationSnapshot,
  actions: SuggestionActions,
  renderExplanation: ExplanationRenderer = plainExplanationRenderer,
): void {
  view.dispatch({
    effects: replacePresentation.of({
      type: "live",
      snapshot,
      actions,
      renderExplanation,
      decorations: buildDecorations(view, snapshot),
    }),
  });
}

export function clearPresentation(view: EditorView): void {
  view.dispatch({ effects: replacePresentation.of(undefined) });
}

export function clearLivePresentationPreservingProvisional(
  view: EditorView,
): void {
  view.dispatch({ effects: clearLivePresentationEffect.of(null) });
}

function pointerSide(
  view: EditorView,
  pointerX: number,
  coordinates: { readonly left: number; readonly right: number } | null,
): -1 | 1 {
  if (!coordinates) {
    return 1;
  }
  const before = pointerX < (coordinates.left + coordinates.right) / 2;
  const leftToRight = view.textDirection === Direction.LTR;
  return before
    ? leftToRight ? -1 : 1
    : leftToRight ? 1 : -1;
}

function pointerReference(point: Pick<MouseEvent, "clientX" | "clientY">): VirtualElement {
  const bounds = clientRect(point.clientX, point.clientY, 0, 0);
  return { getBoundingClientRect: () => bounds };
}

function clientRect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return new DOMRect(left, top, width, height);
}

function zeroClientRect(): DOMRect {
  return clientRect(0, 0, 0, 0);
}

function roundByDevicePixelRatio(value: number, ownerWindow: Window | null): number {
  const ratio = ownerWindow?.devicePixelRatio || 1;
  return Math.round(value * ratio) / ratio;
}

function pointerWithinSafeBridge(
  point: PointerPoint,
  previous: PointerPoint,
  origin: PointerPoint,
  target: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
): boolean {
  const expanded = {
    left: target.left - suggestionHoverBridgeBufferPx,
    right: target.right + suggestionHoverBridgeBufferPx,
    top: target.top - suggestionHoverBridgeBufferPx,
    bottom: target.bottom + suggestionHoverBridgeBufferPx,
  };
  if (pointInsideRect(point, expanded)) {
    return true;
  }
  const [edgeStart, edgeEnd] = bridgeTargetEdge(origin, expanded);
  return pointInsideTriangle(point, origin, edgeStart, edgeEnd) &&
    distanceToRect(point, expanded) <= distanceToRect(previous, expanded) + 0.5;
}

function bridgeTargetEdge(
  origin: PointerPoint,
  target: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
): readonly [PointerPoint, PointerPoint] {
  if (origin.y >= target.bottom) {
    return [
      { x: target.left, y: target.bottom },
      { x: target.right, y: target.bottom },
    ];
  }
  if (origin.y <= target.top) {
    return [
      { x: target.left, y: target.top },
      { x: target.right, y: target.top },
    ];
  }
  if (origin.x <= target.left) {
    return [
      { x: target.left, y: target.top },
      { x: target.left, y: target.bottom },
    ];
  }
  return [
    { x: target.right, y: target.top },
    { x: target.right, y: target.bottom },
  ];
}

function pointInsideRect(
  point: PointerPoint,
  rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
): boolean {
  return point.x >= rect.left && point.x <= rect.right &&
    point.y >= rect.top && point.y <= rect.bottom;
}

function pointInsideTriangle(
  point: PointerPoint,
  first: PointerPoint,
  second: PointerPoint,
  third: PointerPoint,
): boolean {
  const firstSign = triangleSign(point, first, second);
  const secondSign = triangleSign(point, second, third);
  const thirdSign = triangleSign(point, third, first);
  const hasNegative = firstSign < 0 || secondSign < 0 || thirdSign < 0;
  const hasPositive = firstSign > 0 || secondSign > 0 || thirdSign > 0;
  return !(hasNegative && hasPositive);
}

function triangleSign(
  point: PointerPoint,
  first: PointerPoint,
  second: PointerPoint,
): number {
  return (point.x - second.x) * (first.y - second.y) -
    (first.x - second.x) * (point.y - second.y);
}

function distanceToRect(
  point: PointerPoint,
  rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
): number {
  const deltaX = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const deltaY = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
  return Math.hypot(deltaX, deltaY);
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

function buildProvisionalDecorations(
  documentLength: number,
  suggestions: readonly ProvisionalSuggestion[],
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const suggestion of suggestions) {
    for (const range of suggestion.highlightRanges) {
      const from = range.location;
      const to = from + range.length;
      if (from < 0 || to < from || to > documentLength) {
        continue;
      }
      if (range.length === 0) {
        ranges.push(
          Decoration.widget({
            side: 1,
            widget: new InsertionAnchorWidget(
              undefined,
              suggestion.style,
              suggestion.color,
            ),
          }).range(from),
        );
      } else {
        ranges.push(
          Decoration.mark({
            attributes: {
              style: [
                "--no-tooltip: true",
                `--refine-suggestion-color: ${suggestion.color}`,
              ].join("; "),
            },
            class:
              `refine-suggestion refine-suggestion--${suggestion.style} ` +
              "refine-suggestion--provisional",
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

function suggestionTarget(target: EventTarget | null): HTMLElement | undefined {
  const candidate = target as { closest?: (selector: string) => Element | null } | null;
  return (candidate?.closest?.("[data-refine-suggestion-id]") as HTMLElement | null) ??
    undefined;
}
