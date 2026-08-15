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
  type EditorSelection,
  StateEffect,
  StateField,
  type ChangeDesc,
  type Extension,
  type Range,
  type Transaction,
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
import {
  bestQuickApplySuggestion,
  isQuickApplyCandidate,
  matchesSuggestionActionKey,
  suggestionActionKeyLabel,
} from "./quick-apply";

export type { ExplanationRenderer } from "./suggestion-card";

interface LivePresentationInput {
  readonly type: "live";
  readonly snapshot: PresentationSnapshot;
  readonly actions: SuggestionActions;
  readonly renderExplanation: ExplanationRenderer;
}

interface InstalledPresentation extends LivePresentationInput {
  readonly decorations: DecorationSet;
  readonly activeQuickApplySuggestionId: string | undefined;
  readonly canAutoActivateQuickApply: boolean;
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

interface ManualSuggestionTrigger {
  readonly element: HTMLElement;
  readonly suggestionId: string;
  readonly position: number | undefined;
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

const replacePresentation = StateEffect.define<LivePresentationInput | undefined>();
const clearLivePresentationEffect = StateEffect.define<null>();
const clearQuickApplyActivationEffect = StateEffect.define<null>();

const presentationField = StateField.define<PresentationState | undefined>({
  create: () => undefined,
  update(value, transaction) {
    const documentTextChanged = transaction.docChanged &&
      !transaction.startState.doc.eq(transaction.newDoc);
    let next = documentTextChanged
      ? provisionalPresentation(value, transaction.changes)
      : value;
    if (!documentTextChanged && transaction.selection !== undefined) {
      next = selectionUpdatedPresentation(next, transaction);
    }
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
            : effect.value === undefined
              ? undefined
              : installedPresentation(
                  effect.value,
                  livePresentation(next),
                  transaction.newSelection,
                  transaction.newDoc.length,
                );
      } else if (
        effect.is(clearLivePresentationEffect) &&
        next?.type === "live"
      ) {
        next = undefined;
      } else if (
        effect.is(clearQuickApplyActivationEffect) &&
        next?.type === "live" &&
        next.activeQuickApplySuggestionId !== undefined
      ) {
        next = presentationWithQuickApply(
          next,
          undefined,
          false,
          transaction.newDoc.length,
        );
      }
    }
    return next;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value?.decorations ?? Decoration.none),
});

function installedPresentation(
  input: LivePresentationInput,
  previous: InstalledPresentation | undefined,
  selection: EditorSelection,
  documentLength: number,
): InstalledPresentation {
  const sameCheckGeneration =
    previous?.snapshot.documentRevision === input.snapshot.documentRevision &&
    previous.snapshot.checkGeneration === input.snapshot.checkGeneration;
  let canAutoActivate = sameCheckGeneration
    ? previous?.canAutoActivateQuickApply ?? false
    : input.snapshot.interaction.quickApply.enabled;
  let activeSuggestionId: string | undefined;

  if (input.snapshot.interaction.quickApply.enabled) {
    const previousActive = sameCheckGeneration
      ? previous?.activeQuickApplySuggestionId
      : undefined;
    const previousSuggestion = previousActive === undefined
      ? undefined
      : input.snapshot.suggestions.find((suggestion) =>
          suggestion.id === previousActive &&
          isQuickApplyCandidate(selection, suggestion)
        );
    if (previousSuggestion) {
      activeSuggestionId = previousSuggestion.id;
      canAutoActivate = false;
    } else if (canAutoActivate) {
      const candidate = bestQuickApplySuggestion(
        selection,
        input.snapshot.suggestions,
      );
      activeSuggestionId = candidate?.id;
      canAutoActivate = candidate === undefined;
    }
  } else {
    canAutoActivate = false;
  }

  return {
    ...input,
    activeQuickApplySuggestionId: activeSuggestionId,
    canAutoActivateQuickApply: canAutoActivate,
    decorations: buildDecorations(
      documentLength,
      input.snapshot,
      activeSuggestionId,
    ),
  };
}

