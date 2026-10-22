import { test } from "node:test";
import assert from "node:assert/strict";
import { researchDocumentSchema } from "@agent-city/core";
import { researcherConfig,generateResearchDocument,executeResearcher,type ResearcherDependencies } from "../apps/web/lib/researcher-engine";
import { z } from "zod";
import { planSchema } from "@agent-city/core";
import { PlanningFailure, generateGeminiPlan } from "../apps/web/lib/planning-providers";
import { GeminiHttpFailure,PlanningRpcError,logPlanningDiagnostic,type PlanningDiagnostic } from "../apps/web/lib/planning-diagnostics";
const id="11111111-1111-4111-8111-111111111111";
const env={AGENT_CITY_MODE:"supabase",AGENT_CITY_RESEARCHER_EXECUTION_ENABLED:"true",GEMINI_API_KEY:"fixture-key",SUPABASE_SERVICE_ROLE_KEY:"fixture-service"};
const input={objective:"Mission objective",title:"Approved Researcher task",expectedDeliverable:"Requirements brief"};
const doc={summary:"Input-derived brief",requirements:[{title:"Requirement",description:"Derived from the task",acceptance_criteria:["Owner reviews the brief"]}],assumptions:[],open_questions:[],limitations:["No external verification"],sources:[],verification:"not_externally_verified" as const};
const request={taskId:id,requestId:id,confirmed:true};
function dependencies(){
 const calls:string[]=[];const events:PlanningDiagnostic[]=[];
 const deps:ResearcherDependencies={config:()=>researcherConfig(env),authenticate:async()=>{calls.push("auth");},capability:()=>({hash:"a".repeat(64)}),
  claim:async()=>{calls.push("authorize");return {runId:id,...input};},start:async()=>{calls.push("start");},
  generate:async()=>{calls.push("gemini");return doc;},finish:async(_rid,_hash,body,code)=>{calls.push(code??"persist");assert.deepEqual(body,code?null:doc);},diagnostic:(e)=>events.push(e)};
 return {deps,calls,events};
}
test("Researcher has an independent disabled-default flag and never selects OpenAI",()=>{
 assert.equal(researcherConfig(env).model,"gemini-flash-latest");
 assert.equal(researcherConfig({...env,AGENT_CITY_AI_PROVIDER:"openai",GEMINI_MODEL:"gemini-3.5-flash"}).model,"gemini-3.5-flash");
 for(const change of [{AGENT_CITY_RESEARCHER_EXECUTION_ENABLED:undefined},{AGENT_CITY_RESEARCHER_EXECUTION_ENABLED:"false",AGENT_CITY_AI_PLANNING_ENABLED:"true"},{AGENT_CITY_MODE:"mock"},{GEMINI_API_KEY:"",OPENAI_API_KEY:"paid-key"},{SUPABASE_SERVICE_ROLE_KEY:""},{GEMINI_MODEL:"../bad/model"}])assert.throws(()=>researcherConfig({...env,...change}));
});
test("research document rejects sources, verification claims, unknown fields and PostgreSQL-incompatible text",()=>{
 assert.deepEqual(researchDocumentSchema.parse(doc),doc);
 for(const bad of [{...doc,sources:["Invented source"]},{...doc,verification:"verified"},{...doc,citations:[]},{...doc,requirements:[]},{...doc,limitations:[]},{...doc,summary:"\u0000"},{...doc,summary:"\uD800"},{...doc,requirements:[{...doc.requirements[0],acceptance_criteria:[]}]}])assert.equal(researchDocumentSchema.safeParse(bad).success,false);
});
test("Gemini Researcher performs one bounded structured request using only trusted task inputs",async()=>{
 let calls=0; let resolvedModel="";
 const result=await generateResearchDocument(researcherConfig(env),input,async(url,options)=>{
  calls++;assert.equal(String(url),"https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent");
  assert.equal(options?.redirect,"error");assert.equal(new Headers(options?.headers).get("x-goog-api-key"),"fixture-key");assert.ok(options?.signal);
  const body=JSON.parse(String(options?.body));assert.equal(body.generationConfig.maxOutputTokens,4000);assert.equal(body.generationConfig.candidateCount,1);
  assert.equal(body.generationConfig.responseJsonSchema.properties.sources.maxItems,0);
  assert.deepEqual(body.generationConfig.responseJsonSchema.properties.verification.enum,["not_externally_verified"]);
  assert.equal(body.generationConfig.responseJsonSchema.properties.verification.const,undefined);assert.equal(body.tools,undefined);
  assert.match(body.systemInstruction.parts[0].text,/Do not invent sources/);assert.deepEqual(JSON.parse(body.contents[0].parts[0].text),input);
  assert.ok(!String(options?.body).includes("fixture-service"));
  return Response.json({modelVersion:"gemini-flash-fixture",candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(doc)}]}}]});
 }, (model)=>{resolvedModel=model;});
 assert.equal(calls,1);assert.deepEqual(result,doc);assert.equal(resolvedModel,"gemini-flash-fixture");
});
test("rate/quota/auth/provider errors and malformed research output do not retry or fall back",async()=>{
 for(const [status,failureClass] of [[400,"invalid_request_or_schema"],[401,"authentication"],[403,"permission_denied"],[404,"model_or_endpoint_unavailable"],[429,"quota_or_rate_limit"],[500,"server_error"],[503,"server_error"]] as const){
  let calls=0;await assert.rejects(generateResearchDocument(researcherConfig(env),input,async()=>{calls++;return new Response("private response",{status});}),(error:unknown)=>{assert.ok(error instanceof GeminiHttpFailure);assert.equal(error.httpStatus,status);assert.equal(error.failureClass,failureClass);assert.ok(!JSON.stringify(error).includes("private response"));return true;});assert.equal(calls,1);
 }
 await assert.rejects(generateResearchDocument(researcherConfig(env),input,async()=>Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({...doc,sources:["citation"]})}]}}]})),/invalid_output/);
 await assert.rejects(generateResearchDocument(researcherConfig(env),input,async()=>{throw new DOMException("private timeout","TimeoutError");}),/timeout/);
});
test("fresh confirmation, session, claim and trusted start must all precede the model",async()=>{
 for(const phase of ["confirmation","flag","auth","claim","start"]){
  const {deps,calls}=dependencies();
  if(phase==="flag")deps.config=()=>researcherConfig({...env,AGENT_CITY_RESEARCHER_EXECUTION_ENABLED:"false"});
  if(phase==="auth")deps.authenticate=async()=>{throw new Error("denied");};
  if(phase==="claim")deps.claim=async()=>{throw new Error("Owner/assignment/duplicate denial");};
  if(phase==="start")deps.start=async()=>{throw new PlanningRpcError({code:"42501"},403);};
  await assert.rejects(executeResearcher({...request,confirmed:phase!=="confirmation"},deps));assert.ok(!calls.includes("gemini"));assert.ok(!calls.includes("persist"));
 }
 const {deps,calls}=dependencies();await executeResearcher(request,deps);assert.deepEqual(calls,["auth","authorize","start","gemini","persist"]);
});
test("provider failure records a failed attempt, never a fake result or automatic retry",async()=>{
 for(const code of ["timeout","provider_error","invalid_output"] as const){const {deps,calls}=dependencies();deps.generate=async()=>{calls.push("gemini");throw new PlanningFailure(code);};await assert.rejects(executeResearcher(request,deps),new RegExp(code));assert.deepEqual(calls,["auth","authorize","start","gemini",code]);}
});
test("ambiguous result finalization never overwrites success or invokes another model",async()=>{
 const {deps,calls,events}=dependencies();deps.finish=async()=>{calls.push("finish");throw new PlanningRpcError({code:"23514",details:"private-document"},400);};
 await assert.rejects(executeResearcher(request,deps),/persistence could not be confirmed/);assert.deepEqual(calls,["auth","authorize","start","gemini","finish"]);assert.equal(events.at(-1)?.code,"23514");
 const lines:string[]=[];for(const event of events)logPlanningDiagnostic(event,(line)=>lines.push(line),"researcher");assert.ok(lines.every((l)=>l.startsWith("agent_city.researcher ")));assert.ok(!lines.join("").includes("private-document"));
});
test("failed failure-finalization leaves an explicitly recoverable interruption",async()=>{
 const {deps,calls}=dependencies();deps.generate=async()=>{calls.push("gemini");throw new PlanningFailure("timeout");};deps.finish=async()=>{calls.push("finish");throw new Error("transport failed");};
 await assert.rejects(executeResearcher(request,deps),/interrupted/);assert.deepEqual(calls,["auth","authorize","start","gemini","finish"]);
});

