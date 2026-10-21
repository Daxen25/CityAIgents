import { planSchema } from "@agent-city/core";

export function MissionPlan({ content }: { content: unknown }) {
  const parsed = planSchema.safeParse(content);
  if (!parsed.success) return <p role="alert">Stored plan could not be validated.</p>;
  const plan = parsed.data;
  return <section className="mt-5 border-t pt-4" aria-label="Chief of Staff plan">
    <h4 className="font-semibold">Chief of Staff plan — human review required</h4>
    <p className="my-3 whitespace-pre-wrap text-sm">{plan.summary}</p>
    <ol className="list-decimal space-y-3 pl-5">
      {plan.tasks.map((task, index) => <li key={index}>
        <p className="font-semibold">{task.title}</p>
        <p className="text-sm">Suggested role: {task.suggested_agent_role}</p>
        <p className="whitespace-pre-wrap text-sm">Expected deliverable: {task.expected_deliverable}</p>
        <p className="text-xs">Proposal only · not executable</p>
      </li>)}
    </ol>
    {plan.risks.length > 0 && <><h5 className="mt-4 font-semibold">Risks</h5>
      <ul className="list-disc pl-5">{plan.risks.map((risk, i) => <li key={i}>{risk}</li>)}</ul></>}
    <p className="mt-4 text-sm">Review every proposal before any further work. Task execution is unavailable in this milestone.</p>
  </section>;
}
