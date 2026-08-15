import type {
  ExplanationUpdate,
  PresentedSuggestion,
  PresentationAppearance,
  SuggestionActionKind,
  SuggestionActions,
} from "../integration/types";

export type ExplanationRenderer = (
  markdown: string,
  element: HTMLElement,
) => void | (() => void);

export const plainExplanationRenderer: ExplanationRenderer = (
  markdown,
  element,
) => {
  const content = element.ownerDocument.createElement("div");
  content.className = "refine-tooltip__explanation-plain";
  content.textContent = markdown;
  element.replaceChildren(content);
};

const cardCleanup = new WeakMap<HTMLElement, () => void>();
const cardClose = new WeakMap<HTMLElement, () => void>();
const cardApplyControl = new WeakMap<HTMLElement, HTMLButtonElement>();
let suggestionCardLabelSequence = 0;
let suggestionExplanationLabelSequence = 0;

interface SuggestionCardLifecycle {
  readonly close: () => void;
  readonly engage: () => void;
}

export interface SuggestionCardBinding {
  readonly suggestion: PresentedSuggestion;
  readonly appearance: PresentationAppearance;
  readonly actions: SuggestionActions;
  readonly renderExplanation: ExplanationRenderer;
  readonly lifecycle: SuggestionCardLifecycle;
}

export function renderSuggestionCard(
  ownerDocument: Document,
  binding: SuggestionCardBinding,
): HTMLElement {
  const card = createSuggestionCardShell(ownerDocument, binding.appearance);
  bindSuggestionCard(card, binding);
  return card;
}

export function rebindSuggestionCard(
  card: HTMLElement,
  binding: SuggestionCardBinding,
): void {
  disposeSuggestionCard(card);
  applySuggestionCardAppearance(card, binding.appearance);
  bindSuggestionCard(card, binding);
}

export function suggestionCardApplyControl(
  card: HTMLElement,
): HTMLButtonElement | undefined {
  return cardApplyControl.get(card);
}

function bindSuggestionCard(
  card: HTMLElement,
  binding: SuggestionCardBinding,
): void {
  const {
    suggestion,
    appearance,
    actions,
    renderExplanation,
    lifecycle,
  } = binding;
  cardClose.set(card, lifecycle.close);
  const ownerDocument = card.ownerDocument;
  const label = card.querySelector<HTMLElement>(
    ".refine-tooltip__accessible-label",
  );
  const header = renderSuggestionHeader(ownerDocument, suggestion);
  const explanation = new SuggestionExplanationController(
    ownerDocument,
    suggestion,
    actions,
    renderExplanation,
    header.model,
    lifecycle.engage,
  );
  const feedback = new SuggestionActionFeedback(ownerDocument);
  const report = new SuggestionReportController(
    suggestion,
    actions,
    feedback,
    lifecycle.engage,
  );

  if (explanation.button) {
    header.element.append(explanation.button);
  }
  const actionRow = renderSuggestionActions(
    ownerDocument,
    suggestion,
    actions,
    report,
    feedback,
    lifecycle.engage,
    lifecycle.close,
  );
  const apply = actionRow.querySelector<HTMLButtonElement>(
    ':scope > button[data-refine-action="apply"]',
  );
  if (apply) {
    cardApplyControl.set(card, apply);
  } else {
    cardApplyControl.delete(card);
  }
  card.replaceChildren(...(label ? [label] : []));
  card.append(
    header.element,
    renderSuggestionDiff(ownerDocument, suggestion, appearance),
    explanation.section,
    feedback.element,
    actionRow,
  );
  cardCleanup.set(card, () => {
    explanation.dispose();
    report.dispose();
  });
}

export function disposeSuggestionCard(card: HTMLElement): void {
  cardCleanup.get(card)?.();
  cardCleanup.delete(card);
  cardClose.delete(card);
  cardApplyControl.delete(card);
}

