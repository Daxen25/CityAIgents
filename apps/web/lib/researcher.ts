import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { researcherDiagnosticsSchema, researcherReviewInput, type ResearcherRun, type ResearcherArtifact, type ResearcherReview } from "@agent-city/core";
import { requireUser } from "./auth";
import { mode, supabaseConfig } from "./config";
import { supabase } from "./supabase";
import { executeResearcher, generateResearchDocument, researcherConfig } from "./researcher-engine";
import { logPlanningDiagnostic, PlanningRpcError, diagnosticError } from "./planning-diagnostics";
export function researcherEnabled() { return mode()==="supabase" && process.env.AGENT_CITY_RESEARCHER_EXECUTION_ENABLED==="true"; }
function checked<T>(result: { data: T; error: unknown; status?: number }): T {
  if (result.error) throw new PlanningRpcError(result.error,result.status);
  return result.data;
}
export async function authorizeResearcher(input: unknown) {
  let trusted: SupabaseClient;
  const actionSignal=AbortSignal.timeout(55_000);
  const bounded=(ms:number)=>AbortSignal.any([actionSignal,AbortSignal.timeout(ms)]);
  await executeResearcher(input,{
    config: () => {
      const config=researcherConfig(process.env);
      trusted=createClient(supabaseConfig().url,config.serviceKey,{ auth: { persistSession:false,autoRefreshToken:false,detectSessionInUrl:false } });
      return config;
    },
    authenticate: async () => { await requireUser(); },
    capability: () => ({ hash:createHash("sha256").update(randomBytes(32)).digest("hex") }),
    claim: async (tid,token_hash,selected_model,request_id) => checked(await (await supabase()).rpc("authorize_researcher_execution",{ tid,token_hash,selected_model,request_id,confirmed:true }).retry(false).abortSignal(bounded(5_000))),
    start: async (rid,token_hash) => { checked(await trusted.rpc("start_researcher_execution",{ rid,token_hash }).retry(false).abortSignal(bounded(5_000))); },
    generate: (config,input,onModelVersion,options) => generateResearchDocument(config,input,fetch,onModelVersion,options),
    finish: async (rid,token_hash,doc,error_code,model_version,execution_metadata) => { checked(await trusted.rpc("finish_researcher_execution_with_diagnostics",{ rid,token_hash,doc,error_code,model_version,execution_metadata }).retry(false).abortSignal(bounded(10_000))); },
    diagnostic: (event) => logPlanningDiagnostic(event,console.info,"researcher"),
  });
}
export async function recoverResearcher(runId: string) {
  z.uuid().parse(runId); if (mode()!=="supabase") throw new Error("Researcher recovery is unavailable in mock mode");
  await requireUser();
  await mutation("recover",() => supabase().then((db) => db.rpc("recover_researcher_execution",{ rid:runId }).retry(false).abortSignal(AbortSignal.timeout(10_000))),runId);
}
export async function reviewResearcher(input: unknown) {
  const data=researcherReviewInput.parse(input);
  if (mode()!=="supabase") throw new Error("Deliverable review is unavailable in mock mode");
  await requireUser();
  await mutation("review",() => supabase().then((db) => db.rpc("review_researcher_deliverable",{ rid:data.runId,decision:data.decision,confirmed:true,request_id:data.requestId }).retry(false).abortSignal(AbortSignal.timeout(10_000))),data.runId);
}
async function mutation(stage: "recover" | "review", work: () => PromiseLike<{ data: unknown; error: unknown; status?: number }>,runId: string) {
  const start=performance.now(); logPlanningDiagnostic({ stage,outcome:"started",runId,elapsedMs:0 },console.info,"researcher");
  try { checked(await work()); logPlanningDiagnostic({ stage,outcome:"succeeded",runId,elapsedMs:performance.now()-start },console.info,"researcher"); }
  catch (error) { logPlanningDiagnostic({ stage,outcome:"failed",runId,elapsedMs:performance.now()-start,...diagnosticError(error) },console.info,"researcher"); throw error; }
}
export async function researcherSnapshot(hasApprovedTasks: boolean): Promise<{ runs: ResearcherRun[]; artifacts: ResearcherArtifact[]; reviews: ResearcherReview[] }> {
  if (!hasApprovedTasks || mode()!=="supabase") return { runs:[],artifacts:[],reviews:[] };
  const db=await supabase();
  const [runs,artifacts,reviews]=await Promise.all([
    db.from("runs").select("id,task_id,mission_id,model,resolved_model,status,started_at,ended_at,expires_at,failure_code,execution_metadata").eq("purpose","researcher").order("started_at"),
    db.from("artifacts").select("id,task_id,run_id,content").eq("kind","researcher_document"),
    db.from("task_execution_reviews").select("id,run_id,decision,decided_by,decided_at"),
  ]);
  return {
    runs:(checked(runs)??[]).map((r) => ({ id:r.id,taskId:r.task_id,missionId:r.mission_id,model:r.model,resolvedModel:r.resolved_model ?? null,status:r.status,startedAt:r.started_at,endedAt:r.ended_at,expiresAt:r.expires_at,failureCode:r.failure_code,diagnostics:researcherDiagnosticsSchema.safeParse(r.execution_metadata).data ?? null })),
    artifacts:(checked(artifacts)??[]).map((a) => ({ id:a.id,taskId:a.task_id,runId:a.run_id,content:a.content })),
    reviews:(checked(reviews)??[]).map((r) => ({ id:r.id,runId:r.run_id,decision:r.decision,decidedBy:r.decided_by,decidedAt:r.decided_at })),
  };
}
