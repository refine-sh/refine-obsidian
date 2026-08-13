export type EngineConnectionRecoverability = "recoverable" | "fatal";

export class EngineConnectionError extends Error {
  readonly recoverability: EngineConnectionRecoverability;

  constructor(
    message: string,
    recoverability: EngineConnectionRecoverability,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EngineConnectionError";
    this.recoverability = recoverability;
  }
}

export function isFatalEngineConnectionError(error: unknown): boolean {
  return error instanceof EngineConnectionError && error.recoverability === "fatal";
}
