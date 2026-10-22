import { randomUUID } from "node:crypto";
import type { PlanReview, ReviewedTask } from "@agent-city/core";
import { finalizeTaskPlan } from "@/app/actions";
import { MissionPlan } from "./mission-plan";
import { Button } from "./ui/button";

export function TaskPlanReview({ content, missionId, runId, missionStatus, tasks, review, owner }: {
  content: unknown; missionId: string; runId: string; missionStatus: string;
  tasks: ReviewedTask[]; review?: PlanReview; owner: boolean;
}) {
  const canReview = owner && missionStatus === "awaiting_approval" && !review && tasks.length > 0;
  const approved = tasks.filter((task) => task.status === "approved").length;
  const rejected = tasks.filter((task) => task.status === "rejected").length;
  const fields = (decision: "approved" | "rejected") => <>
    <input type="hidden" name="missionId" value={missionId} />
    <input type="hidden" name="runId" value={runId} />
    <input type="hidden" name="requestId" value={randomUUID()} />
    <input type="hidden" name="decision" value={decision} />
  </>;
  const taskList = (selectable: boolean) => <ol className="list-decimal space-y-4 pl-5" aria-label="Plan tasks">
    {tasks.map((task) => <li key={task.id}>
      {selectable ? <label className="font-semibold">
        <input style={{ width: "auto", marginRight: "0.5rem", padding: 0 }} type="checkbox" name="acceptedTaskIds" value={task.id} /> Accept: {task.title}
      </label> : <p className="font-semibold">{task.title}</p>}
      <p className="text-sm">Proposed role: {task.suggestedAgentRole}</p>
      <p className="whitespace-pre-wrap text-sm">Expected deliverable: {task.expectedDeliverable}</p>
      <p className="text-sm">Status: {task.status} · {task.status === "proposed" ? "Proposal only" : "Review recorded"} · not executable</p>
      {task.agentId && <p className="text-sm">Assigned: {task.agentName ?? task.agentDefinitionKey} ({task.agentDefinitionKey})</p>}
      {task.reviewId && <p className="text-xs text-slate-500">Decision history: {task.status} · review {task.reviewId}</p>}
    </li>)}
  </ol>;
  return <MissionPlan content={content} reviewed={Boolean(review)}>
    <p className="mb-4 text-sm">Mission progress: {approved} approved, {rejected} rejected, {tasks.length-approved-rejected} proposed. Executed: 0. Execution unavailable.</p>
    {!tasks.length && <p role="alert">Proposal records are unavailable. Plan review is blocked.</p>}
    {canReview ? <>
      <form action={finalizeTaskPlan}>
        {fields("approved")}
        <p className="mb-3 text-sm">Select at least one task to accept. Unchecked tasks will be rejected and retained in the audit history. Assignments use the proposed workspace agent definitions.</p>
        {taskList(true)}
        <label className="mt-4 text-sm"><input style={{ width: "auto", marginRight: "0.5rem", padding: 0 }} type="checkbox" name="confirmed" value="yes" required /> I confirm the selected task decisions and assignments. No work will execute.</label>
        <Button variant="outline">Confirm approved tasks</Button>
      </form>
      <form action={finalizeTaskPlan} className="mt-5 border-t pt-4">
        {fields("rejected")}
        <label className="text-sm"><input style={{ width: "auto", marginRight: "0.5rem", padding: 0 }} type="checkbox" name="confirmed" value="yes" required /> I confirm rejection of the entire plan. All proposals remain auditable.</label>
        <Button variant="destructive">Confirm reject entire plan</Button>
      </form>
    </> : taskList(false)}
    {!owner && !review && <p className="mt-4 text-sm">Only a workspace owner can finalize plan review.</p>}
    {review && <p className="mt-4 text-sm">Plan {review.decision} by {review.decidedBy} at <time dateTime={review.decidedAt}>{review.decidedAt}</time>. Review {review.id}.</p>}
    {approved > 0 && <p className="mt-3 text-sm">Approved task list: {tasks.filter((task) => task.status === "approved").map((task) => task.title).join("; ")}. Assignment does not enable an agent or authorize execution.</p>}
  </MissionPlan>;
}
