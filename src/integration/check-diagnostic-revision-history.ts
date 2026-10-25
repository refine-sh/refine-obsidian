import {
  checkDiagnosticsMatchSnapshot,
  compareCheckDiagnosticIssuesWithinSource,
  type CheckDiagnosticIssue,
  type CheckDiagnostics,
} from "./check-diagnostics";
import type { DocumentSnapshot } from "./types";
import { isUnicodeScalarBoundary } from "../shared/unicode-scalar-boundaries";

interface SourceMetadata {
  readonly sourceId: string;
  readonly utf16Length: number;
  readonly invalidScalarOffsets: Uint32Array;
}

export interface CheckDiagnosticRevisionMetadata {
  readonly byteLength: number;
  readonly sources: readonly SourceMetadata[];
}

/** Retains coordinates, never historical writing. Missing evidence fails closed. */
export class CheckDiagnosticRevisionHistory {
  private readonly revisions = new Map<string, CheckDiagnosticRevisionMetadata>();
  private byteLength = 0;

  constructor(
    private readonly maxRevisions = 64,
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {}

  remember(snapshot: DocumentSnapshot): void {
    if (this.revisions.has(snapshot.revision)) return;
    const metadata = captureCheckDiagnosticRevisionMetadata(snapshot, this.maxBytes);
    if (metadata === undefined || this.maxRevisions === 0) return;
    while (this.revisions.size >= this.maxRevisions || this.byteLength + metadata.byteLength > this.maxBytes) {
      const oldest = this.revisions.entries().next().value;
      if (oldest === undefined) return;
      this.revisions.delete(oldest[0]);
      this.byteLength -= oldest[1].byteLength;
    }
    this.revisions.set(snapshot.revision, metadata);
    this.byteLength += metadata.byteLength;
  }

  matches(
    diagnostics: CheckDiagnostics,
    revision: string,
    currentSnapshot: DocumentSnapshot | undefined,
  ): boolean {
    const metadata = this.revisions.get(revision);
    if (metadata === undefined) return false;
    if (currentSnapshot?.revision === revision) {
      return checkDiagnosticsMatchSnapshot(diagnostics, currentSnapshot);
    }
    let previous: readonly [number, CheckDiagnosticIssue] | undefined;
    for (const issue of diagnostics.issues) {
      const index = metadata.sources.findIndex((source) => source.sourceId === issue.sourceId);
      const source = metadata.sources[index];
      const end = issue.range.location + issue.range.length;
      if (source === undefined || !Number.isSafeInteger(issue.range.location) || issue.range.location < 0 ||
          !Number.isSafeInteger(issue.range.length) || issue.range.length <= 0 ||
          !Number.isSafeInteger(end) || end > source.utf16Length ||
          containsOffset(source.invalidScalarOffsets, issue.range.location) ||
          containsOffset(source.invalidScalarOffsets, end)) return false;
      if (previous && (index - previous[0] || compareCheckDiagnosticIssuesWithinSource(issue, previous[1])) <= 0) return false;
      previous = [index, issue];
    }
    return true;
  }

  clear(): void {
    this.revisions.clear();
    this.byteLength = 0;
  }
}

/** The payload budget counts UTF-16 identity bytes, lengths, and packed offsets. */
export function captureCheckDiagnosticRevisionMetadata(
  snapshot: DocumentSnapshot,
  maxBytes: number,
): CheckDiagnosticRevisionMetadata | undefined {
  let byteLength = snapshot.revision.length * 2;
  const sources: SourceMetadata[] = [];
  for (const source of snapshot.sources) {
    byteLength += source.sourceId.length * 2 + Uint32Array.BYTES_PER_ELEMENT;
    if (byteLength > maxBytes) return undefined;
    let splitCount = 0;
    for (let offset = 1; offset < source.text.length; offset += 1) {
      if (!isUnicodeScalarBoundary(source.text, offset)) splitCount += 1;
    }
    byteLength += splitCount * Uint32Array.BYTES_PER_ELEMENT;
    if (byteLength > maxBytes) return undefined;
    const invalidScalarOffsets = new Uint32Array(splitCount);
    if (splitCount > 0) {
      let index = 0;
      for (let offset = 1; offset < source.text.length; offset += 1) {
        if (!isUnicodeScalarBoundary(source.text, offset)) {
          invalidScalarOffsets[index++] = offset;
        }
      }
    }
    sources.push({ sourceId: source.sourceId, utf16Length: source.text.length, invalidScalarOffsets });
  }
  return byteLength <= maxBytes ? { byteLength, sources } : undefined;
}

function containsOffset(offsets: Uint32Array, target: number): boolean {
  let lower = 0;
  let upper = offsets.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const offset = offsets[middle]!;
    if (offset === target) return true;
    if (offset < target) lower = middle + 1;
    else upper = middle;
  }
  return false;
}
