import { z } from 'zod';
const text=(max:number)=>z.string().trim().min(1).max(max).refine(s=>!s.includes('\u0000')&&s.isWellFormed(),'Invalid text');
export const extensionSchema=z.strictObject({
 summary:text(1000),tasks:z.array(z.strictObject({
  title:text(200),description:text(1000),priority:z.enum(['low','medium','high']),
  suggested_agent_role:z.enum(['chief-of-staff','researcher','developer']),expected_deliverable:text(2000),
  dependencies:z.array(z.strictObject({existing_task_id:z.uuid().nullable(),proposal_position:z.number().int().min(1).max(8).nullable()})).max(5),
 })).min(1).max(8),
}).superRefine((v,c)=>v.tasks.forEach((t,i)=>t.dependencies.forEach(d=>{
 if((d.existing_task_id===null)===(d.proposal_position===null)|| (d.proposal_position!==null&&d.proposal_position>=i+1))c.addIssue({code:'custom',message:'Dependencies must reference existing tasks or earlier additions'});
})));
export type ExtensionPlan=z.infer<typeof extensionSchema>;
export const extensionRequestSchema=z.strictObject({missionId:z.uuid(),requestId:z.uuid(),instruction:text(2000),confirmed:z.literal(true)});
export const extensionReviewSchema=z.strictObject({proposalId:z.uuid(),requestId:z.uuid(),acceptedPositions:z.array(z.number().int().min(1).max(8)).max(8),confirmed:z.literal(true)}).refine(v=>new Set(v.acceptedPositions).size===v.acceptedPositions.length,'Duplicate selection');
export interface ExtensionProposal {
 id:string;mission_id:string;version:number;requested_by:string;instruction:string;model:string;resolved_model:string|null;
 status:'running'|'proposed'|'approved'|'rejected'|'failed'|'stale';proposal:unknown;created_at:string;expires_at:string;failure_code:string|null;
}
export interface ExtensionReview {id:string;proposal_id:string;accepted_positions:number[];decided_by:string;decided_at:string}
export interface ExtensionTask {id:string;mission_id:string;extension_id:string;title:string;status:string;proposal_position:number;suggested_agent_role:string;expected_deliverable:string;agent_id:string}