function selectionUpdatedPresentation(
  presentation: PresentationState | undefined,
  transaction: Transaction,
): PresentationState | undefined {
  if (presentation?.type !== "live") {
    return presentation;
  }
  if (
    transaction.isUserEvent("select.pointer") ||
    !presentation.snapshot.interaction.quickApply.enabled
  ) {
    return presentationWithQuickApply(
      presentation,
      undefined,
      false,
      transaction.newDoc.length,
    );
  }
  const candidate = bestQuickApplySuggestion(
    transaction.newSelection,
    presentation.snapshot.suggestions,
  );
  return presentationWithQuickApply(
    presentation,
    candidate?.id,
    candidate === undefined &&
      transaction.newSelection.ranges.length === 1 &&
      transaction.newSelection.main.empty,
    transaction.newDoc.length,
  );
}

function presentationWithQuickApply(
  presentation: InstalledPresentation,
  activeSuggestionId: string | undefined,
  canAutoActivate: boolean,
  documentLength: number,
): InstalledPresentation {
  if (
    presentation.activeQuickApplySuggestionId === activeSuggestionId &&
    presentation.canAutoActivateQuickApply === canAutoActivate
  ) {
    return presentation;
  }
  return {
    ...presentation,
    activeQuickApplySuggestionId: activeSuggestionId,
    canAutoActivateQuickApply: canAutoActivate,
    decorations: buildDecorations(
      documentLength,
      presentation.snapshot,
      activeSuggestionId,
    ),
  };
}

class InsertionAnchorWidget extends WidgetType {
  constructor(
    private readonly suggestionId: string | undefined,
    private readonly style: PresentationAppearance["highlight"]["style"],
    private readonly color: string,
    private readonly isQuickApplyActive = false,
  ) {
    super();
  }

