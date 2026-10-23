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
test('M1.5A PostgreSQL immutable additive planning and authorization',async(t)=>{
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
  const migration='20261023120000_dynamic_mission_planning.sql';
  for(const name of readdirSync('supabase/migrations').sort().filter(n=>n<migration))await db.exec(readFileSync(`supabase/migrations/${name}`,'utf8'));
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
  const existing=await mission();
  const execution=await scalar("select public.authorize_researcher_execution($1,$2,'fixture',$3,true)",[existing.task,hash,randomUUID()]);
  await asUser('','service_role');await db.query('select public.start_researcher_execution($1,$2)',[execution.runId,hash]);
  await db.query('select public.finish_researcher_execution($1,$2,$3::jsonb,null,null)',[execution.runId,hash,JSON.stringify(document)]);await asUser();
  await db.query("select public.review_researcher_deliverable($1,'accepted',true,$2)",[execution.runId,randomUUID()]);
  const oldTask=await scalar('select to_jsonb(t) from public.tasks t where id=$1',[existing.task]);
  const original=await scalar("select jsonb_build_object('runs',(select jsonb_agg(to_jsonb(r) order by id) from public.runs r where mission_id=$1),'artifacts',(select jsonb_agg(to_jsonb(a) order by id) from public.artifacts a where mission_id=$1),'reviews',(select jsonb_agg(to_jsonb(v) order by id) from public.task_execution_reviews v where mission_id=$1),'mission',(select to_jsonb(m) from public.missions m where id=$1))",[existing.mid]);
  await db.exec('reset role; begin');await db.exec(readFileSync(`supabase/migrations/${migration}`,'utf8'));await db.exec('commit');await asUser();
  const begin=(mid=existing.mid,request=randomUUID(),confirmed=true)=>scalar("select public.begin_mission_extension($1,'Add follow-up work',$2,$3,'fixture',$4)",[mid,request,hash,confirmed]);
  async function finish(pid:string,doc:unknown=addition,error:string|null=null){await asUser('','service_role');await db.query('select public.finish_mission_extension($1,$2,$3::jsonb,$4,$5)',[pid,hash,doc===null?null:JSON.stringify(doc),error,error?null:'gemini-fixture']);await asUser();}
  const review=(pid:string,positions:number[]=[1],request=randomUUID(),confirmed=true)=>scalar('select public.review_mission_extension($1,$2::int[],$3,$4)',[pid,positions,request,confirmed]);
  async function expire(pid:string){await db.exec('reset role; alter table public.mission_extensions disable trigger extension_history');await db.query("update public.mission_extensions set expires_at=clock_timestamp()-interval '1 second' where id=$1",[pid]);await db.exec('alter table public.mission_extensions enable trigger extension_history');await asUser();}
  await t.test('owner consent only, members/anonymous/cross-workspace blocked and finalizer service-only',async()=>{
   await assert.rejects(begin(existing.mid,randomUUID(),false),/explicit authorization/);
   for(const id of [member,outsider,'']){await asUser(id);await assert.rejects(begin(),/owner authorization/);}await asUser('','anon');await assert.rejects(begin(),/permission denied/);await asUser();
   const p=await begin();
   await asUser(member);await assert.rejects(review(p.proposalId,[]),/owner authorization/);await asUser('','anon');await assert.rejects(review(p.proposalId,[]),/permission denied/);await asUser();
   await assert.rejects(db.query('select public.finish_mission_extension($1,$2,$3::jsonb,null,null)',[p.proposalId,hash,JSON.stringify(addition)]),/permission denied/);
   await assert.rejects(db.query('select lease_hash from public.mission_extensions'),/permission denied/);
   await finish(p.proposalId,null,'provider_error');
  });
  let approvedId:string;
  await t.test('accepted output informs bounded snapshot; generation never applies tasks and approval is partial/idempotent',async()=>{
   const p=await begin();approvedId=p.proposalId;
   assert.equal(p.context.accepted_deliverables[0].summary,document.summary);assert.equal(p.context.tasks[0].execution,'accepted');
   assert.ok(Buffer.byteLength(JSON.stringify(p.context))<=12000);
   await assert.rejects(begin(),/active work/);await finish(p.proposalId);
   assert.equal(await scalar('select count(*)::int from public.tasks where extension_id=$1',[p.proposalId]),0);
   const request=randomUUID();await assert.rejects(review(p.proposalId,[1],request,false),/Explicit review/);
   const rid=await review(p.proposalId,[1],request);assert.equal(await review(p.proposalId,[1],request),rid);
   await assert.rejects(review(p.proposalId,[2]),/already reviewed/);
   const task=await scalar('select to_jsonb(t) from public.tasks t where extension_id=$1',[p.proposalId]);
   await db.exec('reset role');await assert.rejects(db.query("update public.tasks set title='Forged' where id=$1",[task.id]),/immutable/);await asUser();
   assert.equal(task.status,'approved');assert.equal(task.execution_status,'not_authorized');assert.equal(task.plan_run_id,null);assert.ok(task.agent_id);
   await assert.rejects(db.query("select public.authorize_researcher_execution($1,$2,'fixture',$3,true)",[task.id,hash,randomUUID()]),/Researcher assignment/);
   assert.deepEqual(await scalar('select to_jsonb(t) from public.tasks t where id=$1',[existing.task]),{...oldTask,extension_id:null});
  });
  await t.test('successive extensions preserve original planning attempts, accepted artifacts and review history',async()=>{
   const p=await begin();assert.equal(p.context.tasks.length,2);await finish(p.proposalId);await review(p.proposalId,[1,2]);
   const fresh=await begin();await finish(fresh.proposalId);await review(fresh.proposalId,[]);
   assert.equal(await scalar('select status from public.mission_extensions where id=$1',[fresh.proposalId]),'rejected');
   assert.equal(await scalar('select count(*)::int from public.tasks where extension_id=$1',[fresh.proposalId]),0);
   const current=await scalar("select jsonb_build_object('runs',(select jsonb_agg(to_jsonb(r) order by id) from public.runs r where mission_id=$1),'artifacts',(select jsonb_agg(to_jsonb(a) order by id) from public.artifacts a where mission_id=$1),'reviews',(select jsonb_agg(to_jsonb(v) order by id) from public.task_execution_reviews v where mission_id=$1),'mission',(select to_jsonb(m) from public.missions m where id=$1))",[existing.mid]);
   assert.deepEqual(current,original);assert.equal(await scalar("select count(*)::int from public.runs where mission_id=$1 and purpose='mission'",[existing.mid]),1);
   await db.exec('reset role');await assert.rejects(db.query("update public.mission_extensions set instruction='Overwrite' where id=$1",[approvedId]),/immutable/);await assert.rejects(db.query('delete from public.mission_extension_reviews where proposal_id=$1',[approvedId]),/immutable/);await asUser();
  });
  await t.test('concurrent proposals and reviews serialize; request IDs cannot be reused',async()=>{
   const m=await mission();const results=await Promise.allSettled([begin(m.mid),begin(m.mid)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
   const p=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value;await finish(p.proposalId);
   const request=randomUUID();const decisions=await Promise.allSettled([review(p.proposalId,[1],request),review(p.proposalId,[2],request)]);assert.equal(decisions.filter(r=>r.status==='fulfilled').length,1);
   assert.equal(await scalar('select count(*)::int from public.tasks where extension_id=$1',[p.proposalId]),1);
   const req=randomUUID();const next=await begin(m.mid,req);await finish(next.proposalId,null,'timeout');await assert.rejects(begin(m.mid,req),/unique/);
  });
  await t.test('stale context and active Researcher runs cannot apply additions; stale decision persists',async()=>{
   const m=await mission();const p=await begin(m.mid);await finish(p.proposalId);
   await db.exec('reset role');await db.query("update public.tasks set title='Changed scope' where id=$1",[m.task]);await asUser();
   assert.equal(await review(p.proposalId,[1]),null);assert.equal(await scalar('select status from public.mission_extensions where id=$1',[p.proposalId]),'stale');await review(p.proposalId,[]);
   const execution=await scalar("select public.authorize_researcher_execution($1,$2,'fixture',$3,true)",[m.task,hash,randomUUID()]);
   await assert.rejects(begin(m.mid),/active work/);
   await asUser('','service_role');await db.query('select public.start_researcher_execution($1,$2)',[execution.runId,hash]);await db.query("select public.finish_researcher_execution($1,$2,null,'timeout',null)",[execution.runId,hash]);await asUser();
   const next=await begin(m.mid);await db.exec('reset role');await db.query("update public.missions set status='cancelled' where id=$1",[m.mid]);await asUser();await finish(next.proposalId);
   assert.equal(await scalar('select status from public.mission_extensions where id=$1',[next.proposalId]),'stale');
  });
  await t.test('generation keeps stale output auditable when an originally eligible dependency changes',async()=>{
   const m=await mission();const p=await begin(m.mid);
   await db.exec('reset role');await db.query("update public.tasks set status='rejected',agent_id=null where id=$1",[m.task]);await asUser();
   const doc={...addition,tasks:[{...addition.tasks[0],dependencies:[{existing_task_id:m.task,proposal_position:null}]}]};
   await finish(p.proposalId,doc);assert.equal(await scalar('select status from public.mission_extensions where id=$1',[p.proposalId]),'stale');
   assert.equal(await scalar('select count(*)::int from public.tasks where extension_id=$1',[p.proposalId]),0);await review(p.proposalId,[]);
  });
  await t.test('invalid schema/dependencies and missing assignment roll back atomically',async()=>{
   const isolated=await scalar("select public.create_workspace('Assignment isolation')");const m=await mission(isolated);const p=await begin(m.mid);
   for(const bad of [{...addition,tasks:[]},{...addition,tasks:Array(9).fill(addition.tasks[0])},{...addition,summary:null},{...addition,tasks:[{...addition.tasks[0],priority:'urgent'}]},{...addition,tasks:[{...addition.tasks[0],dependencies:[{existing_task_id:null,proposal_position:1}]}]}])await assert.rejects(finish(p.proposalId,bad));
   const dependent={...addition,tasks:[addition.tasks[0],{...addition.tasks[1],dependencies:[{existing_task_id:null,proposal_position:1}]}]};await finish(p.proposalId,dependent);await assert.rejects(review(p.proposalId,[2]),/required dependencies/);
   await assert.rejects(review(p.proposalId,[1,1]),/Invalid selection/);await assert.rejects(review(p.proposalId,[8]),/outside proposal/);
   await db.exec('reset role');await db.query("delete from public.agents where workspace_id=$1 and definition_key='developer'",[isolated]);await asUser();
   await assert.rejects(review(p.proposalId,[1,2]),/assignment/);assert.equal(await scalar('select count(*)::int from public.tasks where extension_id=$1',[p.proposalId]),0);await review(p.proposalId,[]);
  });
  await t.test('expired lease recovery is owner-only, never reuses a generation and fences late finalizers',async()=>{
   const m=await mission();const p=await begin(m.mid);await assert.rejects(db.query('select public.recover_mission_extension($1)',[p.proposalId]),/No expired/);await expire(p.proposalId);
   await asUser(member);await assert.rejects(db.query('select public.recover_mission_extension($1)',[p.proposalId]),/owner authorization/);await asUser();
   await db.query('select public.recover_mission_extension($1)',[p.proposalId]);await assert.rejects(finish(p.proposalId),/expired/);await asUser();
   assert.equal(await scalar('select failure_code from public.mission_extensions where id=$1',[p.proposalId]),'interrupted');
  });
  await t.test('RLS, cross-workspace dependencies and invalid finalizer capabilities are rejected',async()=>{
   const m=await mission();const p=await begin(m.mid);
   await asUser(outsider);assert.equal(await scalar('select count(*)::int from public.mission_extension_reviews where proposal_id=$1',[approvedId]),0);assert.equal(await scalar('select count(*)::int from public.mission_extensions where id=$1',[p.proposalId]),0);await assert.rejects(review(p.proposalId,[]),/owner authorization/);
   await asUser('','service_role');await assert.rejects(db.query('select public.finish_mission_extension($1,$2,$3::jsonb,null,null)',[p.proposalId,'b'.repeat(64),JSON.stringify(addition)]),/authorization/);await asUser();
   await asUser(outsider);const other=await scalar("select public.create_workspace('Other workspace')");
   const foreign=await scalar("select public.create_mission($1,'Other mission','Other objective for context','business')",[other]);
   await db.exec('reset role');const foreignTask=await scalar("insert into public.tasks(workspace_id,mission_id,title) values($1,$2,'Other task') returning id",[other,foreign]);await asUser();
   await assert.rejects(finish(p.proposalId,{...addition,tasks:[{...addition.tasks[0],dependencies:[{existing_task_id:foreignTask,proposal_position:null}]}]}),/outside eligible/);await asUser();await finish(p.proposalId,null,'invalid_output');
  });
  await t.test('revoked owners cannot finalize an extension or approve it',async()=>{
   const m=await mission();const p=await begin(m.mid);
   await db.exec('reset role');await db.query("update public.workspace_members set role='member' where workspace_id=$1 and user_id=$2",[wid,owner]);
   try{await assert.rejects(finish(p.proposalId),/authorization/);await asUser();await assert.rejects(review(p.proposalId,[]),/owner authorization/);}
   finally{await db.exec('reset role');await db.query("update public.workspace_members set role='owner' where workspace_id=$1 and user_id=$2",[wid,owner]);await asUser();}
   await finish(p.proposalId,null,'provider_error');
  });
  await t.test('bounded context refuses excess tasks/bytes before creating generation runs',async()=>{
   const m=await mission();await db.exec('reset role');
   for(let i=0;i<30;i++)await db.query("insert into public.tasks(workspace_id,mission_id,title) values($1,$2,$3)",[wid,m.mid,`Existing task ${i}`]);
   await asUser();await assert.rejects(begin(m.mid),/exceeds 30 tasks/);
   assert.equal(await scalar('select count(*)::int from public.mission_extensions where mission_id=$1',[m.mid]),0);
   const other=await mission();await db.exec('reset role');await db.query('update public.missions set objective=$1 where id=$2',['😀'.repeat(2000),other.mid]);await asUser();
   await assert.rejects(db.query("select public.begin_mission_extension($1,$2,$3,$4,'fixture',true)",[other.mid,'😀'.repeat(1000),randomUUID(),hash]),/exceeds 12000 bytes/);
   assert.equal(await scalar('select count(*)::int from public.mission_extensions where mission_id=$1',[other.mid]),0);
  });
  await t.test('reviewing prior stale history invalidates a simultaneously pending context',async()=>{
   const m=await mission();const old=await begin(m.mid);await finish(old.proposalId);
   await db.exec('reset role');await db.query("update public.tasks set title='Scope changed' where id=$1",[m.task]);await asUser();
   assert.equal(await review(old.proposalId,[1]),null);
   const current=await begin(m.mid);await finish(current.proposalId);await review(old.proposalId,[]);
   assert.equal(await review(current.proposalId,[1]),null);
   assert.equal(await scalar('select count(*)::int from public.tasks where extension_id=$1',[current.proposalId]),0);
  });
  await t.test('late audit failure rolls back tasks, review and proposal status',async()=>{
   const m=await mission();const p=await begin(m.mid);await finish(p.proposalId);
   await db.exec("reset role; alter table public.activity_events add constraint offline_extension_failure check(event not like 'extension.reviewed:%') not valid");await asUser();
   try{await assert.rejects(review(p.proposalId,[1]),/offline_extension_failure/);assert.equal(await scalar('select count(*)::int from public.tasks where extension_id=$1',[p.proposalId]),0);assert.equal(await scalar('select status from public.mission_extensions where id=$1',[p.proposalId]),'proposed');}
   finally{await db.exec('reset role; alter table public.activity_events drop constraint offline_extension_failure');await asUser();}
  });
 }finally{await db.close();}
});