function createSuggestionCardShell(
  ownerDocument: Document,
  appearance: PresentationAppearance,
): HTMLElement {
  const card = ownerDocument.createElement("div");
  card.className = "refine-tooltip";
  card.setAttribute("role", "dialog");
  card.tabIndex = -1;
  card.style.setProperty("--no-tooltip", "true");
  applySuggestionCardAppearance(card, appearance);
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
    cardClose.get(card)?.();
  });
  return card;
}

function applySuggestionCardAppearance(
  card: HTMLElement,
  appearance: PresentationAppearance,
): void {
  card.style.setProperty("--refine-addition-color", appearance.diff.additionColor);
  card.style.setProperty("--refine-deletion-color", appearance.diff.deletionColor);
}

interface SuggestionCardHeader {
  readonly element: HTMLElement;
  readonly model: HTMLElement;
}

function renderSuggestionHeader(
  ownerDocument: Document,
  suggestion: PresentedSuggestion,
): SuggestionCardHeader {
  const header = ownerDocument.createElement("div");
  header.className = "refine-tooltip__header";
  const title = ownerDocument.createElement("span");
  title.className = "refine-tooltip__caption";
  title.textContent = `${suggestionKindLabel(suggestion.kind)} - ${suggestion.attribution.languageDisplayName}`;
  header.append(title);
  const headerDetail = ownerDocument.createElement("span");
  headerDetail.className = "refine-tooltip__caption refine-tooltip__model";
  header.append(headerDetail);
  return { element: header, model: headerDetail };
}

function renderSuggestionDiff(
  ownerDocument: Document,
  suggestion: PresentedSuggestion,
  appearance: PresentationAppearance,
): HTMLElement {
  const diff = ownerDocument.createElement("div");
  diff.className = "refine-tooltip__diff";
  diff.dir = suggestion.attribution.textDirection;
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
  return diff;
}

class SuggestionExplanationController {
  readonly section: HTMLElement;
  readonly button: HTMLButtonElement | undefined;

  private readonly explanation: HTMLElement;
  private readonly title: HTMLElement;
  private readonly model: HTMLElement;
  private readonly status: HTMLElement;
  private activeExplanation:
    | {
        readonly iterator: AsyncIterator<ExplanationUpdate>;
        readonly cancelled: Promise<"cancelled">;
        readonly cancel: () => void;
      }
    | undefined;
  private explanationCleanup: (() => void) | undefined;
  private disposed = false;

  constructor(
    ownerDocument: Document,
    private readonly suggestion: PresentedSuggestion,
    private readonly actions: SuggestionActions,
    private readonly renderExplanation: ExplanationRenderer,
    private readonly checkModel: HTMLElement,
    private readonly engageCard: () => void,
  ) {
    this.section = ownerDocument.createElement("section");
    this.section.className = "refine-tooltip__explanation-section";
    this.section.hidden = true;
    this.section.tabIndex = -1;

    const header = ownerDocument.createElement("div");
    header.className = "refine-tooltip__header";
    this.title = ownerDocument.createElement("span");
    this.title.className = "refine-tooltip__caption";
    this.title.id =
      `refine-tooltip-explanation-label-${++suggestionExplanationLabelSequence}`;
    this.model = ownerDocument.createElement("span");
    this.model.className = "refine-tooltip__caption refine-tooltip__model";
    header.append(this.title, this.model);

    this.explanation = ownerDocument.createElement("div");
    this.explanation.className = "refine-tooltip__explanation";
    this.status = ownerDocument.createElement("div");
    this.status.className = "refine-tooltip__status";
    this.section.append(header, this.explanation, this.status);

    if (suggestion.availableActions.includes("explain")) {
      this.button = actionButton(ownerDocument, "explain", (button) =>
        this.explain(button),
      );
      this.button.classList.add("refine-tooltip__explain");
    }
  }

  dispose(): void {
    this.disposed = true;
    this.terminateActiveExplanation();
    this.explanationCleanup?.();
    this.explanationCleanup = undefined;
  }

