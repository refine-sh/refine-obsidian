import { EngineFaultError } from "../integration/refine-integration";
import {
  IncompatibleProtocolError,
  type ProtocolVersion,
} from "../transport/refine-transport";

export function integrationFailureNotice(error: unknown): string {
  if (error instanceof IncompatibleProtocolError) {
    return incompatibleProtocolNotice(
      error.clientProtocol,
      error.serverProtocol,
    );
  }
  if (isIncompatibleEngineError(error)) {
    return incompatibleEngineNotice();
  }
  return "Refine is unavailable. Make sure the Refine app is running.";
}

/**
 * Identifies a run that ended because Refine could not read what this plugin
 * sent. Integration Protocol 1.0 carries no feature discovery, so a Refine
 * build older than this plugin accepts the exact-version handshake and only
 * then fatally rejects a command. That is a version skew, not a missing app.
 */
export function isIncompatibleEngineError(error: unknown): boolean {
  return error instanceof EngineFaultError && error.code === "malformedMessage";
}

export function incompatibleEngineNotice(): string {
  return "The Refine app did not understand a message from this Refine Obsidian plugin. Update Refine for Mac to a version that supports this plugin, then try again.";
}

export function incompatibleProtocolNotice(
  clientProtocol: ProtocolVersion,
  serverProtocol: ProtocolVersion,
): string {
  return `This Refine Obsidian plugin requires Integration Protocol ${formatProtocol(clientProtocol)}, but the Refine app reports Integration Protocol ${formatProtocol(serverProtocol)}. Install compatible Refine and plugin versions, then try again.`;
}

export function incompatibleProtocolStatus(
  clientProtocol: ProtocolVersion,
  serverProtocol: ProtocolVersion,
): string {
  return `Refine: Protocol ${formatProtocol(clientProtocol)} required; app reports ${formatProtocol(serverProtocol)}. Open Refine menu`;
}

function formatProtocol(protocol: ProtocolVersion): string {
  return `${protocol.major}.${protocol.minor}`;
}
