import { z } from "zod";

export const planReviewInput = z.strictObject({
  missionId: z.uuid(), runId: z.uuid(), requestId: z.uuid(),
  decision: z.enum(["approved", "rejected"]),
  acceptedTaskIds: z.array(z.uuid()).max(12),
  confirmed: z.literal(true),
}).superRefine((value, context) => {
  if (new Set(value.acceptedTaskIds).size !== value.acceptedTaskIds.length)
    context.addIssue({ code: "custom", message: "Duplicate task selection" });
  if ((value.decision === "approved") !== (value.acceptedTaskIds.length > 0))
    context.addIssue({ code: "custom", message: "Approval requires accepted tasks; rejection accepts none" });
});
export type PlanReviewInput = z.infer<typeof planReviewInput>;
export interface ReviewedTask {
  id: string; workspaceId: string; missionId: string; planRunId: string;
  title: string; suggestedAgentRole: string; expectedDeliverable: string;
  position: number; status: "proposed" | "approved" | "rejected";
  agentId: string | null; agentDefinitionKey: string | null; agentName: string | null;
  reviewId: string | null;
}
export interface PlanReview {
  id: string; missionId: string; runId: string;
  decision: "approved" | "rejected"; decidedBy: string; decidedAt: string;
}
// Read-only future M1.4 boundary. Creating/consuming this descriptor is NOT execution
// permission; a future adapter must implement a separate supervised authorization gate.
export interface SupervisedTaskHandoff {
  version: "1"; workspaceId: string; missionId: string; taskId: string;
  planRunId: string; reviewId: string; agentId: string; agentDefinitionKey: string;
  expectedDeliverable: string; executionAuthorized: false;
}
