import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extensionSchema,extensionRequestSchema,extensionReviewSchema} from '@agent-city/core';
import {extensionConfig,generateExtension,executeExtension,type ExtensionDependencies} from '../apps/web/lib/extension-engine';
import {PlanningFailure,PlanningRpcError,logPlanningDiagnostic,type PlanningDiagnostic} from '../apps/web/lib/planning-diagnostics';
const id='11111111-1111-4111-8111-111111111111';
const env={AGENT_CITY_MODE:'supabase',AGENT_CITY_MISSION_EXTENSIONS_ENABLED:'true',GEMINI_API_KEY:'fixture-private-key',SUPABASE_SERVICE_ROLE_KEY:'fixture-service'};
const context={mission:{title:'Private mission',objective:'Private objective'},tasks:[],accepted_deliverables:[],instruction:'Private instruction'};
const plan={summary:'Additional work',tasks:[{title:'Follow-up',description:'Input-derived scope',priority:'medium' as const,suggested_agent_role:'researcher' as const,expected_deliverable:'Brief',dependencies:[]}]};
const request={missionId:id,requestId:id,instruction:'Add follow-up',confirmed:true};
function fixture(){
 const calls:string[]=[];const events:PlanningDiagnostic[]=[];
 const deps:ExtensionDependencies={config:()=>extensionConfig(env),authenticate:async()=>{calls.push('auth');},capability:()=> 'a'.repeat(64),
 claim:async()=>{calls.push('claim');return {proposalId:id,context};},generate:async()=>{calls.push('gemini');return plan;},
 finish:async(_p,_h,doc,error)=>{calls.push(error??'persist');assert.deepEqual(doc,error?null:plan);},diagnostic:e=>events.push(e)};
 return {deps,calls,events};
}
test('extensions are independently opt-in, Gemini only and do not inherit Researcher retries or planning provider',()=>{
 assert.equal(extensionConfig({...env,AGENT_CITY_AI_PROVIDER:'openai',AGENT_CITY_RESEARCHER_503_RETRY_ENABLED:'true'}).model,'gemini-flash-latest');
 assert.equal(extensionConfig({...env,GEMINI_MODEL:'gemini-3.6-flash'}).model,'gemini-3.6-flash');
 for(const overrides of [{AGENT_CITY_MISSION_EXTENSIONS_ENABLED:undefined},{AGENT_CITY_MISSION_EXTENSIONS_ENABLED:'false'},{AGENT_CITY_MODE:'mock'},{GEMINI_API_KEY:''},{SUPABASE_SERVICE_ROLE_KEY:''},{GEMINI_MODEL:'../model'}])assert.throws(()=>extensionConfig({...env,...overrides}));
});
test('strict extension schema bounds text, roles, priorities and acyclic suggested dependencies',()=>{
 assert.deepEqual(extensionSchema.parse(plan),plan);
 for(const bad of [{...plan,tasks:[]},{...plan,tasks:Array(9).fill(plan.tasks[0])},{...plan,summary:'x'.repeat(1001)},{...plan,tasks:[{...plan.tasks[0],priority:'urgent'}]},{...plan,tasks:[{...plan.tasks[0],suggested_agent_role:'browser'}]},{...plan,tasks:[{...plan.tasks[0],description:'\u0000'}]},{...plan,tasks:[{...plan.tasks[0],dependencies:[{existing_task_id:null,proposal_position:1}]}]},{...plan,tasks:[{...plan.tasks[0],dependencies:[{existing_task_id:id,proposal_position:1}]}]},{...plan,execute:true}])assert.equal(extensionSchema.safeParse(bad).success,false);
 assert.equal(extensionRequestSchema.safeParse({...request,confirmed:false}).success,false);
 assert.equal(extensionReviewSchema.safeParse({proposalId:id,requestId:id,acceptedPositions:[1,1],confirmed:true}).success,false);
});
test('one bounded synthetic extension transport, no tools or provider fallback, bounded context',async()=>{
 let calls=0,resolved='';
 const result=await generateExtension(extensionConfig(env),context,m=>{resolved=m;},async(url,options)=>{
  calls++;assert.match(String(url),/generativelanguage.googleapis.com/);assert.equal(options?.redirect,'error');assert.equal(new Headers(options?.headers).get('x-goog-api-key'),env.GEMINI_API_KEY);
  const body=JSON.parse(String(options?.body));assert.equal(body.generationConfig.maxOutputTokens,4000);assert.equal(body.generationConfig.candidateCount,1);assert.equal(body.generationConfig.responseJsonSchema.properties.tasks.maxItems,8);assert.equal(body.tools,undefined);
  assert.deepEqual(JSON.parse(body.contents[0].parts[0].text),context);assert.match(body.systemInstruction.parts[0].text,/untrusted/);
  return Response.json({modelVersion:'gemini-fixture',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(plan)}]}}]});
 });assert.deepEqual(result,plan);assert.equal(calls,1);assert.equal(resolved,'gemini-fixture');
 await assert.rejects(generateExtension(extensionConfig(env),{data:'x'.repeat(12001)},()=>{},async()=>{throw new Error('Should not call');}),/invalid_output/);
 for(const status of [400,401,403,404,429,503]){let count=0;await assert.rejects(generateExtension(extensionConfig(env),context,()=>{},async()=>{count++;return new Response('private response',{status});}),/provider_error/);assert.equal(count,1);}
 await assert.rejects(generateExtension(extensionConfig(env),context,()=>{},async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({...plan,tasks:[{...plan.tasks[0],dependencies:[{existing_task_id:id,proposal_position:null}]}]})}]}}]})),/invalid_output/);
 await assert.rejects(generateExtension(extensionConfig(env),context,()=>{},async()=>{throw new DOMException('private detail','TimeoutError');}),/timeout/);
 await assert.rejects(generateExtension(extensionConfig(env),context,()=>{},async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"private":"invalid"}'}]}}]})),/invalid_output/);
});
test('fresh authorization, flag, session and atomic owner claim precede generation',async()=>{
 for(const stage of ['consent','flag','auth','claim']){
  const {deps,calls}=fixture();
  if(stage==='flag')deps.config=()=>extensionConfig({...env,AGENT_CITY_MISSION_EXTENSIONS_ENABLED:'false'});
  if(stage==='auth')deps.authenticate=async()=>{throw new Error('Denied');};if(stage==='claim')deps.claim=async()=>{throw new PlanningRpcError({code:'42501'},403);};
  await assert.rejects(executeExtension({...request,confirmed:stage!=='consent'},deps));assert.ok(!calls.includes('gemini'));assert.ok(!calls.includes('persist'));
 }
 const {deps,calls}=fixture();await executeExtension(request,deps);assert.deepEqual(calls,['auth','claim','gemini','persist']);
});
test('generation failures persist once; ambiguous success/failure persistence never retries or overwrites',async()=>{
 for(const code of ['timeout','provider_error','invalid_output'] as const){const {deps,calls}=fixture();deps.generate=async()=>{calls.push('gemini');throw new PlanningFailure(code);};await assert.rejects(executeExtension(request,deps),new RegExp(code));assert.deepEqual(calls,['auth','claim','gemini',code]);}
 const {deps,calls,events}=fixture();deps.finish=async()=>{calls.push('finish');throw new PlanningRpcError({code:'23514',details:'private output'},400);};
 await assert.rejects(executeExtension(request,deps),/persistence could not be confirmed/);assert.deepEqual(calls,['auth','claim','gemini','finish']);assert.equal(events.at(-1)?.code,'23514');
 const logs:string[]=[];events.forEach(e=>logPlanningDiagnostic(e,s=>logs.push(s),'extension'));for(const secret of [env.GEMINI_API_KEY,context.instruction,'a'.repeat(64),'private output'])assert.ok(!logs.join('').includes(secret));
 const failure=fixture();failure.deps.generate=async()=>{throw new PlanningFailure('timeout');};failure.deps.finish=async()=>{throw new Error('No response');};await assert.rejects(executeExtension(request,failure.deps),/interrupted/);
});
test('the action budget prevents provider calls after slow authentication/claim and caps provider time',async()=>{
 const {deps,calls}=fixture();let time=0;deps.now=()=>time;deps.authenticate=async()=>{time=41000;};
 await assert.rejects(executeExtension(request,deps),/deadline exceeded/);assert.ok(!calls.includes('claim'));
 time=0;deps.authenticate=async()=>{time=39000;};deps.claim=async()=>{time=45000;return {proposalId:id,context};};
 await assert.rejects(executeExtension(request,deps),/timeout/);assert.ok(!calls.includes('gemini'));
 const success=fixture();success.deps.generate=async(_c,_ctx,_model,timeout)=>{assert.ok(timeout<=30000&&timeout>29000);return plan;};await executeExtension(request,success.deps);
});
