import type { ProtocolVersion } from "../transport/refine-transport";

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
