import type { WorkspaceKernel } from "../core/workspace.js";
import { asWorkspaceResult, type WorkspaceResult } from "../result.js";

export interface WorkspaceEvalStep {
  id: string;
  run(workspace: WorkspaceKernel): Promise<any> | any;
}

export interface WorkspaceEvalCase {
  name: string;
  steps: WorkspaceEvalStep[];
}

export interface WorkspaceEvalStepResult {
  id: string;
  ok: boolean;
  result?: any;
  error?: any;
  durationMs: number;
}

export interface WorkspaceEvalResult {
  name: string;
  ok: boolean;
  steps: WorkspaceEvalStepResult[];
  durationMs: number;
}

export async function runWorkspaceEval(workspace: WorkspaceKernel, evalCase: WorkspaceEvalCase): Promise<WorkspaceEvalResult> {
  const start = Date.now();
  const steps: WorkspaceEvalStepResult[] = [];
  for (const step of evalCase.steps) {
    const stepStart = Date.now();
    const result: WorkspaceResult<any> = await asWorkspaceResult(() => step.run(workspace));
    steps.push({
      id: step.id,
      ok: result.ok,
      result: result.ok ? result.data : undefined,
      error: result.ok ? undefined : result.error,
      durationMs: Date.now() - stepStart,
    });
    if (!result.ok) break;
  }
  return { name: evalCase.name, ok: steps.every((s) => s.ok), steps, durationMs: Date.now() - start };
}
