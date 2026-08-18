export type TimerHandle = ReturnType<typeof setTimeout>;

// The integration and transport layers are host-neutral: besides the Obsidian
// renderer they run in bare Node under the conformance harness, so they
// schedule on the ambient timers rather than on a window. Each call resolves
// the timer afresh so a replaced global is honoured instead of one captured
// when this module was first imported.
export function setTimer(handler: () => void, delayMs: number): TimerHandle {
  const schedule = setTimeout;
  return schedule(handler, delayMs);
}

export function clearTimer(handle: TimerHandle | undefined): void {
  if (handle === undefined) {
    return;
  }
  const cancel = clearTimeout;
  cancel(handle);
}
