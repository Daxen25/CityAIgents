// Only the server-only planning binding writes these diagnostics. Never serialize raw errors.
export const providerFailureClasses = ["invalid_request_or_schema", "authentication", "permission_denied", "model_or_endpoint_unavailable", "quota_or_rate_limit", "server_error", "http_error"] as const;
export type ProviderFailureClass = typeof providerFailureClasses[number];
function safeClassification(value: unknown): ProviderFailureClass | undefined {
  return providerFailureClasses.includes(value as ProviderFailureClass) ? value as ProviderFailureClass : undefined;
}
export class PlanningFailure extends Error {
  constructor(public readonly code: "timeout" | "provider_error" | "invalid_output") {
    super(`Planning failed (${code}). No tasks were executed.`);
  }
}
export class GeminiHttpFailure extends PlanningFailure {
  readonly failureClass: ProviderFailureClass;
  constructor(public readonly httpStatus: number) {
    super("provider_error");
    this.failureClass = httpStatus === 400 ? "invalid_request_or_schema" : httpStatus === 401 ? "authentication" :
      httpStatus === 403 ? "permission_denied" : httpStatus === 404 ? "model_or_endpoint_unavailable" :
      httpStatus === 429 ? "quota_or_rate_limit" : httpStatus >= 500 && httpStatus <= 599 ? "server_error" : "http_error";
  }
}
// Only fixed categories are retained; never keep the transport error/cause/message.
export class GeminiTransportFailure extends PlanningFailure {
  constructor(code: "timeout" | "provider_error", public readonly transportPhase: "response_headers" | "response_body",
    public readonly timeoutSource: "application_deadline" | "transport_timeout" | "transport_error", public readonly timeoutMs: number) {
    super(code);
  }
}
export type PlanningStage = "claim" | "generation" | "finalize_plan" | "finalize_failure" | "recover" | "start" | "review";
export type PlanningDiagnostic = {
  stage: PlanningStage;
  outcome: "started" | "succeeded" | "failed";
  provider?: "gemini" | "openai";
  runId?: string;
  elapsedMs: number;
  code?: string;
  httpStatus?: number;
  failureClass?: ProviderFailureClass;
  transportPhase?: "response_headers" | "response_body";
  timeoutSource?: "application_deadline" | "transport_timeout" | "transport_error";
  timeoutMs?: number;
  providerRequest?: number; retryEligible?: boolean;
  retryDecision?: "eligible" | "disabled" | "not_eligible" | "scheduled" | "performed" | "skipped_budget";
  requestedModel?: string; resolvedModel?: string;
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
export function diagnosticError(error: unknown): Pick<PlanningDiagnostic, "code" | "httpStatus" | "failureClass" | "transportPhase" | "timeoutSource" | "timeoutMs"> {
  if (error instanceof GeminiTransportFailure) return { transportPhase: error.transportPhase, timeoutSource: error.timeoutSource, timeoutMs: error.timeoutMs };
  if (error instanceof GeminiHttpFailure) return { httpStatus: safeStatus(error.httpStatus), failureClass: safeClassification(error.failureClass) };
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
    providerRequest: event.providerRequest === 0 || event.providerRequest === 1 || event.providerRequest === 2 ? event.providerRequest : undefined,
    retryEligible: typeof event.retryEligible === "boolean" ? event.retryEligible : undefined,
    retryDecision: ["eligible","disabled","not_eligible","scheduled","performed","skipped_budget"].includes(event.retryDecision ?? "") ? event.retryDecision : undefined,
    requestedModel: typeof event.requestedModel === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(event.requestedModel) ? event.requestedModel : undefined,
    resolvedModel: typeof event.resolvedModel === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(event.resolvedModel) ? event.resolvedModel : undefined,
    code: safeCode(event.code),
    httpStatus: safeStatus(event.httpStatus),
    failureClass: safeClassification(event.failureClass),
    transportPhase: event.transportPhase === "response_headers" || event.transportPhase === "response_body" ? event.transportPhase : undefined,
    timeoutSource: ["application_deadline", "transport_timeout", "transport_error"].includes(event.timeoutSource ?? "") ? event.timeoutSource : undefined,
    timeoutMs: Number.isInteger(event.timeoutMs) && event.timeoutMs! > 0 && event.timeoutMs! <= 45_000 ? event.timeoutMs : undefined,
  };
  // A diagnostics sink failure must never change authorization, persistence or retry behavior.
  try { write(`agent_city.${topic === "researcher" ? "researcher" : "planning"} ${JSON.stringify(safe)}`); } catch { /* best effort */ }
}
