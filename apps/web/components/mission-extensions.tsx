import {randomUUID} from 'node:crypto';
import {extensionSchema,type ExtensionProposal,type ExtensionReview,type ExtensionTask} from '@agent-city/core';
import {generateMissionExtension,reviewMissionExtension,recoverMissionExtension} from '@/app/actions';
import {Button} from './ui/button';
import {ExtensionSubmit} from './extension-submit';
export function MissionExtensions({missionId,status,owner,enabled,proposals,reviews,tasks}:{missionId:string;status:string;owner:boolean;enabled:boolean;proposals:ExtensionProposal[];reviews:ExtensionReview[];tasks:ExtensionTask[]}){
 const open=proposals.some(p=>['running','proposed'].includes(p.status));
 return <section className="mt-5 border-t pt-4" aria-label="Extend mission with Chief of Staff">
  <h4 className="font-semibold">Extend mission with Chief of Staff</h4>
  <p className="my-2 text-sm">Additive proposals preserve original work. Existing accepted deliverables may inform suggestions. No automatic execution.</p>
  {owner&&enabled&&status==='approved'&&!open&&<form action={generateMissionExtension}>
   <input type="hidden" name="missionId" value={missionId}/><input type="hidden" name="requestId" value={randomUUID()}/>
   <label className="text-sm">Additional work instruction<textarea name="instruction" required minLength={1} maxLength={2000} placeholder="Describe the new work to propose"/></label>
   <label className="text-sm"><input style={{width:'auto',marginRight:8}} type="checkbox" name="confirmed" value="yes" required/><span>I authorize one potentially paid Gemini request using this mission context. Suggestions require a separate review; no task will execute.</span></label>
   <ExtensionSubmit label="Propose additional tasks"/>
  </form>}
  {!enabled&&<p className="text-sm">New extension generation is disabled. Existing proposals remain reviewable.</p>}
  {open&&<p className="text-sm">Review or recover the existing extension before requesting another. Generation and review may be invalidated by mission changes.</p>}
  {!owner&&<p className="text-sm">Only workspace owners can request or review additions.</p>}
  <h5 className="mt-3 font-semibold">Extension proposal history</h5>
  {!proposals.length&&<p className="text-sm">No additions proposed yet.</p>}
  {proposals.map(p=>{
   const parsed=extensionSchema.safeParse(p.proposal),review=reviews.find(r=>r.proposal_id===p.id);
   return <article className="mt-4 rounded border border-input p-3" key={p.id}>
    <p className="text-sm">Extension {p.version} · {p.status} · {p.resolved_model??p.model} (requested {p.model}) · {p.created_at} · owner {p.requested_by}</p>
    <p className="whitespace-pre-wrap text-sm">Instruction: {p.instruction}</p>
    {p.failure_code&&<p role="alert" className="text-sm">Extension error: {p.failure_code}. Failed/stale attempts never apply tasks. A new proposal requires fresh authorization.</p>}
    {p.status==='running'&&owner&&<form action={recoverMissionExtension}><input type="hidden" name="proposalId" value={p.id}/><p className="text-sm">If interrupted, refresh first; recovery is permitted only after two minutes and makes no model call.</p><Button variant="outline">Recover extension</Button></form>}
    {parsed.success&&<><p className="my-2 text-sm">{parsed.data.summary}</p><form action={reviewMissionExtension}>
     <input type="hidden" name="proposalId" value={p.id}/><input type="hidden" name="requestId" value={randomUUID()}/>
     <ol className="list-decimal space-y-3 pl-5">{parsed.data.tasks.map((t,i)=><li key={i}>
      {owner&&p.status==='proposed'?<label className="font-semibold"><input type="checkbox" name="acceptedPositions" value={i+1} style={{width:'auto',marginRight:8}}/>Accept: {t.title}</label>:<p className="font-semibold">{t.title}</p>}
      <p className="text-sm">{t.description}</p><p className="text-sm">{t.priority} priority · proposed agent: {t.suggested_agent_role}</p><p className="text-sm">Expected deliverable: {t.expected_deliverable}</p>
      {t.dependencies.length>0&&<p className="text-sm">Suggested dependencies: {t.dependencies.map(d=>d.existing_task_id??`addition ${d.proposal_position}`).join(', ')}</p>}
      {review&&<p className="text-sm">Decision: {review.accepted_positions.includes(i+1)?'approved':'rejected'} · review {review.id}</p>}
     </li>)}</ol>
     {owner&&p.status==='proposed'&&<><p className="my-3 text-sm">Only checked additions will become assigned tasks. Unchecked additions are rejected permanently. Select required dependencies too. Confirming with none selected rejects the entire extension.</p><label className="text-sm"><input type="checkbox" name="confirmed" value="yes" required style={{width:'auto',marginRight:8}}/><span>I confirm the complete selection and rejection summary. No work will execute.</span></label><ExtensionSubmit label="Confirm extension review"/></>}
    </form></>}
    {p.status==='stale'&&owner&&<form action={reviewMissionExtension}><input type="hidden" name="proposalId" value={p.id}/><input type="hidden" name="requestId" value={randomUUID()}/><label className="text-sm"><input type="checkbox" name="confirmed" value="yes" required style={{width:'auto',marginRight:8}}/><span>Reject this stale proposal. Existing work remains unchanged.</span></label><Button variant="outline">Reject stale extension</Button></form>}
    {review&&<p className="text-sm">Reviewed by {review.decided_by} at {review.decided_at}.</p>}
   </article>;
  })}
  <h5 className="mt-4 font-semibold">Approved additions · separate from original plan tasks</h5>
  <ul className="space-y-2">{tasks.map(t=><li className="text-sm" key={t.id}>{t.title} · {t.status} · assigned {t.suggested_agent_role} ({t.agent_id}) · extension {proposals.find(p=>p.id===t.extension_id)?.version}. Execution unavailable for additions in M1.5A; original-plan execution approvals cannot be reused.</li>)}</ul>
 </section>;
}
