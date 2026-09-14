import { gestureKeys, type ModifierGesture, type PhysicalModifier } from "./suggestion-binding";

/** Timestamps are supplied in monotonic milliseconds so boundary tests need no timers. */
export class ModifierGestureRecognizer {
  private previous = new Set<PhysicalModifier>();
  private episode = new Set<PhysicalModifier>();
  private overlapped = false;
  private invalid = false;
  private awaitingNeutral = false;
  private firstPress: number | undefined;
  private taps = 0;

  constructor(readonly gesture: ModifierGesture) {}

  cancel(): void {
    this.awaitingNeutral ||= this.previous.size > 0;
    this.previous.clear();
    this.episode.clear();
    this.firstPress = undefined;
    this.taps = 0;
    this.overlapped = false;
    this.invalid = false;
  }

  update(pressed: ReadonlySet<PhysicalModifier>, time: number): boolean {
    if (this.awaitingNeutral) {
      this.awaitingNeutral = pressed.size !== 0;
      return false;
    }
    if (pressed.size === this.previous.size && [...pressed].every((key) => this.previous.has(key))) return false;
    const wasEmpty = this.previous.size === 0;
    this.previous = new Set(pressed);
    const allowed = gestureKeys(this.gesture);
    if (pressed.size > 0) {
      if (wasEmpty) {
        this.episode.clear();
        this.overlapped = false;
        this.invalid = false;
        if (this.firstPress !== undefined && time - this.firstPress > 500) {
          this.taps = 0;
          this.firstPress = undefined;
        }
        this.firstPress ??= time;
      }
      for (const key of pressed) this.episode.add(key);
      this.invalid ||= [...this.episode].some((key) => !allowed.includes(key));
      this.overlapped ||= pressed.size === allowed.length && allowed.every((key) => pressed.has(key));
      return false;
    }
    if (this.invalid || !this.overlapped || this.episode.size !== allowed.length) {
      this.taps = 0;
      this.firstPress = undefined;
      return false;
    }
    if (this.gesture.kind === "modifierChord") {
      this.firstPress = undefined;
      return true;
    }
    if (this.firstPress === undefined || time < this.firstPress || time - this.firstPress > 500) {
      this.taps = 0;
      this.firstPress = undefined;
      return false;
    }
    if (++this.taps !== 2) return false;
    this.taps = 0;
    this.firstPress = undefined;
    return true;
  }
}
