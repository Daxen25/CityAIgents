// Only the server-only planning binding writes these diagnostics. Never serialize raw errors.
export type PlanningStage = "claim" | "generation" | "finalize_plan" | "finalize_failure" | "recover" | "start" | "review";
export type PlanningDiagnostic = {
  stage: PlanningStage;
  outcome: "started" | "succeeded" | "failed";
  provider?: "gemini" | "openai";
  runId?: string;
  elapsedMs: number;
  code?: string;
  httpStatus?: number;
};
function safeCode(value: unknown) {
  return typeof value === "string" && /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(value) ? value : undefined;
}
function safeStatus(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}
export class PlanningRpcError extends Error {
  readonly code?: string;
  readonly httpStatus?: number;
  constructor(error: unknown, status?: number) {
    super("Planning operation denied or unavailable. Check mission state, ownership and remaining attempts.");
    this.code = safeCode(error && typeof error === "object" && "code" in error ? error.code : undefined);
    this.httpStatus = safeStatus(status);
  }
}
export function diagnosticError(error: unknown): Pick<PlanningDiagnostic, "code" | "httpStatus"> {
  return error instanceof PlanningRpcError ? { code: error.code, httpStatus: error.httpStatus } : {};
}
export function logPlanningDiagnostic(event: PlanningDiagnostic, write: (line: string) => void = console.info, topic: "planning" | "researcher" = "planning") {
  // Reconstruct a whitelist, even if an accidental caller supplies extra properties.
  const safe = {
    stage: ["claim", "generation", "finalize_plan", "finalize_failure", "recover", "start", "review"].includes(event.stage) ? event.stage : "unknown",
    outcome: ["started", "succeeded", "failed"].includes(event.outcome) ? event.outcome : "unknown",
    provider: event.provider === "gemini" || event.provider === "openai" ? event.provider : undefined,
    runId: typeof event.runId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.runId) ? event.runId : undefined,
    elapsedMs: Number.isFinite(event.elapsedMs) ? Math.max(0, Math.round(event.elapsedMs)) : undefined,
    code: safeCode(event.code),
    httpStatus: safeStatus(event.httpStatus),
  };
  // A diagnostics sink failure must never change authorization, persistence or retry behavior.
  try { write(`agent_city.${topic === "researcher" ? "researcher" : "planning"} ${JSON.stringify(safe)}`); } catch { /* best effort */ }
}
