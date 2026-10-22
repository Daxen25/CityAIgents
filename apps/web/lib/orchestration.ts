import "server-only";
import { planReviewInput, type ReviewedTask, type PlanReview } from "@agent-city/core";
import { mode } from "./config";
import { supabase } from "./supabase";

function check(error: unknown) {
  if (error) throw new Error("Plan review unavailable. Check ownership, mission state, task selection and final confirmation.");
}
// No model SDK, privileged client or execution adapter is used by orchestration.
export async function reviewTaskPlan(input: unknown) {
  if (mode() !== "supabase") throw new Error("Task plan review is unavailable in mock mode");
  const data = planReviewInput.parse(input);
  const result = await (await supabase()).rpc("review_task_plan", {
    mid: data.missionId, rid: data.runId, request_id: data.requestId,
    decision: data.decision, accepted_ids: data.acceptedTaskIds, confirmed: data.confirmed,
  });
  check(result.error);
}
export async function orchestrationSnapshot(hasPlans: boolean): Promise<{ tasks: ReviewedTask[]; reviews: PlanReview[] }> {
  if (!hasPlans || mode() !== "supabase") return { tasks: [], reviews: [] };
  const db = await supabase();
  const [tasks, reviews, agents, definitions] = await Promise.all([
    db.from("tasks").select("id,workspace_id,mission_id,plan_run_id,title,status,proposal_position,suggested_agent_role,expected_deliverable,agent_id,review_id").not("plan_run_id", "is", null).order("proposal_position"),
    db.from("task_plan_reviews").select("id,mission_id,run_id,decision,decided_by,decided_at"),
    db.from("agents").select("id,workspace_id,definition_key"),
    db.from("agent_definitions").select("key,name"),
  ]);
  [tasks,reviews,agents,definitions].forEach((result) => check(result.error));
  return {
    tasks: (tasks.data ?? []).map((task) => {
      const agent = (agents.data ?? []).find((a) => a.id === task.agent_id && a.workspace_id === task.workspace_id);
      return {
        id: task.id, workspaceId: task.workspace_id, missionId: task.mission_id, planRunId: task.plan_run_id,
        title: task.title, status: task.status, position: task.proposal_position,
        suggestedAgentRole: task.suggested_agent_role, expectedDeliverable: task.expected_deliverable,
        agentId: task.agent_id, agentDefinitionKey: agent?.definition_key ?? null,
        agentName: (definitions.data ?? []).find((d) => d.key === agent?.definition_key)?.name ?? null,
        reviewId: task.review_id,
      };
    }),
    reviews: (reviews.data ?? []).map((r) => ({
      id: r.id, missionId: r.mission_id, runId: r.run_id, decision: r.decision,
      decidedBy: r.decided_by, decidedAt: r.decided_at,
    })),
  };
}
