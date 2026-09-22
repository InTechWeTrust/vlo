import { getLatestExportRun } from "../../core/export/exportRunLog";
import { useDebugStore } from "../../shared/debug/useDebugStore";

/**
 * Hooks for the export throughput measurement (docs/pip-render-plan.md,
 * phase 1). The measurement drives the real export dialog; these only switch
 * on the debug-mode export log, which production builds cannot reach from
 * the UI, and read back how the run ended.
 */

export function setExportDebugMode(on: boolean): void {
  useDebugStore.getState().setDebugMode(on);
}

export interface ExportMeasureRunSummary {
  kind: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
}

export function getLatestExportRunSummary(): ExportMeasureRunSummary | null {
  const run = getLatestExportRun();
  return run
    ? { kind: run.kind, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt, error: run.error }
    : null;
}