  eq(other: InsertionAnchorWidget): boolean {
    return (
      other.suggestionId === this.suggestionId &&
      other.style === this.style &&
      other.color === this.color &&
      other.isQuickApplyActive === this.isQuickApplyActive
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
      if (this.isQuickApplyActive) {
        anchor.classList.add("refine-insertion-anchor--quick-apply-active");
      }
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

class PresentationInteractionController implements PluginValue {
  private element: HTMLElement | undefined;
  private cardEngaged = false;
  private cardMode: SuggestionCardMode | undefined;
  private floatingCleanup: (() => void) | undefined;
  private hoverBridge: HoverBridge | undefined;
  private hoverCloseTimer: number | undefined;
  private hoverOpenTimer: number | undefined;
  private hoverReference: ReferenceElement | undefined;
  private manualTrigger: ManualSuggestionTrigger | undefined;
  private pendingHover: HoverCandidate | undefined;
  private pointerInsideCard = false;
  private primaryPointerDownInEditor = false;
  private quickApplyTip: HTMLElement | undefined;
  private quickApplyTipCleanup: (() => void) | undefined;
  private quickApplyTipIdentity: string | undefined;
  private selectionStartedOnSuggestion = false;
  private suppressHoverUntilMove = false;

  constructor(private readonly view: EditorView) {
    view.dom.addEventListener("keydown", this.handleQuickApplyKeyDown, true);
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
    this.syncQuickApplyTip();
  }

  destroy(): void {
    this.view.dom.removeEventListener("keydown", this.handleQuickApplyKeyDown, true);
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
    this.close(false);
    this.closeQuickApplyTip();
  }

  open(target: HTMLElement, suggestionId: string): void {
    const match = this.suggestionMatchForTarget(target, suggestionId);
    const needsDurableReference = target.classList.contains(
      "refine-insertion-anchor--quick-apply-active",
    );
    this.openCard(
      suggestionId,
      needsDurableReference && match ? this.rangeReference(match) : target,
      "manual",
      this.manualSuggestionTrigger(target, suggestionId, match),
    );
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
    trigger?: ManualSuggestionTrigger,
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

    this.clearQuickApplyActivation();
    this.close(false);
    this.closeQuickApplyTip();
    this.cardMode = mode;
    this.cardEngaged = false;
    this.pointerInsideCard = false;
    this.hoverReference = mode === "hover" ? reference : undefined;
    this.manualTrigger = trigger;
    let card: HTMLElement | undefined;
    card = renderSuggestionCard(
      this.view.dom.ownerDocument,
      suggestion,
      presentation.snapshot.appearance,
      presentation.actions,
      presentation.renderExplanation,
      {
        close: () => {
          if (!card || this.element !== card) {
            return;
          }
          mode === "manual" ? this.closeAndRestoreTrigger() : this.close();
        },
        engage: () => {
          if (card) {
            this.engageCard(card);
          }
        },
      },
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

  close(restoreEditorFocus = true): void {
    const shouldRestoreEditorFocus =
      restoreEditorFocus &&
      this.element?.contains(this.view.dom.ownerDocument.activeElement) === true;
    this.cancelPendingHover();
    this.cancelHoverClose();
    this.floatingCleanup?.();
    this.floatingCleanup = undefined;
    this.view.dom.ownerDocument.removeEventListener(
      "mousemove",
      this.handleDocumentMouseMove,
      true,
    );
    this.view.dom.ownerDocument.removeEventListener(
      "mousedown",
      this.handleEngagedOutsideMouseDown,
      true,
    );
    if (this.element) {
      disposeSuggestionCard(this.element);
      this.element.remove();
    }
    this.element = undefined;
    this.cardEngaged = false;
    this.cardMode = undefined;
    this.hoverBridge = undefined;
    this.hoverReference = undefined;
    this.manualTrigger = undefined;
    this.pointerInsideCard = false;
    if (shouldRestoreEditorFocus && this.view.dom.isConnected) {
      this.view.focus();
    }
  }

  private engageCard(card: HTMLElement): void {
    if (
      this.element !== card ||
      this.cardMode !== "hover" ||
      this.cardEngaged ||
      !this.element
    ) {
      return;
    }
    this.cardEngaged = true;
    this.element.classList.add("refine-tooltip--engaged");
    this.hoverBridge = undefined;
    this.cancelPendingHover();
    this.cancelHoverClose();
    this.view.dom.ownerDocument.addEventListener(
      "mousedown",
      this.handleEngagedOutsideMouseDown,
      true,
    );
  }

  private closeAndRestoreTrigger(): void {
    const trigger = this.manualTrigger;
    this.close(false);
    const liveTrigger = trigger && this.resolveManualSuggestionTrigger(trigger);
    if (liveTrigger) {
      liveTrigger.focus();
    } else if (this.view.dom.isConnected) {
      this.view.focus();
    }
  }

  private manualSuggestionTrigger(
    element: HTMLElement,
    suggestionId: string,
    match?: SuggestionRangeMatch,
  ): ManualSuggestionTrigger {
    return {
      element,
      suggestionId,
      position: match?.from,
    };
  }

  private resolveManualSuggestionTrigger(
    trigger: ManualSuggestionTrigger,
  ): HTMLElement | undefined {
    if (trigger.element.isConnected) {
      return trigger.element;
    }
    return [...this.view.contentDOM.querySelectorAll<HTMLElement>(
      "[data-refine-suggestion-id]",
    )].find((candidate) => {
      if (candidate.dataset.refineSuggestionId !== trigger.suggestionId) {
        return false;
      }
      if (trigger.position === undefined) {
        return true;
      }
      try {
        return this.view.posAtDOM(candidate, 0) === trigger.position;
      } catch {
        return false;
      }
    });
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

  private readonly handleQuickApplyKeyDown = (event: KeyboardEvent): void => {
    // Cursor Quick Apply owns only keystrokes directed at CodeMirror's editing
    // surface. Focused marks, Live Preview links, and editor widgets retain
    // their own keyboard behavior even when the caret is inside an active scope.
    if (event.target !== this.view.contentDOM) {
      return;
    }
    const presentation = livePresentation(
      this.view.state.field(presentationField, false),
    );
    const suggestionId = presentation?.activeQuickApplySuggestionId;
    const configuration = presentation?.snapshot.interaction.quickApply;
    if (!presentation || !suggestionId || !configuration?.enabled) {
      return;
    }

    if (matchesSuggestionActionKey(event, configuration.dismissKey)) {
      this.consumeQuickApplyKey(event);
      this.clearQuickApplyActivation();
      return;
    }
    if (!matchesSuggestionActionKey(event, configuration.applyKey)) {
      return;
    }
    const suggestion = presentation.snapshot.suggestions.find((candidate) =>
      candidate.id === suggestionId &&
      candidate.sourceId === "document" &&
      candidate.availableActions.includes("apply")
    );
    if (!suggestion) {
      return;
    }

    this.consumeQuickApplyKey(event);
    this.clearQuickApplyActivation();
    void presentation.actions.apply(suggestion.id).catch(() => undefined);
  };

  private consumeQuickApplyKey(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private clearQuickApplyActivation(): void {
    const presentation = livePresentation(
      this.view.state.field(presentationField, false),
    );
    if (presentation?.activeQuickApplySuggestionId === undefined) {
      return;
    }
    this.view.dispatch({ effects: clearQuickApplyActivationEffect.of(null) });
  }

  private syncQuickApplyTip(): void {
    const presentation = livePresentation(
      this.view.state.field(presentationField, false),
    );
    const suggestionId = presentation?.activeQuickApplySuggestionId;
    const configuration = presentation?.snapshot.interaction.quickApply;
    if (
      this.element ||
      !presentation ||
      !suggestionId ||
      !configuration?.enabled ||
      configuration.activationStyle !== "showTipAndHighlight"
    ) {
      this.closeQuickApplyTip();
      return;
    }
    const suggestion = presentation.snapshot.suggestions.find(
      (candidate) => candidate.id === suggestionId,
    );
    if (!suggestion) {
      this.closeQuickApplyTip();
      return;
    }
    const cursor = this.view.state.selection.main.head;
    const identity = [
      presentation.snapshot.presentationRevision,
      suggestionId,
      configuration.applyKey,
      cursor,
    ].join(":");
    if (this.quickApplyTipIdentity === identity && this.quickApplyTip) {
      return;
    }

    this.closeQuickApplyTip();
    const label = suggestionActionKeyLabel(configuration.applyKey);
    const tip = this.view.dom.ownerDocument.createElement("div");
    tip.className = "refine-quick-apply-tip";
    tip.textContent = `Press ${label} to apply`;
    tip.setAttribute("aria-hidden", "true");
    tip.style.left = "0px";
    tip.style.top = "0px";
    tip.style.visibility = "hidden";
    this.view.dom.ownerDocument.body.append(tip);
    this.quickApplyTip = tip;
    this.quickApplyTipIdentity = identity;
    const target = quickApplyTipTarget(suggestion, cursor);
    const rangeReference = this.rangeReference({
      suggestion,
      from: target.location,
      to: target.location + target.length,
    });
    const reference: VirtualElement = {
      contextElement: rangeReference.contextElement,
      getBoundingClientRect: () => {
        try {
          return rangeReference.getBoundingClientRect();
        } catch {
          // Non-layout DOMs and a closing editor may not expose text geometry.
          // Keep the transient tip inert without affecting Quick Apply itself.
          return zeroClientRect();
        }
      },
    };
    this.quickApplyTipCleanup = autoUpdate(reference, tip, () => {
      void this.positionQuickApplyTip(reference, tip);
    });
  }

  private closeQuickApplyTip(): void {
    this.quickApplyTipCleanup?.();
    this.quickApplyTipCleanup = undefined;
    this.quickApplyTip?.remove();
    this.quickApplyTip = undefined;
    this.quickApplyTipIdentity = undefined;
  }

  private async positionQuickApplyTip(
    reference: ReferenceElement,
    tip: HTMLElement,
  ): Promise<void> {
    // `autoUpdate` may already have queued one last measurement when the
    // presentation or editor is torn down. Avoid asking CodeMirror for DOM
    // geometry after that reference stops belonging to this popover.
    if (this.quickApplyTip !== tip) {
      return;
    }
    const { x, y, placement } = await computePosition(reference, tip, {
      strategy: "fixed",
      placement: "bottom-end",
      middleware: [
        offset(suggestionCardGapPx),
        flip({
          padding: suggestionCardViewportGutterPx,
          fallbackPlacements: ["top-end"],
        }),
        shift({ padding: suggestionCardViewportGutterPx }),
      ],
    });
    if (this.quickApplyTip !== tip) {
      return;
    }
    const ownerWindow = this.view.dom.ownerDocument.defaultView;
    tip.style.left = `${roundByDevicePixelRatio(x, ownerWindow)}px`;
    tip.style.top = `${roundByDevicePixelRatio(y, ownerWindow)}px`;
    tip.style.visibility = "";
    tip.dataset.refinePlacement = placement;
  }

  private readonly handleMouseDown = (event: MouseEvent): void => {
    this.primaryPointerDownInEditor = event.button === 0;
    this.selectionStartedOnSuggestion = false;
    if (this.primaryPointerDownInEditor) {
      // Keep hover gated until a later button-free pointer move so a quick
      // click cannot become a delayed card after mouseup.
      this.suppressHoverUntilMove = true;
      this.clearQuickApplyActivation();
    }
    this.close(false);
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
    if (
      this.cardMode === "manual" ||
      this.cardEngaged ||
      this.cardContainsFocus()
    ) {
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
    this.clearQuickApplyActivation();
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
    this.clearQuickApplyActivation();
    this.close(false);
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
      hit.trigger
        ? this.manualSuggestionTrigger(
            hit.trigger,
            hit.suggestionId,
            hit.match,
          )
        : undefined,
    );
  };

  private suggestionHit(event: MouseEvent): SuggestionHit | undefined {
    const directTarget = suggestionTarget(event.target);
    const directSuggestionId = directTarget?.dataset.refineSuggestionId;
    if (directTarget && directSuggestionId) {
      const match = this.suggestionMatchForTarget(
        directTarget,
        directSuggestionId,
      );
      return match ? {
        suggestionId: directSuggestionId,
        match,
        trigger: directTarget,
      } : {
        suggestionId: directSuggestionId,
        trigger: directTarget,
      };
    }

    const match = this.hoverMatch(event);
    return match
      ? { suggestionId: match.suggestion.id, match }
      : undefined;
  }

  private suggestionMatchForTarget(
    target: HTMLElement,
    suggestionId: string,
  ): SuggestionRangeMatch | undefined {
    const presentation = livePresentation(
      this.view.state.field(presentationField, false),
    );
    const suggestion = presentation?.snapshot.suggestions.find(
      (candidate) => candidate.id === suggestionId,
    );
    if (!suggestion || suggestion.sourceId !== "document") {
      return undefined;
    }
    let position: number;
    try {
      position = this.view.posAtDOM(target, 0);
    } catch {
      return undefined;
    }
    const range = suggestion.highlightRanges.find(
      (candidate) => candidate.location === position,
    ) ?? suggestion.highlightRanges.find(
      (candidate) =>
        position >= candidate.location &&
        position <= candidate.location + candidate.length,
    );
    return range
      ? {
          suggestion,
          from: range.location,
          to: range.location + range.length,
        }
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
    if (!presentation || !ownerWindow || this.cardContainsFocus()) {
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
        this.cardEngaged ||
        this.cardContainsFocus() ||
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
    if (this.cardMode !== "hover" || this.cardEngaged) {
      return;
    }
    const origin = { x: event.clientX, y: event.clientY };
    this.hoverBridge = { origin, previous: origin, target };
    this.scheduleHoverClose(true);
  }

  private scheduleHoverClose(reset = false): void {
    if (!this.canCloseHoverCard()) {
      return;
    }
    const ownerWindow = this.view.dom.ownerDocument.defaultView;
    if (!ownerWindow || (this.hoverCloseTimer !== undefined && !reset)) {
      return;
    }
    this.cancelHoverClose();
    this.hoverCloseTimer = ownerWindow.setTimeout(() => {
      this.hoverCloseTimer = undefined;
      if (this.canCloseHoverCard()) {
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

  private canCloseHoverCard(): boolean {
    return (
      this.cardMode === "hover" &&
      !this.cardEngaged &&
      !this.pointerInsideCard &&
      !this.cardContainsFocus()
    );
  }

  private cardContainsFocus(): boolean {
    return this.element?.contains(this.view.dom.ownerDocument.activeElement) === true;
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
      this.pointerInsideCard = true;
      this.cancelHoverClose();
      return;
    }
    this.pointerInsideCard = false;
    this.beginHoverClose(event, "card");
  };

  private readonly handleCardMouseEnter = (): void => {
    this.pointerInsideCard = true;
    this.hoverBridge = undefined;
    this.cancelHoverClose();
  };

  private readonly handleCardMouseLeave = (event: MouseEvent): void => {
    this.pointerInsideCard = false;
    this.beginHoverClose(event, "suggestion");
  };

  private readonly handleCardFocusIn = (): void => {
    this.hoverBridge = undefined;
    this.cancelPendingHover();
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
    if (this.cardMode !== "hover" || this.cardEngaged || !this.element) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && this.element.contains(target)) {
      this.pointerInsideCard = true;
      this.hoverBridge = undefined;
      this.cancelHoverClose();
      return;
    }
    this.pointerInsideCard = false;
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

  private readonly handleEngagedOutsideMouseDown = (event: MouseEvent): void => {
    if (
      !this.cardEngaged ||
      !this.element ||
      !(event.target instanceof Node) ||
      this.element.contains(event.target)
    ) {
      return;
    }
    this.close();
  };
}

const presentationInteraction = ViewPlugin.fromClass(
  PresentationInteractionController,
  {
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
  },
);

export function refinePresentationExtension(_ownerDocument: Document): Extension {
  return [
    presentationField,
    presentationInteraction,
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

function quickApplyTipTarget(
  suggestion: PresentedSuggestion,
  cursor: number,
): { readonly location: number; readonly length: number } {
  return [...suggestion.highlightRanges].sort((left, right) => {
    const distance = distanceFromRange(cursor, left) -
      distanceFromRange(cursor, right);
    if (distance !== 0) {
      return distance;
    }
    if (left.length !== right.length) {
      return left.length - right.length;
    }
    return left.location - right.location;
  })[0] ?? { location: cursor, length: 0 };
}

function distanceFromRange(
  cursor: number,
  range: { readonly location: number; readonly length: number },
): number {
  const end = range.location + range.length;
  return cursor < range.location
    ? range.location - cursor
    : cursor > end
      ? cursor - end
      : 0;
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
  documentLength: number,
  snapshot: PresentationSnapshot,
  activeQuickApplySuggestionId?: string,
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
      if (from < 0 || to < from || to > documentLength) {
        continue;
      }
      const isQuickApplyActive =
        suggestion.id === activeQuickApplySuggestionId;
      if (range.length === 0) {
        ranges.push(
          Decoration.widget({
            side: 1,
            widget: new InsertionAnchorWidget(
              suggestion.id,
              style,
              color,
              isQuickApplyActive,
            ),
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
              ].join("; "),
              tabindex: "0",
            },
            class: [
              "refine-suggestion",
              `refine-suggestion--${style}`,
              isQuickApplyActive
                ? "refine-suggestion--quick-apply-active"
                : "",
            ].filter(Boolean).join(" "),
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
