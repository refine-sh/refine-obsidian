import type { DocumentSnapshot, UTF16Range } from "./types";
import { isUnicodeScalarBoundary } from "../shared/unicode-scalar-boundaries";

export const CHECK_DIAGNOSTICS_CAPABILITY = "com.runjuu.refine.check-diagnostics.v1";
export const MAX_CHECK_DIAGNOSTIC_ISSUES = 128;
export const CHECK_DIAGNOSTIC_REASONS = [
  "unusableOutput", "protectedTextRestoreFailed", "excessiveChange", "cancelled",
] as const;

export interface CheckDiagnosticIssue {
  readonly sourceId: string;
  readonly range: UTF16Range;
  readonly kind: "grammar" | "fluency";
  readonly reason: (typeof CHECK_DIAGNOSTIC_REASONS)[number];
}

export interface CheckDiagnostics {
  readonly issues: readonly CheckDiagnosticIssue[];
  readonly omittedIssueCount: number;
}

export function compareCheckDiagnosticIssuesWithinSource(
  left: CheckDiagnosticIssue,
  right: CheckDiagnosticIssue,
): number {
  return left.range.location - right.range.location
    || left.range.length - right.range.length
    || compareASCII(left.kind, right.kind)
    || compareASCII(left.reason, right.reason);
}

export function checkDiagnosticsMatchSnapshot(
  diagnostics: CheckDiagnostics,
  snapshot: DocumentSnapshot,
): boolean {
  const sources = new Map(snapshot.sources.map((source, index) => [source.sourceId, { source, index }]));
  let previous: readonly [number, CheckDiagnosticIssue] | undefined;
  for (const issue of diagnostics.issues) {
    const entry = sources.get(issue.sourceId);
    if (!entry) return false;
    const end = issue.range.location + issue.range.length;
    if (!Number.isSafeInteger(end) || issue.range.length <= 0 || end > entry.source.text.length) return false;
    if (!isUnicodeScalarBoundary(entry.source.text, issue.range.location) ||
        !isUnicodeScalarBoundary(entry.source.text, end)) return false;
    if (previous) {
      const [index, prior] = previous;
      const order = entry.index - index || compareCheckDiagnosticIssuesWithinSource(issue, prior);
      if (order <= 0) return false;
    }
    previous = [entry.index, issue];
  }
  return true;
}

function compareASCII(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