  private renderText(text: string): void {
    this.explanationCleanup?.();
    this.explanationCleanup = undefined;
    this.explanation.replaceChildren();
    if (text.trim().length > 0) {
      this.explanation.tabIndex = 0;
      this.explanation.setAttribute("role", "region");
      this.explanation.setAttribute("aria-labelledby", this.title.id);
    } else {
      this.explanation.removeAttribute("tabindex");
      this.explanation.removeAttribute("role");
      this.explanation.removeAttribute("aria-labelledby");
    }
    this.explanationCleanup =
      this.renderExplanation(text, this.explanation) || undefined;
  }

  private async explain(button: HTMLButtonElement): Promise<void> {
    if (this.disposed || this.activeExplanation) {
      return;
    }
    this.engageCard();
    setAriaBusy(button, true);
    button.textContent = "Explaining…";
    this.status.textContent = "Explaining…";
    const iterator = this.actions.explain(this.suggestion.id)[Symbol.asyncIterator]();
    let cancel: (() => void) | undefined;
    const cancelled = new Promise<"cancelled">((resolve) => {
      cancel = () => resolve("cancelled");
    });
    const active = {
      iterator,
      cancelled,
      cancel: () => cancel?.(),
    };
    this.activeExplanation = active;

    try {
      while (this.activeExplanation === active && !this.disposed) {
        const read = await Promise.race([
          iterator.next().then((result) => ({ type: "next" as const, result })),
          cancelled.then(() => ({ type: "cancelled" as const })),
        ]);
        if (
          read.type === "cancelled" ||
          this.activeExplanation !== active ||
          this.disposed
        ) {
          return;
        }
        if (read.result.done) {
          return;
        }
        this.acceptUpdate(read.result.value, button);
      }
    } finally {
      if (this.activeExplanation === active) {
        this.activeExplanation = undefined;
        if (button.isConnected && button.getAttribute("aria-busy") === "true") {
          setAriaBusy(button, false);
          button.textContent = "Explain";
        }
      }
    }
  }

  private acceptUpdate(
    update: ExplanationUpdate,
    button: HTMLButtonElement,
  ): void {
    if (update.status === "started") {
      this.section.hidden = false;
      this.checkModel.textContent =
        this.suggestion.attribution.checkModelDisplayName;
      this.title.textContent =
        `Explanation - ${update.attribution.languageDisplayName}`;
      this.model.textContent = update.attribution.modelDisplayName;
      this.explanation.dir = update.attribution.textDirection;
    } else if (update.status === "streaming") {
      const renderable = renderableExplanation(update.text);
      if (renderable !== undefined) {
        this.renderText(renderable);
      }
    } else if (update.status === "completed") {
      this.renderText(update.text);
      this.status.textContent = "";
      setAriaBusy(button, false);
      if (button.ownerDocument.activeElement === button) {
        const focusTarget = this.explanation.hasAttribute("tabindex")
          ? this.explanation
          : this.section;
        focusTarget.focus({ preventScroll: true });
      }
      button.remove();
    } else {
      this.section.hidden = false;
      this.status.textContent = update.status === "stale"
        ? "This suggestion is stale."
        : "No explanation available.";
      setAriaBusy(button, false);
      button.textContent = "Explain";
    }
  }

  private terminateActiveExplanation(): void {
    const active = this.activeExplanation;
    if (!active) {
      return;
    }
    this.activeExplanation = undefined;
    active.cancel();
    try {
      const completion = active.iterator.return?.();
      if (completion) {
        void Promise.resolve(completion).catch(() => undefined);
      }
    } catch {
      // The card is already closing; iterator cleanup cannot change its state.
    }
  }
}

class SuggestionActionFeedback {
  readonly element: HTMLElement;

  constructor(ownerDocument: Document) {
    this.element = ownerDocument.createElement("div");
    this.element.className =
      "refine-tooltip__status refine-tooltip__feedback-status";
  }

  clear(): void {
    this.element.textContent = "";
  }

  showReportCompleted(): void {
    this.element.textContent = "Thanks for the report.";
  }

