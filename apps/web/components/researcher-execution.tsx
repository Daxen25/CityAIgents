import { randomUUID } from "node:crypto";
import { researchDocumentSchema, type ReviewedTask, type ResearcherRun, type ResearcherArtifact, type ResearcherReview } from "@agent-city/core";
import { authorizeResearcherTask, recoverResearcherTask, reviewResearcherResult } from "@/app/actions";
import { Button } from "./ui/button";
export function ResearcherExecution({ task,owner,enabled,runs,artifacts,reviews }: {
  task: ReviewedTask; owner: boolean; enabled: boolean; runs: ResearcherRun[]; artifacts: ResearcherArtifact[]; reviews: ResearcherReview[];
}) {
  const state=task.executionStatus ?? "not_authorized";
  const eligible=task.status==="approved" && task.agentDefinitionKey==="researcher" && task.suggestedAgentRole==="researcher";
  if (!eligible && !runs.length) return task.status==="approved" ? <p className="mt-2 text-sm">Execution unavailable for this agent.</p> : null;
  return <section className="mt-3 rounded border border-input p-3" aria-label="Supervised Researcher execution">
    <h5 className="font-semibold">Supervised Researcher · {state.replaceAll("_"," ")}</h5>
    <p className="my-2 text-sm">Gemini-generated requirements from mission/task inputs only. No browsing, external tools, sources or external verification.</p>
    {eligible && owner && enabled && ["not_authorized","failed"].includes(state) && runs.length<3 && <form action={authorizeResearcherTask}>
      <input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="requestId" value={randomUUID()} />
      <label className="text-sm"><input type="checkbox" name="confirmed" value="yes" required style={{width:"auto",marginRight:"0.5rem"}} /> I authorize one potentially paid Gemini call using this mission objective and approved task. This is separate from plan approval.</label>
      <Button variant="outline">Authorize Researcher execution</Button>
    </form>}
    {!enabled && eligible && <p className="text-sm">New Researcher execution is disabled. Existing results can still be reviewed.</p>}
    {runs.length>=3 && state==="failed" && <p className="text-sm">Maximum three authorized attempts reached.</p>}
    {runs.map((run) => {
      const artifact=artifacts.find((a) => a.runId===run.id);
      const parsed=artifact ? researchDocumentSchema.safeParse(artifact.content) : null;
      const review=reviews.find((r) => r.runId===run.id);
      const seconds=Math.max(0,Math.round(((run.endedAt ? Date.parse(run.endedAt) : Date.now())-Date.parse(run.startedAt))/1000));
      return <article className="mt-4 border-t pt-3" key={run.id}>
        <p className="text-sm">Run {run.id} · Gemini / {run.resolvedModel ?? run.model} (requested: {run.model}) · {run.status} · elapsed at refresh: {seconds} seconds</p>
        {run.failureCode && <p role="alert" className="text-sm">Execution error: {run.failureCode}. No deliverable from this attempt.</p>}
        {owner && run.status==="running" && <form action={recoverResearcherTask}>
          <input type="hidden" name="runId" value={run.id} />
          <p className="text-sm">If interrupted, refresh first. Recovery is allowed only after the two-minute lease expires and never calls a model.</p>
          <Button variant="outline">Recover interrupted Researcher execution</Button>
        </form>}
        {parsed?.success && <>
          <h6 className="mt-3 font-semibold">Generated deliverable — not externally verified</h6>
          <p className="whitespace-pre-wrap text-sm">{parsed.data.summary}</p>
          <ol className="my-3 list-decimal space-y-2 pl-5">{parsed.data.requirements.map((r,i) => <li key={i}><p className="font-semibold">{r.title}</p><p className="whitespace-pre-wrap text-sm">{r.description}</p><ul className="list-disc pl-5">{r.acceptance_criteria.map((c,j) => <li key={j}>{c}</li>)}</ul></li>)}</ol>
          {([['Assumptions',parsed.data.assumptions],['Open questions',parsed.data.open_questions],['Limitations',parsed.data.limitations]] as [string,string[]][]).map(([label,items]) => <div key={label}><p className="mt-2 font-semibold">{label}</p><ul className="list-disc pl-5">{items.map((text,i) => <li key={i}>{text}</li>)}</ul></div>)}
          <p className="mt-2 text-sm">Sources: none. Human acceptance does not assert factual or external verification.</p>
        </>}
        {artifact && !parsed?.success && <p role="alert">Stored document is invalid; review is blocked.</p>}
        {owner && state==="pending_review" && run.status==="completed" && parsed?.success && !review && <div className="mt-3 flex flex-wrap gap-3">
          {(["accepted","rejected"] as const).map((decision) => <form key={decision} action={reviewResearcherResult}>
            <input type="hidden" name="runId" value={run.id} /><input type="hidden" name="requestId" value={randomUUID()} /><input type="hidden" name="decision" value={decision} />
            <label className="text-sm"><input type="checkbox" name="confirmed" value="yes" required style={{width:"auto",marginRight:"0.5rem"}} /> I confirm this generated deliverable is {decision}.</label>
            <Button variant={decision==="rejected" ? "destructive" : "outline"}>{decision==="accepted" ? "Accept generated deliverable" : "Reject generated deliverable"}</Button>
          </form>)}
        </div>}
        {review && <p className="mt-3 text-sm">Deliverable {review.decision} by {review.decidedBy} at {review.decidedAt}. Review {review.id}.</p>}
      </article>;
    })}
  </section>;
}
