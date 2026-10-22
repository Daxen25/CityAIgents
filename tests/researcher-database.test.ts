import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync,readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const owner="11111111-1111-4111-8111-111111111111",member="22222222-2222-4222-8222-222222222222",outsider="33333333-3333-4333-8333-333333333333";
const hash="a".repeat(64);
const plan={ summary:"Approved scope",tasks:[
 { title:"Research requirements",suggested_agent_role:"researcher",expected_deliverable:"Requirements brief" },
 { title:"Implement later",suggested_agent_role:"developer",expected_deliverable:"Design only" },
 { title:"Coordinate later",suggested_agent_role:"chief-of-staff",expected_deliverable:"Review only" },
],risks:[] };
export const document={ summary:"Generated from supplied inputs only",requirements:[{title:"User requirement",description:"Draft a requirements brief",acceptance_criteria:["Owner reviews the brief"]}],assumptions:[],open_questions:["What constraints apply?"],limitations:["No browsing or external verification"],sources:[],verification:"not_externally_verified" };
test("M1.4 PostgreSQL supervised Researcher lifecycle and provenance",async(t)=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
   create schema auth; create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
   grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
   create schema storage; create table storage.buckets(id text primary key,name text,public boolean);
   create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
   alter table storage.objects enable row level security; grant usage on schema storage to authenticated; grant select on storage.objects to authenticated;
   create function storage.foldername(text) returns text[] language sql immutable as $$ select (string_to_array($1,'/'))[1:array_length(string_to_array($1,'/'),1)-1] $$;
   alter default privileges grant execute on functions to anon,authenticated;
   alter default privileges grant all on tables to anon,authenticated;`);
  const migration="20261022120000_researcher_execution.sql";
  for(const name of readdirSync("supabase/migrations").sort().filter((n)=>n<migration))await db.exec(readFileSync(`supabase/migrations/${name}`,"utf8"));
  await db.query("insert into auth.users values($1),($2),($3)",[owner,member,outsider]);
  async function asUser(id=owner,role="authenticated") { await db.exec("reset role");await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec(`set role ${role}`); }
  async function scalar<T=string>(sql:string,args:unknown[]=[]):Promise<T>{return Object.values((await db.query<Record<string,T>>(sql,args)).rows[0])[0];}
  await asUser();const wid=await scalar("select public.create_workspace('Researcher tests')");
  await db.exec("reset role");await db.query("insert into public.workspace_members values($1,$2,'member')",[wid,member]);await asUser();
  async function approvedMission(workspace=wid){
   const mid=await scalar("select public.create_mission($1,'Supervised task mission','Generate an input-derived requirements brief','business')",[workspace]);
   const claim=await scalar<{runId:string}>("select public.begin_chief_plan($1,$2,'fixture','gemini')",[mid,hash]);
   await asUser("","service_role");await db.query("select public.finish_chief_plan($1,$2,$3::jsonb,null)",[claim.runId,hash,JSON.stringify(plan)]);await asUser();
   const ids=(await db.query<{id:string}>("select id from public.tasks where mission_id=$1 order by proposal_position",[mid])).rows.map((r)=>r.id);
   const review=await scalar("select public.review_task_plan($1,$2,$3::uuid[],'approved',true,$4)",[mid,claim.runId,ids,randomUUID()]);
   return {mid,ids,review,planRun:claim.runId};
  }
  const existing=await approvedMission();
  await db.exec("reset role; begin");await db.exec(readFileSync(`supabase/migrations/${migration}`,"utf8"));await db.exec("commit");await asUser();
  const authorize=(tid:string,request=randomUUID(),confirmed:boolean|null=true)=>scalar<{runId:string;objective:string;title:string;expectedDeliverable:string}>("select public.authorize_researcher_execution($1,$2,'gemini-flash-latest',$3,$4)",[tid,hash,request,confirmed]);
  async function start(rid:string,capability=hash){await asUser("","service_role");await db.query("select public.start_researcher_execution($1,$2)",[rid,capability]);}
  async function finish(rid:string,doc:unknown=document,code:string|null=null,capability=hash,version:string|null=null){await asUser("","service_role");await db.query("select public.finish_researcher_execution($1,$2,$3::jsonb,$4,$5)",[rid,capability,doc===null?null:JSON.stringify(doc),code,version]);}
  const review=(rid:string,decision="accepted",request=randomUUID(),confirmed:boolean|null=true)=>scalar("select public.review_researcher_deliverable($1,$2,$3,$4)",[rid,decision,confirmed,request]);
  await t.test("populated M1.3 approval remains approved but never automatically executes",async()=>{
   assert.equal(await scalar("select status from public.tasks where id=$1",[existing.ids[0]]),"approved");
   assert.equal(await scalar("select execution_status from public.tasks where id=$1",[existing.ids[0]]),"not_authorized");
   assert.equal(await scalar<number>("select count(*)::int from public.task_execution_authorizations"),0);
  });
  await t.test("owner confirmation and Researcher assignment are enforced in SQL",async()=>{
   for(const confirmed of [false,null])await assert.rejects(authorize(existing.ids[0],randomUUID(),confirmed),/explicit execution authorization/);
   for(const id of [existing.ids[1],existing.ids[2]])await assert.rejects(authorize(id),/Researcher assignment/);
   for(const uid of [member,outsider,""]){await asUser(uid);await assert.rejects(authorize(existing.ids[0]),/owner authorization/);}
   await asUser("","anon");await assert.rejects(authorize(existing.ids[0]),/permission denied/);await asUser();
  });
  let rid:string;const authRequest=randomUUID();
  await t.test("fresh authorization records trusted input and a separate approval per run",async()=>{
   const claim=await authorize(existing.ids[0],authRequest);rid=claim.runId;
   assert.equal(claim.title,plan.tasks[0].title);assert.equal(claim.expectedDeliverable,plan.tasks[0].expected_deliverable);
   assert.equal(await scalar("select execution_status from public.tasks where id=$1",[existing.ids[0]]),"authorized");
   assert.equal(await scalar("select authorized_by from public.task_execution_authorizations where request_id=$1",[authRequest]),owner);
   assert.equal(await scalar("select purpose from public.runs where id=$1",[rid]),"researcher");
   assert.equal(await scalar("select status from public.missions where id=$1",[existing.mid]),"approved");
   await assert.rejects(authorize(existing.ids[0],authRequest),/not eligible/);
  });
  await t.test("client start/finalize and forged statuses/artifacts are denied",async()=>{
   await assert.rejects(db.query("select public.start_researcher_execution($1,$2)",[rid!,hash]),/permission denied/);
   await assert.rejects(db.query("select public.finish_researcher_execution($1,$2,$3::jsonb,null,null)",[rid!,hash,JSON.stringify(document)]),/permission denied/);
   await assert.rejects(db.query("update public.tasks set execution_status='accepted' where id=$1",[existing.ids[0]]),/permission denied/);
   for(const table of ["task_execution_authorizations","task_execution_reviews","artifacts"])await assert.rejects(db.exec(`delete from public.${table}`),/permission denied/);
   for(const name of ["public.start_researcher_execution(uuid,text)","private.start_researcher_execution(uuid,text)","public.finish_researcher_execution(uuid,text,jsonb,text,text)","private.finish_researcher_execution(uuid,text,jsonb,text,text)","private.lock_researcher_run(uuid,text,text)"])
    for(const role of ["anon","authenticated"])assert.equal(await scalar<boolean>("select has_function_privilege($1,$2,'execute')",[role,name]),false);
   await asUser("","service_role");
   await assert.rejects(db.query("select public.finish_chief_plan($1,$2,$3::jsonb,null)",[rid!,hash,JSON.stringify(plan)]),/planning lease/);
   await assert.rejects(finish(existing.planRun),/execution lease/);
   await asUser();
  });
  await t.test("start is single-use and finalization cannot precede actual start",async()=>{
   await assert.rejects(finish(rid!),/execution lease/);
   await assert.rejects(start(rid!,"b".repeat(64)),/execution lease/);
   await start(rid!);await assert.rejects(start(rid!),/execution lease/);
   await asUser();assert.equal(await scalar("select execution_status from public.tasks where id=$1",[existing.ids[0]]),"running");
  });
  await t.test("SQL validates structured output; invalid output never commits partial artifacts",async()=>{
   for(const bad of [{...document,verification:"externally_verified"},{...document,sources:["invented citation"]},{...document,requirements:[]},{...document,extra:true},{...document,requirements:[{...document.requirements[0],title:""}]}])await assert.rejects(finish(rid!,bad),/Invalid/);
   await assert.rejects(finish(rid!,document,null,hash,"bad/model"),/Invalid model provenance/);
   await asUser();assert.equal(await scalar<number>("select count(*)::int from public.artifacts where run_id=$1",[rid!]),0);
   assert.equal(await scalar("select status from public.runs where id=$1",[rid!]),"running");
  });
  await t.test("atomic result provenance is task/run/mission/workspace linked and waits for review",async()=>{
   await finish(rid!,document,null,hash,"gemini-flash-fixture");await assert.rejects(finish(rid!),/execution lease/);await asUser();
   assert.equal(await scalar("select resolved_model from public.runs where id=$1",[rid!]),"gemini-flash-fixture");
   assert.deepEqual(await scalar("select content from public.artifacts where task_id=$1 and run_id=$2 and mission_id=$3 and workspace_id=$4",[existing.ids[0],rid!,existing.mid,wid]),document);
   assert.equal(await scalar("select execution_status from public.tasks where id=$1",[existing.ids[0]]),"pending_review");
   assert.equal(await scalar("select status from public.tasks where id=$1",[existing.ids[0]]),"approved");
   assert.equal(await scalar("select status from public.runs where id=$1",[rid!]),"completed");
   await assert.rejects(authorize(existing.ids[0]),/not eligible/);
  });
  await t.test("owner-only deliverable acceptance is explicit, auditable and idempotent",async()=>{
   await assert.rejects(review(rid!,"accepted",randomUUID(),false),/Explicit deliverable decision/);
   await asUser(member);await assert.rejects(review(rid!),/owner authorization/);await asUser(outsider);await assert.rejects(review(rid!),/owner authorization/);await asUser();
   const request=randomUUID();const id=await review(rid!,"accepted",request);assert.equal(await review(rid!,"accepted",request),id);
   await assert.rejects(review(rid!,"rejected"),/already reviewed/);
   assert.equal(await scalar("select execution_status from public.tasks where id=$1",[existing.ids[0]]),"accepted");
   assert.equal(await scalar("select decided_by from public.task_execution_reviews where id=$1",[id]),owner);
   assert.equal(await scalar<number>("select count(*)::int from public.activity_events where mission_id=$1 and event like 'researcher.deliverable_accepted:%'",[existing.mid]),1);
  });
  await t.test("workspace isolation covers authorization, runs, artifacts and result decisions",async()=>{
   await asUser(outsider);
   for(const table of ["task_execution_authorizations","task_execution_reviews","artifacts","runs"])assert.equal(await scalar<number>(`select count(*)::int from public.${table} where workspace_id=$1`,[wid]),0);
   await assert.rejects(authorize(existing.ids[0]),/owner authorization/);await asUser();
  });
  await t.test("provider/timeout/invalid-output failures save no falsely completed result and cap attempts",async()=>{
   const p=await approvedMission();
   for(const code of ["provider_error","timeout","invalid_output"]){const claim=await authorize(p.ids[0]);await start(claim.runId);await finish(claim.runId,null,code);await asUser();assert.equal(await scalar("select execution_status from public.tasks where id=$1",[p.ids[0]]),"failed");}
   await assert.rejects(authorize(p.ids[0]),/Maximum 3/);
   assert.equal(await scalar<number>("select count(*)::int from public.artifacts where task_id=$1",[p.ids[0]]),0);
  });
  await t.test("authorized/running interruptions need expired lease and fresh request, stale finalizers fail",async()=>{
   for(const shouldStart of [false,true]){
    const p=await approvedMission();const request=randomUUID();const claim=await authorize(p.ids[0],request);if(shouldStart)await start(claim.runId);await asUser();
    await assert.rejects(db.query("select public.recover_researcher_execution($1)",[claim.runId]),/No expired/);
    await asUser(member);await assert.rejects(db.query("select public.recover_researcher_execution($1)",[claim.runId]),/owner authorization/);
    await db.exec("reset role");await db.query("update public.runs set expires_at=clock_timestamp()-interval '1 second' where id=$1",[claim.runId]);await asUser();
    await db.query("select public.recover_researcher_execution($1)",[claim.runId]);await assert.rejects(finish(claim.runId),/execution lease/);await asUser();
    await assert.rejects(authorize(p.ids[0],request),/unique/);
    const fresh=await authorize(p.ids[0]);await start(fresh.runId);await finish(fresh.runId);await asUser();await review(fresh.runId,"rejected");
    assert.equal(await scalar("select execution_status from public.tasks where id=$1",[p.ids[0]]),"rejected");
   }
  });
  await t.test("concurrent authorization and result reviews cannot double-execute or overwrite",async()=>{
   const p=await approvedMission();const results=await Promise.allSettled([authorize(p.ids[0]),authorize(p.ids[0])]);
   assert.equal(results.filter((r)=>r.status==="fulfilled").length,1);
   const claim=(results.find((r)=>r.status==="fulfilled") as PromiseFulfilledResult<{runId:string}>).value;
   await start(claim.runId);await finish(claim.runId);await asUser();
   const decisions=await Promise.allSettled([review(claim.runId,"accepted"),review(claim.runId,"rejected")]);
   assert.equal(decisions.filter((r)=>r.status==="fulfilled").length,1);
   assert.equal(await scalar<number>("select count(*)::int from public.task_execution_reviews where run_id=$1",[claim.runId]),1);
  });
  await t.test("ownership revoked after authorization prevents start/finalization",async()=>{
   const p=await approvedMission();const claim=await authorize(p.ids[0]);
   await db.exec("reset role");await db.query("update public.workspace_members set role='member' where workspace_id=$1 and user_id=$2",[wid,owner]);
   await assert.rejects(start(claim.runId),/authorization no longer valid/);
   await db.exec("reset role");await db.query("update public.workspace_members set role='owner' where workspace_id=$1 and user_id=$2",[wid,owner]);
   await start(claim.runId);
   await db.exec("reset role");await db.query("update public.workspace_members set role='member' where workspace_id=$1 and user_id=$2",[wid,owner]);
   await assert.rejects(finish(claim.runId),/authorization no longer valid/);
   await db.exec("reset role");await db.query("update public.workspace_members set role='owner' where workspace_id=$1 and user_id=$2",[wid,owner]);await asUser();
  });
  await t.test("late audit failure rolls back completed run, result and task state together",async()=>{
   const p=await approvedMission();const claim=await authorize(p.ids[0]);await start(claim.runId);
   await db.exec("reset role; alter table public.activity_events add constraint offline_research_failure check (event not like 'researcher.result_pending_review:%') not valid");
   try {await assert.rejects(finish(claim.runId),/offline_research_failure/);await asUser();
    assert.equal(await scalar<number>("select count(*)::int from public.artifacts where run_id=$1",[claim.runId]),0);
    assert.equal(await scalar("select status from public.runs where id=$1",[claim.runId]),"running");
    assert.equal(await scalar("select execution_status from public.tasks where id=$1",[p.ids[0]]),"running");
   } finally {await db.exec("reset role; alter table public.activity_events drop constraint offline_research_failure");await asUser();}
  });
 } finally {await db.close();}
});
