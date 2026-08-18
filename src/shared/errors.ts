export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(describeThrown(value), { cause: value });
}

export function abortReason(signal: AbortSignal): Error {
  return toError(signal.reason ?? new DOMException("Aborted", "AbortError"));
}

function describeThrown(value: unknown): string {
  return typeof value === "symbol" ? value.toString() : String(value);
}
