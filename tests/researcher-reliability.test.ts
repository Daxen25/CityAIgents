import {test} from "node:test";
import assert from "node:assert/strict";
import {researcherConfig,generateResearchDocument,executeResearcher,type ResearcherDependencies,type ResearcherGenerationOptions} from "../apps/web/lib/researcher-engine";
import {logPlanningDiagnostic,type PlanningDiagnostic} from "../apps/web/lib/planning-diagnostics";
import {researcherDiagnosticsSchema,type ResearcherDiagnostics} from "@agent-city/core";
const env={AGENT_CITY_MODE:"supabase",AGENT_CITY_RESEARCHER_EXECUTION_ENABLED:"true",GEMINI_API_KEY:"private-key",SUPABASE_SERVICE_ROLE_KEY:"private-service"};
const input={title:"private task",objective:"private objective",expectedDeliverable:"private instructions"};
const document={summary:"Generated brief",requirements:[{title:"Requirement",description:"Input-derived",acceptance_criteria:["Human review"]}],assumptions:[],open_questions:[],limitations:["No external verification"],sources:[],verification:"not_externally_verified"};
const id="11111111-1111-4111-8111-111111111111";
function fixture(statuses:number[],retry=true){
 let time=0,calls=0;const sleeps:number[]=[];const events:PlanningDiagnostic[]=[];let metadata:ResearcherDiagnostics|undefined;
 const options:ResearcherGenerationOptions={now:()=>time,random:()=>0.5,sleep:async(ms)=>{sleeps.push(ms);time+=ms;},onDiagnostic:e=>events.push(e),onMetadata:m=>{metadata=m;}};
 const transport:typeof fetch=async(_url,init)=>{
  calls++;assert.ok(init?.signal);time+=500;const status=statuses.shift()??200;
  return status===200?Response.json({modelVersion:"gemini-fixture",candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(document)}]}}]}):new Response("private provider body",{status});
 };
 const config=researcherConfig({...env,AGENT_CITY_RESEARCHER_503_RETRY_ENABLED:retry?"true":"false"});
 return {options,transport,config,sleeps,events,setTime:(t:number)=>{time=t;},calls:()=>calls,metadata:()=>metadata};
}
test("Researcher retry is disabled by default and accepts only explicit true",()=>{
 for(const value of [undefined,"false","1","TRUE"])assert.equal(researcherConfig({...env,AGENT_CITY_RESEARCHER_503_RETRY_ENABLED:value}).retryEnabled,false);
 assert.equal(researcherConfig({...env,AGENT_CITY_RESEARCHER_503_RETRY_ENABLED:"true"}).retryEnabled,true);
});
test("immediate success and 503 then success retain one document and bounded separate request count",async()=>{
 for(const statuses of [[200],[503,200]]){
  const f=fixture([...statuses]);let model="";
  assert.deepEqual(await generateResearchDocument(f.config,input,f.transport,v=>{model=v;},f.options),document);
  assert.equal(f.calls(),statuses.length);assert.equal(model,"gemini-fixture");
  assert.equal(f.metadata()?.provider_requests,statuses.length);assert.equal(f.metadata()?.retry_performed,statuses.length===2);
  assert.equal(f.metadata()?.http_status,200);assert.ok(researcherDiagnosticsSchema.safeParse(f.metadata()).success);
  assert.deepEqual(f.sleeps,statuses.length===2?[375]:[]);
 }
});
test("only one additional request after 503; disabled, non-503, invalid output and uncertain errors never retry",async()=>{
 for(const [statuses,retry,expected] of [[[503,503,200],true,2],[[503,200],false,1],...([400,401,403,404,429,500,502,504].map(s=>[[s,200],true,1]))] as [number[],boolean,number][]){
  const f=fixture(statuses,retry);await assert.rejects(generateResearchDocument(f.config,input,f.transport,undefined,f.options),/provider_error/);assert.equal(f.calls(),expected);
 }
 for(const error of [new DOMException("private","TimeoutError"),new TypeError("private")]){
  const f=fixture([]);let calls=0;await assert.rejects(generateResearchDocument(f.config,input,async()=>{calls++;throw error;},undefined,f.options));assert.equal(calls,1);assert.deepEqual(f.sleeps,[]);
 }
 const f=fixture([]);let calls=0;await assert.rejects(generateResearchDocument(f.config,input,async()=>{calls++;return Response.json({invalid:"private"});},undefined,f.options),/invalid_output/);assert.equal(calls,1);assert.deepEqual(f.sleeps,[]);
});
test("both requests and jitter share 30s; no request after action/lease budget or overslept backoff",async()=>{
 const f=fixture([503,200]);f.options.deadlineMs=1000;
 await assert.rejects(generateResearchDocument(f.config,input,f.transport,undefined,f.options),/provider_error/);assert.equal(f.calls(),1);assert.deepEqual(f.sleeps,[]);
 const expired=fixture([200]);expired.options.deadlineMs=0;
 await assert.rejects(generateResearchDocument(expired.config,input,expired.transport,undefined,expired.options),/timeout/);assert.equal(expired.calls(),0);
 const late=fixture([503,200]);late.options.sleep=async()=>late.setTime(30001);
 await assert.rejects(generateResearchDocument(late.config,input,late.transport,undefined,late.options),/timeout/);assert.equal(late.calls(),1);
 const budgets:number[]=[];const shared=fixture([503,200]);
 await generateResearchDocument(shared.config,input,async(url,init)=>{
  const signal=init?.signal;assert.ok(signal);budgets.push(shared.calls());return shared.transport(url,init);
 },undefined,shared.options);
 assert.equal(shared.metadata()?.provider_elapsed_ms,1375);assert.equal(shared.calls(),2);
});
test("one owner-authorized run, one start and one atomic finalizer despite two provider requests",async()=>{
 const f=fixture([503,200]);let claim=0,start=0,finish=0;let written:ResearcherDiagnostics|undefined;
 const deps:ResearcherDependencies={config:()=>f.config,authenticate:async()=>{},capability:()=>({hash:"a".repeat(64)}),
  claim:async()=>{claim++;return {runId:id,...input};},start:async()=>{start++;},now:()=>0,
  generate:(c,i,m,options)=>generateResearchDocument(c,i,f.transport,m,{...options,...f.options,onMetadata:options?.onMetadata}),
  finish:async(_r,_h,doc,error,model,metadata)=>{finish++;assert.deepEqual(doc,document);assert.equal(error,null);assert.equal(model,"gemini-fixture");written=metadata;}};
 await executeResearcher({taskId:id,requestId:id,confirmed:true},deps);
 assert.deepEqual([claim,start,finish,f.calls()],[1,1,1,2]);assert.equal(written?.provider_requests,2);
});
test("sanitized retry diagnostics cannot disclose secrets and include requested/resolved model",async()=>{
 const f=fixture([503,200]);await generateResearchDocument(f.config,input,f.transport,undefined,f.options);
 const lines:string[]=[];f.events.forEach(e=>logPlanningDiagnostic({...e,runId:id},l=>lines.push(l),"researcher"));
 for(const secret of [env.GEMINI_API_KEY,env.SUPABASE_SERVICE_ROLE_KEY,input.title,input.objective,input.expectedDeliverable,"private provider body"])assert.ok(!lines.join("").includes(secret));
 assert.ok(lines.some(l=>l.includes('"providerRequest":2')));assert.ok(lines.some(l=>l.includes('"retryDecision":"performed"')));
 assert.ok(lines.some(l=>l.includes('"requestedModel":"gemini-flash-latest"')));assert.ok(lines.some(l=>l.includes('"resolvedModel":"gemini-fixture"')));
 const bad:string[]=[];logPlanningDiagnostic({stage:"generation",outcome:"failed",elapsedMs:0,providerRequest:500,retryEligible:"private",retryDecision:"private",requestedModel:"private data",resolvedModel:"private data"} as unknown as PlanningDiagnostic,l=>bad.push(l));assert.ok(!bad.join("").includes("private"));
});

test("slow authorization cannot start generation past the action deadline",async()=>{
 let time=0,calls=0,claims=0;const f=fixture([200]);let saved:ResearcherDiagnostics|undefined;
 const deps:ResearcherDependencies={config:()=>f.config,now:()=>time,authenticate:async()=>{time=44000;},capability:()=>({hash:"a".repeat(64)}),
  claim:async()=>{claims++;time=49000;return {runId:id,...input};},start:async()=>{},
  generate:(config,input,model,options)=>generateResearchDocument(config,input,async()=>{calls++;return Response.json({});},model,options),
  finish:async(_run,_hash,doc,error,_model,metadata)=>{assert.equal(doc,null);assert.equal(error,"timeout");saved=metadata;}};
 await assert.rejects(executeResearcher({taskId:id,requestId:id,confirmed:true},deps),/timeout/);
 assert.equal(claims,1);assert.equal(calls,0);assert.equal(saved?.provider_requests,0);assert.equal(saved?.timeout_source,"application_deadline");
 time=0;deps.authenticate=async()=>{time=46000;};claims=0;
 await assert.rejects(executeResearcher({taskId:id,requestId:id,confirmed:true},deps),/deadline exceeded/);assert.equal(claims,0);
});
