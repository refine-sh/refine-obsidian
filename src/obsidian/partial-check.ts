import type { Text } from "@codemirror/state";
import type { CheckDiagnosticIssue } from "../integration/check-diagnostics";
import type { PresentationSnapshot } from "../integration/types";

const REASONS: Record<CheckDiagnosticIssue["reason"], string> = {
  unusableOutput: "Model response could not be used",
  protectedTextRestoreFailed: "Protected text could not be restored",
  excessiveChange: "Model changed too much",
  cancelled: "Check was interrupted",
};

export interface PartialCheckPassage {
  readonly issue: CheckDiagnosticIssue;
  readonly firstLine: number;
  readonly lastLine: number;
  readonly label: string;
}

export function partialCheckPassages(snapshot: PresentationSnapshot, document: Text): PartialCheckPassage[] {
  if (snapshot.state.type !== "complete" || snapshot.state.coverage !== "partial") return [];
  return (snapshot.checkDiagnostics?.issues ?? []).flatMap((issue) => {
    const end = issue.range.location + issue.range.length;
    if (issue.sourceId !== "document" || issue.range.location < 0 || issue.range.length <= 0 || end > document.length) return [];
    const firstLine = document.lineAt(issue.range.location).number;
    const lastLine = document.lineAt(end - 1).number;
    const lines = firstLine === lastLine ? `Line ${firstLine}` : `Lines ${firstLine}–${lastLine}`;
    const kind = issue.kind === "grammar" ? "Grammar" : "Fluency";
    return [{ issue, firstLine, lastLine, label: `${lines} · ${kind}: ${REASONS[issue.reason]}` }];
  });
}

/** Explicit copy action: no note text, path, source identity, or model output. */
export function partialCheckReport(snapshot: PresentationSnapshot, document: Text): string {
  return JSON.stringify({
    schema: 1,
    status: "partial",
    suggestionCount: snapshot.suggestions.length,
    omittedIssueCount: snapshot.checkDiagnostics?.omittedIssueCount ?? 0,
    issues: partialCheckPassages(snapshot, document).map(({ issue, firstLine, lastLine }) => ({
      firstLine, lastLine, kind: issue.kind, reason: issue.reason,
    })),
  }, null, 2);
}
