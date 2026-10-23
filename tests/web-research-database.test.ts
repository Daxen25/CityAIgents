import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const owner='11111111-1111-4111-8111-111111111111',member='22222222-2222-4222-8222-222222222222',outsider='33333333-3333-4333-8333-333333333333';
const hash='a'.repeat(64);
const plan={summary:'Original plan',tasks:[{title:'Original research',suggested_agent_role:'researcher',expected_deliverable:'Brief'}],risks:[]};
const document={summary:'Accepted original output',requirements:[{title:'Requirement',description:'Input derived',acceptance_criteria:['Human review']}],assumptions:[],open_questions:[],limitations:['No external verification'],sources:[],verification:'not_externally_verified'};
const addition={summary:'Additional work',tasks:[{title:'New research',description:'Additional scope',priority:'medium',suggested_agent_role:'researcher',expected_deliverable:'New brief',dependencies:[]},{title:'Design draft',description:'Future design',priority:'high',suggested_agent_role:'developer',expected_deliverable:'Draft',dependencies:[]}]};
test('M1.5B PostgreSQL provenance-aware web Researcher',async(t)=>{
 const db=new PGlite();try{
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
  for(const name of readdirSync('supabase/migrations').sort().filter(n=>n<'20261023160000'))await db.exec(readFileSync(`supabase/migrations/${name}`,'utf8'));
  await db.query('insert into auth.users values($1),($2),($3)',[owner,member,outsider]);
  async function asUser(id=owner,role='authenticated'){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec(`set role ${role}`);}
  async function scalar<T=any>(sql:string,args:unknown[]=[]):Promise<T>{return Object.values((await db.query<Record<string,T>>(sql,args)).rows[0])[0];}
  await asUser();const wid=await scalar("select public.create_workspace('Extension workspace')");
  await db.exec('reset role');await db.query("insert into public.workspace_members values($1,$2,'member')",[wid,member]);await asUser();
  async function mission(workspace=wid){
   const mid=await scalar("select public.create_mission($1,'Existing mission','Existing mission objective for tests','business')",[workspace]);
   const run=await scalar("select public.begin_chief_plan($1,$2,'fixture','gemini')",[mid,hash]);
   await asUser('','service_role');await db.query('select public.finish_chief_plan($1,$2,$3::jsonb,null)',[run.runId,hash,JSON.stringify(plan)]);await asUser();
   const task=await scalar('select id from public.tasks where mission_id=$1',[mid]);
   await scalar("select public.review_task_plan($1,$2,array[$3]::uuid[],'approved',true,$4)",[mid,run.runId,task,randomUUID()]);return {mid,task};
  }

  const historical=await mission();
  const past=await scalar("select public.authorize_researcher_execution($1,$2,'fixture',$3,true)",[historical.task,hash,randomUUID()]);
  await asUser('','service_role');await db.query('select public.start_researcher_execution($1,$2)',[past.runId,hash]);await db.query('select public.finish_researcher_execution($1,$2,$3::jsonb,null,null)',[past.runId,hash,JSON.stringify(document)]);await asUser();await db.query("select public.review_researcher_deliverable($1,'accepted',true,$2)",[past.runId,randomUUID()]);
  const pastArtifact=await scalar('select to_jsonb(a) from public.artifacts a where run_id=$1',[past.runId]);
  const oldState=await scalar('select to_jsonb(t) from public.tasks t where id=$1',[historical.task]);
  await db.exec('reset role;begin');await db.exec(readFileSync('supabase/migrations/20261023160000_supervised_web_research.sql','utf8'));await db.exec('commit');await asUser();
  assert.deepEqual(await scalar('select to_jsonb(t) from public.tasks t where id=$1',[historical.task]),oldState);
  assert.deepEqual(await scalar('select to_jsonb(a) from public.artifacts a where run_id=$1',[past.runId]),pastArtifact);
  const auth=(tid:string,mode='web',request=randomUUID(),confirmed=true)=>scalar("select public.authorize_researcher_execution_v2($1,$2,'fixture',$3,$4,$5)",[tid,hash,request,confirmed,mode]);
  async function start(rid:string){await asUser('','service_role');await db.query('select public.start_researcher_execution($1,$2)',[rid,hash]);}
  const metadata={search_requests:1,provider_requests:1,sources_discovered:1,stage:'complete',http_status:200};
  const web={objective:'Public research',summary:'Evidence summary',findings:[{claim:'Source describes services',basis:'source_excerpt',source_ids:['S1']}],unverified_assertions:[],conflicting_or_incomplete_information:[],open_questions:[],recommendations:[],limitations:['Not independently verified'],sources:[{id:'S1',title:'Public source',url:'https://www.bbc.com/news',excerpt:'Public excerpt',retrieved_at:'2026-10-23T12:00:00.000Z',provider:'tavily'}],verification:'provider_excerpts_not_independently_verified'};
  const finish=(rid:string,doc:unknown=web,error:string|null=null,meta:unknown=metadata)=>db.query('select public.finish_web_research($1,$2,$3::jsonb,$4,null,$5::jsonb)',[rid,hash,doc===null?null:JSON.stringify(doc),error,JSON.stringify(meta)]);
  async function extension(mid:string,positions=[1]){
   await asUser();const p=await scalar("select public.begin_mission_extension($1,'Add research',$2,$3,'fixture',true)",[mid,randomUUID(),hash]);
   await asUser('','service_role');await db.query('select public.finish_mission_extension($1,$2,$3::jsonb,null,null)',[p.proposalId,hash,JSON.stringify(addition)]);await asUser();
   await db.query('select public.review_mission_extension($1,$2::int[],$3,true)',[p.proposalId,positions,randomUUID()]);
   return (await db.query<any>('select * from public.tasks where extension_id=$1 order by proposal_position',[p.proposalId])).rows;
  }
  await t.test('owner consent, member/anonymous/cross-workspace, mode and service-only finalizers',async()=>{
   const m=await mission();await assert.rejects(auth(m.task,'web',randomUUID(),false),/explicit execution/);
   for(const uid of [member,outsider,'']){await asUser(uid);await assert.rejects(auth(m.task),/owner authorization/);}await asUser('','anon');await assert.rejects(auth(m.task),/permission denied/);await asUser();
   await assert.rejects(auth(m.task,'browser'),/Invalid research mode/);await assert.rejects(finish(randomUUID()),/permission denied/);
   const r=await auth(m.task);const a=await scalar('select to_jsonb(a) from public.task_execution_authorizations a where task_id=$1',[m.task]);assert.equal(a.research_mode,'web');assert.equal(a.search_budget,1);assert.equal(a.synthesis_budget,1);
   await start(r.runId);await assert.rejects(db.query('select public.finish_researcher_execution($1,$2,$3::jsonb,null,null)',[r.runId,hash,JSON.stringify(document)]),/Wrong execution mode/);await finish(r.runId);await asUser();
   await db.query("select public.review_researcher_deliverable($1,'accepted',true,$2)",[r.runId,randomUUID()]);assert.equal(await scalar('select execution_status from public.tasks where id=$1',[m.task]),'accepted');
   await asUser(outsider);assert.equal(await scalar('select count(*)::int from public.artifacts where run_id=$1',[r.runId]),0);await asUser();
  });
  await t.test('approved extension Researcher provenance, immutable content, Developer denial and review',async()=>{
   const m=await mission();const tasks=await extension(m.mid,[1,2]);
   await assert.rejects(auth(tasks[1].id),/Researcher assignment/);const r=await auth(tasks[0].id);
   const a=await scalar('select to_jsonb(a) from public.task_execution_authorizations a where task_id=$1',[tasks[0].id]);assert.equal(a.plan_review_id,null);assert.ok(a.extension_review_id);
   await db.exec('reset role');await assert.rejects(db.query("update public.tasks set title='Forged' where id=$1",[tasks[0].id]),/immutable/);await assert.rejects(db.query("update public.task_execution_authorizations set research_mode='brief' where id=$1",[a.id]),/immutable/);
   await start(r.runId);await finish(r.runId);await asUser();
   const artifact=await scalar('select to_jsonb(a) from public.artifacts a where run_id=$1',[r.runId]);assert.equal(artifact.task_id,tasks[0].id);assert.equal(artifact.mission_id,m.mid);assert.equal(artifact.workspace_id,wid);
   await db.exec('reset role');await assert.rejects(db.query('delete from public.artifacts where id=$1',[artifact.id]),/immutable/);await asUser();
   const req=randomUUID();await db.query("select public.review_researcher_deliverable($1,'accepted',true,$2)",[r.runId,req]);await db.query("select public.review_researcher_deliverable($1,'accepted',true,$2)",[r.runId,req]);
   const snapshot=await scalar("select public.begin_mission_extension($1,'Use accepted evidence',$2,$3,'fixture',true)",[m.mid,randomUUID(),hash]);assert.equal(snapshot.context.accepted_deliverables[0].summary,web.summary);
   assert.equal(await scalar("select count(*)::int from public.runs where mission_id=$1 and purpose='researcher'",[m.mid]),1);
  });
  await t.test('extension current-owner approval and rejected/unreviewed provenance cannot be reused',async()=>{
   const m=await mission();const tasks=await extension(m.mid);await db.exec('reset role');await db.query("update public.workspace_members set role='owner' where workspace_id=$1 and user_id=$2",[wid,member]);await asUser(member);
   await assert.rejects(auth(tasks[0].id),/provenance/);await asUser();
   const p=await scalar("select public.begin_mission_extension($1,'Unreviewed work',$2,$3,'fixture',true)",[m.mid,randomUUID(),hash]);
   await asUser('','service_role');await db.query('select public.finish_mission_extension($1,$2,$3::jsonb,null,null)',[p.proposalId,hash,JSON.stringify(addition)]);await asUser();
   assert.equal(await scalar('select count(*)::int from public.tasks where extension_id=$1',[p.proposalId]),0);await db.query('select public.review_mission_extension($1,array[]::int[],$2,true)',[p.proposalId,randomUUID()]);assert.equal(await scalar('select count(*)::int from public.tasks where extension_id=$1',[p.proposalId]),0);
  });
  await t.test('stale extension and owner revocation fence authorization and trusted start',async()=>{
   const m=await mission();const tasks=await extension(m.mid);
   await db.exec('reset role;alter table public.mission_extensions disable trigger extension_history');await db.query("update public.mission_extensions set status='stale' where id=$1",[tasks[0].extension_id]);await db.exec('alter table public.mission_extensions enable trigger extension_history');await asUser();
   await assert.rejects(auth(tasks[0].id),/provenance/);
   await db.exec('reset role;alter table public.mission_extensions disable trigger extension_history');await db.query("update public.mission_extensions set status='approved' where id=$1",[tasks[0].extension_id]);await db.exec('alter table public.mission_extensions enable trigger extension_history');await asUser();
   const r=await auth(tasks[0].id);await db.exec('reset role');await db.query("update public.workspace_members set role='member' where workspace_id=$1 and user_id=$2",[wid,owner]);
   try{await assert.rejects(start(r.runId),/authorization no longer valid/);}finally{await db.exec('reset role');await db.query("update public.workspace_members set role='owner' where workspace_id=$1 and user_id=$2",[wid,owner]);await asUser();}
  });
  await t.test('strict citations, unsafe URLs, diagnostics budgets and atomic persistence',async()=>{
   const m=await mission();const r=await auth(m.task);await start(r.runId);
   for(const bad of [{...web,findings:[{...web.findings[0],source_ids:['S5']}]},{...web,sources:[{...web.sources[0],url:'https://127.0.0.1/'}]},{...web,sources:[{...web.sources[0],url:'https://metadata.google.internal/'}]},{...web,sources:[]},{...web,verification:'verified'}])await assert.rejects(finish(r.runId,bad));
   await assert.rejects(finish(r.runId,web,null,{...metadata,provider_requests:2}));await asUser();assert.equal(await scalar('select count(*)::int from public.artifacts where run_id=$1',[r.runId]),0);await asUser('','service_role');
   await db.exec("reset role;alter table public.activity_events add constraint offline_web_failure check(event not like 'researcher.result_pending_review:%') not valid");await asUser('','service_role');
   await assert.rejects(finish(r.runId),/offline_web_failure/);await asUser();assert.equal(await scalar('select count(*)::int from public.artifacts where run_id=$1',[r.runId]),0);await asUser('','service_role');
   await db.exec('reset role;alter table public.activity_events drop constraint offline_web_failure');await asUser('','service_role');await finish(r.runId);await assert.rejects(finish(r.runId),/expired execution lease/);await asUser();
  });
  await t.test('concurrent requests, duplicates, attempt cap and interrupted recovery',async()=>{
   const m=await mission();const results=await Promise.allSettled([auth(m.task),auth(m.task)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const rid=(results.find(r=>r.status==='fulfilled') as any).value.runId;
   await db.exec('reset role');await db.query("update public.runs set expires_at=clock_timestamp()-interval '1 second' where id=$1",[rid]);await asUser();await db.query('select public.recover_researcher_execution($1)',[rid]);
   await asUser('','service_role');await assert.rejects(finish(rid),/expired execution lease/);await asUser();
   for(let i=0;i<2;i++){const r=await auth(m.task);await start(r.runId);await finish(r.runId,null,'provider_error',{...metadata,stage:'search',provider_requests:0,sources_discovered:0,http_status:503});await asUser();}
   await assert.rejects(auth(m.task),/Maximum 3/);
  });
  await t.test('Requirements Brief remains available for original and extension tasks with no web budget',async()=>{
   for(const ext of [false,true]){const m=await mission();const tid=ext?(await extension(m.mid))[0].id:m.task;const r=await scalar("select public.authorize_researcher_execution($1,$2,'fixture',$3,true)",[tid,hash,randomUUID()]);await start(r.runId);await db.query('select public.finish_researcher_execution($1,$2,$3::jsonb,null,null)',[r.runId,hash,JSON.stringify(document)]);await asUser();await db.query("select public.review_researcher_deliverable($1,'rejected',true,$2)",[r.runId,randomUUID()]);assert.equal(await scalar('select execution_status from public.tasks where id=$1',[tid]),'rejected');}
  });
 }finally{await db.close();}
});
