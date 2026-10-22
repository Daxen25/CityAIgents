import type { ReactNode } from "react";
import { planSchema } from "@agent-city/core";

export function MissionPlan({ content, children, reviewed = false }: { content: unknown; children?: ReactNode; reviewed?: boolean }) {
  const parsed = planSchema.safeParse(content);
  if (!parsed.success) return <p role="alert">Stored plan could not be validated.</p>;
  const plan = parsed.data;
  return <section className="mt-5 border-t pt-4" aria-label="Chief of Staff plan">
    <h4 className="font-semibold">{reviewed ? "Chief of Staff plan — review recorded" : "Chief of Staff plan — human review required"}</h4>
    <p className="my-3 whitespace-pre-wrap text-sm">{plan.summary}</p>
    {children ?? <ol className="list-decimal space-y-3 pl-5">
      {plan.tasks.map((task, index) => <li key={index}>
        <p className="font-semibold">{task.title}</p>
        <p className="text-sm">Suggested role: {task.suggested_agent_role}</p>
        <p className="whitespace-pre-wrap text-sm">Expected deliverable: {task.expected_deliverable}</p>
        <p className="text-xs">Proposal only · not executable</p>
      </li>)}
    </ol>}
    {plan.risks.length > 0 && <><h5 className="mt-4 font-semibold">Risks</h5>
      <ul className="list-disc pl-5">{plan.risks.map((risk, i) => <li key={i}>{risk}</li>)}</ul></>}
    <p className="mt-4 text-sm">{reviewed ? "Task approval is recorded. Any Researcher execution requires separate owner authorization and human deliverable review. Other agent execution is unavailable." : "Review every proposal before any further work. Task execution is unavailable in this milestone."}</p>
  </section>;
}
