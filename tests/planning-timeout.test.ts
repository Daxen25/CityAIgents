import { test } from "node:test";
import assert from "node:assert/strict";
import { generateGeminiPlan, executePlanning, planningConfig, type PlanningDependencies } from "../apps/web/lib/planning-engine";
import { generateResearchDocument, researcherConfig } from "../apps/web/lib/researcher-engine";
import { GeminiTransportFailure, diagnosticError, logPlanningDiagnostic, PlanningRpcError, type PlanningDiagnostic } from "../apps/web/lib/planning-diagnostics";

const env={AGENT_CITY_MODE:"supabase",AGENT_CITY_AI_PLANNING_ENABLED:"true",AGENT_CITY_RESEARCHER_EXECUTION_ENABLED:"true",GEMINI_API_KEY:"private-key",SUPABASE_SERVICE_ROLE_KEY:"private-service"};
const id="11111111-1111-4111-8111-111111111111";
const mission={title:"Private mission",objective:"Private objective"};
const plan={summary:"Plan",tasks:[{title:"Task",suggested_agent_role:"researcher" as const,expected_deliverable:"Brief"}],risks:[]};
const envelope={candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(plan)}]}}]};

test("Gemini planning distinguishes its own deadline from transport timeouts at headers and body",async(t)=>{
 for(const phase of ["response_headers","response_body"] as const){
  for(const deadline of [false,true]){
   const controller=new AbortController();if(deadline)controller.abort(new DOMException("private cause","TimeoutError"));
   const timer=t.mock.method(AbortSignal,"timeout",(ms:number)=>{assert.equal(ms,45_000);return controller.signal;});
   let calls=0;
   const transport:typeof fetch=async()=>{calls++;if(phase==="response_headers")throw new DOMException("private network detail","TimeoutError");
    const response=Response.json(envelope);response.json=async()=>{throw new DOMException("private body detail","AbortError");};return response;};
   await assert.rejects(generateGeminiPlan(planningConfig(env),mission,transport),(error:unknown)=>{
    assert.ok(error instanceof GeminiTransportFailure);assert.equal(error.code,"timeout");
    assert.deepEqual(diagnosticError(error),{transportPhase:phase,timeoutSource:deadline?"application_deadline":"transport_timeout",timeoutMs:45_000});
    const lines:string[]=[];logPlanningDiagnostic({stage:"generation",outcome:"failed",elapsedMs:45_100,...diagnosticError(error)},l=>lines.push(l));
    assert.ok(!lines.join("").includes("private"));assert.ok(!JSON.stringify(error).includes("private"));return true;
   });assert.equal(calls,1);timer.mock.restore();
  }
 }
});

test("network failure without an elapsed deadline is not diagnosed as model latency",async()=>{
 await assert.rejects(generateGeminiPlan(planningConfig(env),mission,async()=>{throw new TypeError("private socket details");}),(error:unknown)=>{
  assert.ok(error instanceof GeminiTransportFailure);assert.equal(error.code,"provider_error");assert.equal(error.timeoutSource,"transport_error");return true;
 });
});

test("planning remains 45 seconds and Researcher remains 30 seconds with unchanged error behavior",async(t)=>{
 const durations:number[]=[];const timer=t.mock.method(AbortSignal,"timeout",(ms:number)=>{durations.push(ms);return new AbortController().signal;});
 await generateGeminiPlan(planningConfig(env),mission,async()=>Response.json(envelope));
 await assert.rejects(generateResearchDocument(researcherConfig(env),{...mission,expectedDeliverable:"Brief"},async()=>{throw new DOMException("private detail","TimeoutError");}),(error:unknown)=>{
  assert.ok(error instanceof Error);assert.match(error.message,/timeout/);assert.ok(!(error instanceof GeminiTransportFailure));return true;
 });assert.deepEqual(durations,[45_000,30_000]);timer.mock.restore();
});

function fixture(){
 let providerCalls=0;const writes:Array<{plan:unknown;error:unknown}>=[];const events:PlanningDiagnostic[]=[];
 const deps:PlanningDependencies={config:()=>planningConfig(env),authenticate:async()=>{},capability:()=>({hash:"a".repeat(64)}),
  claim:async()=>({runId:id,...mission}),generate:async(config,input)=>{providerCalls++;return generateGeminiPlan(config,input,async()=>Response.json(envelope));},
  finish:async(_id,_hash,plan,error)=>{writes.push({plan,error});},diagnostic:e=>events.push(e)};
 return {deps,writes,events,calls:()=>providerCalls};
}
test("a provider timeout finalizes exactly one failed attempt with no plan or extra model call",async()=>{
 const f=fixture();f.deps.generate=async(config,input)=>generateGeminiPlan(config,input,async()=>{throw new DOMException("private detail","TimeoutError");});
 await assert.rejects(executePlanning(id,true,f.deps),/timeout/);
 assert.deepEqual(f.writes,[{plan:null,error:"timeout"}]);
 assert.equal(f.events.find(e=>e.stage==="generation"&&e.outcome==="failed")?.timeoutSource,"transport_timeout");
 assert.equal(f.events.at(-1)?.stage,"finalize_failure");assert.equal(f.events.at(-1)?.outcome,"succeeded");
});
test("success persists once; ambiguous persistence never reruns the provider or writes failure",async()=>{
 for(const failed of [false,true]){
  const f=fixture();if(failed)f.deps.finish=async(_id,_hash,plan,error)=>{f.writes.push({plan,error});throw new PlanningRpcError({code:"PGRST000"},503);};
  if(failed)await assert.rejects(executePlanning(id,true,f.deps),/persistence could not be confirmed/);else await executePlanning(id,true,f.deps);
  assert.equal(f.calls(),1);assert.deepEqual(f.writes,[{plan,error:null}]);
 }
});
test("timeout failure-finalization outage remains recoverable and never creates an artifact",async()=>{
 const f=fixture();f.deps.generate=async()=>{throw new GeminiTransportFailure("timeout","response_body","application_deadline",45_000);};
 f.deps.finish=async(_id,_hash,plan,error)=>{f.writes.push({plan,error});throw new PlanningRpcError({},0);};
 await assert.rejects(executePlanning(id,true,f.deps),/Wait two minutes/);assert.deepEqual(f.writes,[{plan:null,error:"timeout"}]);
 assert.equal(f.events.at(-1)?.stage,"finalize_failure");assert.equal(f.events.at(-1)?.outcome,"failed");
});