  showReportFailed(): void {
    this.element.textContent = "Couldn't send report. Try again.";
  }

  showActionFailure(stale: boolean): void {
    this.element.textContent = stale
      ? "This suggestion is stale."
      : "Action unavailable.";
  }
}

class SuggestionReportController {
  private state: "ready" | "reporting" | "reported" = "ready";
  private disposed = false;

  constructor(
    private readonly suggestion: PresentedSuggestion,
    private readonly actions: SuggestionActions,
    private readonly feedback: SuggestionActionFeedback,
    private readonly engageCard: () => void,
  ) {}

  dispose(): void {
    this.disposed = true;
  }

  async report(button: HTMLButtonElement): Promise<void> {
    if (this.disposed || this.state !== "ready") {
      return;
    }
    this.engageCard();
    this.state = "reporting";
    setAriaBusy(button, true);
    button.textContent = "Reporting…";
    this.feedback.clear();
    let outcome;
    try {
      outcome = await this.actions.report(this.suggestion.id);
    } catch {
      if (this.disposed) {
        return;
      }
      this.state = "ready";
      setAriaBusy(button, false);
      button.textContent = "Retry report";
      this.feedback.showReportFailed();
      return;
    }
    if (this.disposed) {
      return;
    }
    if (outcome.status === "completed") {
      this.state = "reported";
      button.removeAttribute("aria-busy");
      button.textContent = "Reported";
      this.feedback.showReportCompleted();
      return;
    }

    this.state = "ready";
    setAriaBusy(button, false);
    button.textContent = "Retry report";
    this.feedback.showReportFailed();
  }
}

function renderSuggestionActions(
  ownerDocument: Document,
  suggestion: PresentedSuggestion,
  actions: SuggestionActions,
  report: SuggestionReportController,
  feedback: SuggestionActionFeedback,
  engageCard: () => void,
  close: () => void,
): HTMLElement {
  const actionRow = ownerDocument.createElement("div");
  actionRow.className = "refine-tooltip__actions";
  const bottomActions = ["dismiss", "report", "apply"] as const;
  for (const action of bottomActions) {
    if (!suggestion.availableActions.includes(action)) {
      continue;
    }
    const run = action === "report"
      ? (button: HTMLButtonElement) => report.report(button)
      : async (button: HTMLButtonElement): Promise<void> => {
          engageCard();
          setAriaBusy(button, true);
          const outcome = await actions[action](suggestion.id);
          if (outcome.status === "completed") {
            close();
            return;
          }

          feedback.showActionFailure(outcome.status === "stale");
          setAriaBusy(button, false);
        };
    actionRow.append(
      actionButton(ownerDocument, action, run),
    );
  }
  return actionRow;
}

function renderableExplanation(text: string): string | undefined {
  const index = text.lastIndexOf("\n");
  return index < 0 ? undefined : text.slice(0, index + 1);
}

function suggestionKindLabel(kind: PresentedSuggestion["kind"]): string {
  switch (kind) {
    case "grammar":
      return "Grammar";
    case "fluency":
      return "Fluency";
    case "mixed":
      return "Fluency";
  }
}

function actionButton(
  ownerDocument: Document,
  action: SuggestionActionKind,
  run: (button: HTMLButtonElement) => Promise<void>,
): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.dataset.refineAction = action;
  button.classList.add("refine-tooltip__action");
  if (action !== "apply") {
    button.classList.add("refine-tooltip__action--text");
  }
  button.textContent = `${action[0]?.toUpperCase() ?? ""}${action.slice(1)}`;
  button.addEventListener("click", () => {
    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      return;
    }
    void run(button).catch(() => {
      button.disabled = false;
      setAriaBusy(button, false);
    });
  });
  return button;
}

function setAriaBusy(button: HTMLButtonElement, busy: boolean): void {
  if (busy) {
    button.setAttribute("aria-disabled", "true");
    button.setAttribute("aria-busy", "true");
    return;
  }
  button.removeAttribute("aria-disabled");
  button.removeAttribute("aria-busy");
}
