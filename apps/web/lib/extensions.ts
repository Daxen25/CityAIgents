import 'server-only';
import {createHash,randomBytes} from 'node:crypto';
import {createClient,type SupabaseClient} from '@supabase/supabase-js';
import {extensionReviewSchema,type ExtensionProposal,type ExtensionReview,type ExtensionTask} from '@agent-city/core';
import {requireUser} from './auth';
import {mode,supabaseConfig} from './config';
import {supabase} from './supabase';
import {executeExtension,extensionConfig,generateExtension} from './extension-engine';
import {PlanningRpcError,logPlanningDiagnostic} from './planning-diagnostics';
export const extensionsEnabled=()=>mode()==='supabase'&&process.env.AGENT_CITY_MISSION_EXTENSIONS_ENABLED==='true';
function checked<T>(r:{data:T;error:unknown;status?:number}):T{
 if(r.error){const error=new PlanningRpcError(r.error,r.status);const publicMessages=['Mission context exceeds 30 tasks','Mission context exceeds 12000 bytes','Finish or recover active work before extending','Approved AI mission required','Accept required dependencies or reject dependent task','Extension already reviewed'];
  const message=typeof r.error==='object'&&r.error!==null&&'message' in r.error?r.error.message:undefined;
  if(typeof message==='string'&&publicMessages.includes(message))error.message=message;throw error;
 }return r.data;
}
export async function proposeExtension(input:unknown){
 let trusted:SupabaseClient;const deadline=AbortSignal.timeout(55_000);const signal=(ms:number)=>AbortSignal.any([deadline,AbortSignal.timeout(ms)]);
 await executeExtension(input,{
  config:()=>{const config=extensionConfig(process.env);trusted=createClient(supabaseConfig().url,config.serviceKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});return config;},
  authenticate:async()=>{await requireUser();},capability:()=>createHash('sha256').update(randomBytes(32)).digest('hex'),
  claim:async(mid,instruction,request_id,token_hash,selected_model)=>checked(await(await supabase()).rpc('begin_mission_extension',{mid,instruction,request_id,token_hash,selected_model,confirmed:true}).retry(false).abortSignal(signal(5000))),
  generate:(config,context,onModel,timeoutMs)=>generateExtension(config,context,onModel,fetch,timeoutMs),
  finish:async(pid,token_hash,doc,error_code,model_version)=>{checked(await trusted.rpc('finish_mission_extension',{pid,token_hash,doc,error_code,model_version}).retry(false).abortSignal(signal(10000)));},
  diagnostic:event=>logPlanningDiagnostic(event,console.info,'extension'),
 });
}
export async function reviewExtension(input:unknown){
 if(mode()!=='supabase')throw new Error('Extension review unavailable');await requireUser();const d=extensionReviewSchema.parse(input);
 const result=checked(await(await supabase()).rpc('review_mission_extension',{pid:d.proposalId,accepted_positions:d.acceptedPositions,request_id:d.requestId,confirmed:true}).retry(false).abortSignal(AbortSignal.timeout(10000)));
 if(result===null)throw new Error('Mission context changed. Proposal is stale; request a fresh extension.');
}
export async function recoverExtension(pid:string){
 if(mode()!=='supabase')throw new Error('Extension recovery unavailable');await requireUser();
 checked(await(await supabase()).rpc('recover_mission_extension',{pid}).retry(false).abortSignal(AbortSignal.timeout(10000)));
}
export async function extensionSnapshot(hasMissions:boolean):Promise<{proposals:ExtensionProposal[];reviews:ExtensionReview[];tasks:ExtensionTask[]}>{
 if(!hasMissions||mode()!=='supabase')return {proposals:[],reviews:[],tasks:[]};
 const db=await supabase();const p=await db.from('mission_extensions').select('id,mission_id,version,requested_by,instruction,model,resolved_model,status,created_at,expires_at,proposal,failure_code').order('version');
 // Disabled pre-migration rollout is safe; other errors/drift are never silently hidden.
 if(!extensionsEnabled()&&p.error&&['42P01','PGRST205'].includes(p.error.code))return {proposals:[],reviews:[],tasks:[]};
 const proposals=checked(p)??[];if(!proposals.length)return {proposals:[],reviews:[],tasks:[]};
 const [r,t]=await Promise.all([
  db.from('mission_extension_reviews').select('id,proposal_id,accepted_positions,decided_by,decided_at'),
  db.from('tasks').select('id,mission_id,extension_id,title,status,proposal_position,suggested_agent_role,expected_deliverable,agent_id,execution_status').not('extension_id','is',null),
 ]);return {proposals,reviews:checked(r)??[],tasks:checked(t)??[]};
}
