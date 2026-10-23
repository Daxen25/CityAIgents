import { randomUUID } from "node:crypto";
import { researchDocumentSchema,webResearchDocumentSchema, type ReviewedTask, type ResearcherRun, type ResearcherArtifact, type ResearcherReview } from "@agent-city/core";
import { authorizeResearcherTask, recoverResearcherTask, reviewResearcherResult } from "@/app/actions";
import {researcherWebEnabled} from "@/lib/researcher";
import { Button } from "./ui/button";
export function ResearcherExecution({ task,owner,enabled,runs,artifacts,reviews }: {
  task: Pick<ReviewedTask,"id"|"status"|"agentDefinitionKey"|"suggestedAgentRole"|"executionStatus">; owner: boolean; enabled: boolean; runs: ResearcherRun[]; artifacts: ResearcherArtifact[]; reviews: ResearcherReview[];
}) {
  const state=task.executionStatus ?? "not_authorized";
  const eligible=task.status==="approved" && task.agentDefinitionKey==="researcher" && task.suggestedAgentRole==="researcher";
  if (!eligible && !runs.length) return task.status==="approved" ? <p className="mt-2 text-sm">Execution unavailable for this agent.</p> : null;
  return <section className="mt-3 rounded border border-input p-3" aria-label="Supervised Researcher execution">
    <h5 className="font-semibold">Supervised Researcher · {state.replaceAll("_"," ")}</h5>
    <p className="my-2 text-sm">Choose Requirements Brief (input only) or explicitly authorized Web Research. Neither mode executes tools or verifies facts independently.</p>
    <p className="text-sm">Authorized attempts: {runs.length}/3 used · {Math.max(0,3-runs.length)} remaining.</p>
    {state==="pending_review" && <p className="text-sm">Generated result is pending human review. No further execution is authorized.</p>}
    {state==="failed" && <p className="text-sm">Retry requires new authorization and an available authorized attempt.</p>}
    {eligible && owner && enabled && ["not_authorized","failed"].includes(state) && runs.length<3 && <form action={authorizeResearcherTask}>
      <input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="requestId" value={randomUUID()} />
      <label className="text-sm">Research mode<select name="mode" defaultValue="brief"><option value="brief">Requirements Brief — no browsing</option>{researcherWebEnabled()&&<option value="web">Web Research — public evidence</option>}</select></label>
      <p className="text-sm">Requirements Brief: Gemini, at most 2 requests with optional 503 retry. Web Research: Tavily, at most 1 search (5 sources) and 1 Gemini synthesis, no retries. Model: {process.env.GEMINI_MODEL??"gemini-flash-latest"}. Both may incur charges; web mode sends mission/task query text to a public search provider.</p>
      {!researcherWebEnabled()&&<p className="text-sm">Web Research disabled or missing search configuration.</p>}
      <label className="text-sm"><input type="checkbox" name="confirmed" value="yes" required style={{width:"auto",marginRight:"0.5rem"}} /><span>I authorize one run in the selected mode within the displayed request budget, including external public-source queries for Web Research and potential API charges. This is separate from plan approval.</span></label>
      <Button variant="outline">Authorize Researcher execution</Button>
    </form>}
    {!enabled && eligible && <p className="text-sm">New Researcher execution is disabled. Existing results can still be reviewed.</p>}
    {runs.length>=3 && state==="failed" && <p className="text-sm">Maximum three authorized attempts reached.</p>}
    {runs.map((run) => {
      const artifact=artifacts.find((a) => a.runId===run.id);
      const parsed=artifact ? researchDocumentSchema.safeParse(artifact.content) : null;
      const web=artifact?webResearchDocumentSchema.safeParse(artifact.content):null;
      const valid=parsed?.success||web?.success;
      const http=run.webDiagnostics?.http_status??run.diagnostics?.http_status;
      const review=reviews.find((r) => r.runId===run.id);
      const seconds=Math.max(0,Math.round(((run.endedAt ? Date.parse(run.endedAt) : Date.now())-Date.parse(run.startedAt))/1000));
      return <article className="mt-4 border-t pt-3" key={run.id}>
        <p className="text-sm">Run {run.id} · {run.mode==="web"?"Web Research":"Requirements Brief"} · Gemini / {run.resolvedModel ?? run.model} (requested: {run.model}) · {run.status} · elapsed at refresh: {seconds} seconds</p>
        {run.diagnostics ? <p className="text-sm">Provider requests: {run.diagnostics.provider_requests} · transient retry: {run.diagnostics.retry_performed ? "performed" : "not performed"} · provider time: {run.diagnostics.provider_elapsed_ms} ms{run.diagnostics.http_status ? ` · HTTP ${run.diagnostics.http_status}` : ""}</p> : !run.webDiagnostics&&<p className="text-sm">Provider request/retry details are unavailable for this historical or interrupted run.</p>}
        {run.webDiagnostics&&<p className="text-sm">Search requests: {run.webDiagnostics.search_requests}/1 · Provider requests: {run.webDiagnostics.provider_requests}/1 · Sources discovered: {run.webDiagnostics.sources_discovered}/5 · stage: {run.webDiagnostics.stage}{run.webDiagnostics.http_status?` · HTTP ${run.webDiagnostics.http_status}`:""}</p>}
        {run.failureCode && <p role="alert" className="text-sm">Execution error: {run.failureCode}. {http===503 ? "The provider is temporarily unavailable." : http===429 ? "Provider quota or rate limit reached; no automatic quota retry." : http===401 || http===403 ? "Provider credentials or access require administrator review." : http===404 ? "Requested model or endpoint is unavailable." : http===400 ? "Provider rejected the request or schema." : run.failureCode==="timeout" ? "The execution deadline or transport timeout was reached; no timeout retry." : run.failureCode==="invalid_output" ? "Provider evidence or the generated document was invalid; review is unavailable." : run.failureCode==="interrupted" ? "An interrupted execution was recovered." : "Provider execution failed."} No deliverable from this attempt.</p>}
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
        {web?.success&&<><h6 className="mt-3 font-semibold">Web report — externally sourced, not independently verified</h6><p className="text-sm">{web.data.objective}</p><p className="whitespace-pre-wrap">{web.data.summary}</p><ol className="list-decimal pl-5">{web.data.findings.map((f,i)=><li key={i}>{f.claim} · {f.basis.replaceAll("_"," ")} {f.source_ids.join(", ")}</li>)}</ol><h6 className="mt-3 font-semibold">Provider evidence excerpts</h6><ul>{web.data.sources.map(source=><li className="my-2" key={source.id}><a className="underline" href={source.url} target="_blank" rel="noopener noreferrer nofollow">{source.id}: {source.title}</a><p className="break-all text-xs">{source.url}</p><p className="text-xs">Collected {source.retrieved_at} via Tavily; page publication/retrieval time and canonical URL not independently verified.</p><p className="whitespace-pre-wrap text-sm">{source.excerpt}</p></li>)}</ul>{(["unverified_assertions","conflicting_or_incomplete_information","open_questions","recommendations","limitations"] as const).map(key=><div key={key}><h6 className="mt-2 font-semibold">{key.replaceAll("_"," ")}</h6><ul className="list-disc pl-5">{web.data[key].map((item,i)=><li key={i}>{item}</li>)}</ul></div>)}</>}
        {artifact && !valid && <p role="alert">Stored document is invalid; review is blocked.</p>}
        {owner && state==="pending_review" && run.status==="completed" && valid && !review && <div className="mt-3 flex flex-wrap gap-3">
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
