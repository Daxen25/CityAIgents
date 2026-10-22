import { z } from "zod";
const text = (max: number) => z.string().trim().min(1).max(max).refine((s) => !s.includes("\u0000") && s.isWellFormed(), "Invalid document text");
// Explicitly generated requirements, never externally verified research or citations.
export const researchDocumentSchema = z.strictObject({
  summary: text(2000),
  requirements: z.array(z.strictObject({
    title: text(200), description: text(2000),
    acceptance_criteria: z.array(text(500)).min(1).max(5),
  })).min(1).max(8),
  assumptions: z.array(text(500)).max(10),
  open_questions: z.array(text(500)).max(10),
  limitations: z.array(text(500)).min(1).max(10),
  sources: z.array(z.string()).max(0),
  verification: z.literal("not_externally_verified"),
});
export type ResearchDocument = z.infer<typeof researchDocumentSchema>;
export type ExecutionState = "not_authorized" | "authorized" | "running" | "pending_review" | "accepted" | "rejected" | "failed";
export const researcherAuthorizationInput = z.strictObject({ taskId: z.uuid(), requestId: z.uuid(), confirmed: z.literal(true) });
export const researcherReviewInput = z.strictObject({ runId: z.uuid(), requestId: z.uuid(), confirmed: z.literal(true), decision: z.enum(["accepted", "rejected"]) });
// Public, bounded diagnostics only; never provider error bodies or document content.
export const researcherDiagnosticsSchema = z.strictObject({
 provider_requests: z.number().int().min(0).max(2), retry_performed: z.boolean(),
 http_status: z.number().int().min(100).max(599).nullable(),
 failure_class: z.enum(["invalid_request_or_schema","authentication","permission_denied","model_or_endpoint_unavailable","quota_or_rate_limit","server_error","http_error"]).nullable(),
 provider_elapsed_ms: z.number().int().min(0).max(120000),
 timeout_source: z.enum(["application_deadline","transport_timeout","transport_error"]).nullable(),
}).refine(m => m.retry_performed === (m.provider_requests === 2), "Inconsistent request count");
export type ResearcherDiagnostics = z.infer<typeof researcherDiagnosticsSchema>;
export interface ResearcherRun {
  id: string; taskId: string; missionId: string; model: string; resolvedModel?: string | null;
  status: "running" | "completed" | "failed"; startedAt: string; endedAt: string | null;
  expiresAt: string; failureCode: string | null; diagnostics?: ResearcherDiagnostics | null;
}
export interface ResearcherArtifact { id: string; taskId: string; runId: string; content: unknown }
export interface ResearcherReview { id: string; runId: string; decision: "accepted" | "rejected"; decidedBy: string; decidedAt: string }
