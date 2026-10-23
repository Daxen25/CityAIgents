import { z } from "zod";
export { planSchema, type Plan } from "./planning";
export { planReviewInput, type PlanReviewInput, type ReviewedTask, type PlanReview, type SupervisedTaskHandoff } from "./orchestration";
export const statusSchema = z.enum([
  "draft",
  "awaiting_approval",
  "approved",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const actionSchema = z.enum([
  "submit",
  "approve",
  "reject",
  "start",
  "complete",
  "fail",
  "cancel",
]);
export const missionInput = z.object({
  workspaceId: z.uuid(),
  title: z.string().trim().min(3).max(120),
  objective: z.string().trim().min(10).max(4000),
  kind: z.enum(["personal", "business"]),
});
export type Status = z.infer<typeof statusSchema>;
export type Action = z.infer<typeof actionSchema>;
export type MissionInput = z.infer<typeof missionInput>;
export type Role = "owner" | "member";
export interface Mission extends MissionInput {
  executionMode?: "mock" | "chief_of_staff";
  id: string;
  status: Status;
  createdAt: string;
  createdBy: string;
}
export interface Approval {
  id: string;
  workspaceId: string;
  missionId: string;
  status: "pending" | "approved" | "rejected";
  decidedBy: string | null;
}
export interface Run {
  id: string;
  workspaceId: string;
  missionId: string;
  adapter: "mock";
  status: "running" | "completed" | "failed";
}
export interface Activity {
  id: string;
  workspaceId: string;
  missionId: string;
  actorId: string;
  event: string;
  createdAt: string;
}
export interface RuntimeRequest {
  version: "1";
  workspaceId: string;
  missionId: string;
  runId: string;
  adapter: "mock" | "python";
  approvalId: string;
}
export const agentDefinitions = [
  {
    key: "chief-of-staff",
    name: "Chief of Staff",
    description: "Plans missions and coordinates supervised work.",
  },
  {
    key: "researcher",
    name: "Researcher",
    description: "Prepares research plans and evidence summaries.",
  },
  {
    key: "developer",
    name: "Developer",
    description: "Plans and implements approved software work.",
  },
] as const;
const transitions: Record<Action, Partial<Record<Status, Status>>> = {
  submit: { draft: "awaiting_approval" },
  approve: { awaiting_approval: "approved" },
  reject: { awaiting_approval: "cancelled" },
  start: { approved: "running" },
  complete: { running: "completed" },
  fail: { running: "failed" },
  cancel: {
    draft: "cancelled",
    awaiting_approval: "cancelled",
    approved: "cancelled",
  },
};
export function nextStatus(
  status: Status,
  action: Action,
  role: Role,
  approval?: Approval,
): Status {
  if ((action === "approve" || action === "reject") && role !== "owner")
    throw new Error("Only workspace owners can decide approvals");
  const next = transitions[action][status];
  if (!next) throw new Error(`Invalid transition: ${status} → ${action}`);
  if (action === "start" && approval?.status !== "approved")
    throw new Error("Approved permission required");
  return next;
}
export function assertMember(
  members: { workspaceId: string; userId: string; role: Role }[],
  workspaceId: string,
  userId: string,
): Role {
  const member = members.find(
    (m) => m.workspaceId === workspaceId && m.userId === userId,
  );
  if (!member) throw new Error("Workspace access denied");
  return member.role;
}
// No tools, network calls, model calls or fabricated research results.
export function mockResult() {
  return {
    adapter: "mock" as const,
    summary:
      "Mock lifecycle completed. No agent work or external actions were performed.",
  };
}

export { researcherDiagnosticsSchema, type ResearcherDiagnostics, researchDocumentSchema, researcherAuthorizationInput, researcherReviewInput, type ResearchDocument, type ExecutionState, type ResearcherRun, type ResearcherArtifact, type ResearcherReview } from "./researcher";
export { extensionSchema, extensionRequestSchema, extensionReviewSchema, type ExtensionPlan, type ExtensionProposal, type ExtensionReview, type ExtensionTask } from './extensions';

export * from "./web-research";