test("Researcher HTTP failure diagnostics reach the server sink without private data",async()=>{
 const {deps,calls,events}=dependencies();
 deps.generate=async()=>generateResearchDocument(researcherConfig(env),input,async()=>new Response("private provider response",{status:429}));
 await assert.rejects(executeResearcher(request,deps),/provider_error/);
 assert.deepEqual(calls,["auth","authorize","start","provider_error"]);
 const failure=events.find(e=>e.stage==="generation"&&e.outcome==="failed");
 assert.equal(failure?.httpStatus,429);assert.equal(failure?.failureClass,"quota_or_rate_limit");
 const lines:string[]=[];events.forEach(e=>logPlanningDiagnostic(e,l=>lines.push(l),"researcher"));
 assert.ok(lines.some(l=>l.includes('"httpStatus":429')));
 for(const secret of ["private provider response",input.objective,env.GEMINI_API_KEY,env.SUPABASE_SERVICE_ROLE_KEY,"a".repeat(64)])assert.ok(!lines.join("").includes(secret));
});

test("planning transport keeps its schema and request format while Researcher normalizes its literal",async()=>{
 const plan={summary:"Plan",tasks:[{title:"Task",suggested_agent_role:"researcher",expected_deliverable:"Brief"}],risks:[]};
 await generateGeminiPlan(researcherConfig(env),{title:input.title,objective:input.objective},async(_url,options)=>{
  const body=JSON.parse(String(options?.body));
  assert.deepEqual(body.generationConfig.responseJsonSchema,z.toJSONSchema(planSchema));
  assert.equal(body.generationConfig.responseMimeType,"application/json");
  assert.equal(body.generationConfig.maxOutputTokens,6000);assert.equal(body.generationConfig.candidateCount,1);
  assert.deepEqual(body.contents,[{role:"user",parts:[{text:JSON.stringify({title:input.title,objective:input.objective})}]}]);
  return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(plan)}]}}]});
 });
});
