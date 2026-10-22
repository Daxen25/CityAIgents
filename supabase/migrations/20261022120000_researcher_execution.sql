-- M1.4 only. Preserve plan/task approval and every historical migration.
create table public.task_execution_authorizations (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
 mission_id uuid not null, task_id uuid not null, plan_review_id uuid not null, agent_id uuid not null,
 request_id uuid not null unique, authorized_by uuid not null references auth.users(id),
 authorized_at timestamptz not null default clock_timestamp(), unique(workspace_id,id),
 foreign key(workspace_id,mission_id) references public.missions(workspace_id,id),
 foreign key(workspace_id,task_id) references public.tasks(workspace_id,id),
 foreign key(workspace_id,plan_review_id) references public.task_plan_reviews(workspace_id,id),
 foreign key(workspace_id,agent_id) references public.agents(workspace_id,id)
);
alter table public.tasks add column execution_status text not null default 'not_authorized'
 check(execution_status in ('not_authorized','authorized','running','pending_review','accepted','rejected','failed'));
alter table public.runs add column resolved_model text check(resolved_model is null or (length(resolved_model) between 1 and 100 and resolved_model ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*$')),
 add column purpose text not null default 'mission' check(purpose in ('mission','researcher')),
 add column task_id uuid, add column execution_authorization_id uuid unique,
 add foreign key(workspace_id,task_id) references public.tasks(workspace_id,id),
 add foreign key(workspace_id,execution_authorization_id) references public.task_execution_authorizations(workspace_id,id),
 add constraint execution_run_context check(
  (purpose='mission' and task_id is null and execution_authorization_id is null) or
  (purpose='researcher' and task_id is not null and execution_authorization_id is not null and adapter='gemini'));
alter table public.tasks add column execution_run_id uuid,
 add foreign key(workspace_id,execution_run_id) references public.runs(workspace_id,id),
 add constraint approved_researcher_execution check(
  (execution_status='not_authorized' and execution_run_id is null) or
  (execution_status<>'not_authorized' and execution_run_id is not null and status='approved'
   and plan_run_id is not null and review_id is not null and agent_id is not null and suggested_agent_role='researcher'));
-- M1.3 plan status and its non-execution constraint remain untouched.
alter table public.artifacts add column task_id uuid,
 add foreign key(workspace_id,task_id) references public.tasks(workspace_id,id);
alter table public.artifacts drop constraint artifacts_kind_check;
alter table public.artifacts add constraint artifacts_kind_check check(kind in ('mock','chief_of_staff_plan','researcher_document')),
 add constraint researcher_artifact_context check((kind='researcher_document' and task_id is not null) or (kind<>'researcher_document' and task_id is null));
create unique index one_researcher_document_per_run on public.artifacts(run_id) where kind='researcher_document';
create unique index one_researcher_document_per_task on public.artifacts(task_id) where kind='researcher_document';
create table public.task_execution_reviews (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
 mission_id uuid not null, task_id uuid not null, run_id uuid not null unique,
 artifact_id uuid not null unique references public.artifacts(id), request_id uuid not null unique,
 decision text not null check(decision in ('accepted','rejected')),
 decided_by uuid not null references auth.users(id), decided_at timestamptz not null default clock_timestamp(),
 foreign key(workspace_id,mission_id) references public.missions(workspace_id,id),
 foreign key(workspace_id,task_id) references public.tasks(workspace_id,id),
 foreign key(workspace_id,run_id) references public.runs(workspace_id,id)
);
do $$ declare t text; begin
 foreach t in array array['task_execution_authorizations','task_execution_reviews'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy member_read on public.%I for select to authenticated using(private.workspace_role(workspace_id) is not null)',t);
  execute format('create index %I on public.%I(workspace_id)',t||'_workspace',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;

create function private.validate_research_document(doc jsonb) returns void
language plpgsql set search_path='' as $$
declare item jsonb; v jsonb; key text; begin
 if doc is null or jsonb_typeof(doc) is distinct from 'object' then raise exception 'Invalid research document'; end if;
 if (select count(*) from jsonb_object_keys(doc))<>7 or not(doc ?& array['summary','requirements','assumptions','open_questions','limitations','sources','verification'])
  or jsonb_typeof(doc->'summary') is distinct from 'string' or length(btrim(doc->>'summary')) not between 1 and 2000
  or doc->>'verification' is distinct from 'not_externally_verified' then raise exception 'Invalid research document'; end if;
 foreach key in array array['requirements','assumptions','open_questions','limitations','sources'] loop
  if jsonb_typeof(doc->key) is distinct from 'array' then raise exception 'Invalid research document'; end if;
 end loop;
 if jsonb_array_length(doc->'requirements') not between 1 and 8 or jsonb_array_length(doc->'sources')<>0
  or jsonb_array_length(doc->'assumptions')>10 or jsonb_array_length(doc->'open_questions')>10
  or jsonb_array_length(doc->'limitations') not between 1 and 10 then raise exception 'Invalid research document'; end if;
 for item in select value from jsonb_array_elements(doc->'requirements') loop
  if jsonb_typeof(item) is distinct from 'object' then raise exception 'Invalid requirement'; end if;
  if (select count(*) from jsonb_object_keys(item))<>3 or not(item ?& array['title','description','acceptance_criteria'])
   or jsonb_typeof(item->'title') is distinct from 'string' or length(btrim(item->>'title')) not between 1 and 200
   or jsonb_typeof(item->'description') is distinct from 'string' or length(btrim(item->>'description')) not between 1 and 2000
   or jsonb_typeof(item->'acceptance_criteria') is distinct from 'array' then raise exception 'Invalid requirement'; end if;
  if jsonb_array_length(item->'acceptance_criteria') not between 1 and 5 then raise exception 'Invalid requirement'; end if;
  for v in select value from jsonb_array_elements(item->'acceptance_criteria') loop
   if jsonb_typeof(v) is distinct from 'string' or length(btrim(v #>> '{}')) not between 1 and 500 then raise exception 'Invalid criterion'; end if;
  end loop;
 end loop;
 foreach key in array array['assumptions','open_questions','limitations'] loop
  for v in select value from jsonb_array_elements(doc->key) loop
   if jsonb_typeof(v) is distinct from 'string' or length(btrim(v #>> '{}')) not between 1 and 500 then raise exception 'Invalid research section'; end if;
  end loop;
 end loop;
end $$;

create function private.authorize_researcher_execution(tid uuid, token_hash text, selected_model text, request_id uuid, confirmed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.missions; t public.tasks; pr public.task_plan_reviews; aid uuid; rid uuid; parent_approval uuid; uid uuid:=auth.uid(); begin
 select m0.* into m from public.missions m0 join public.tasks t0 on t0.mission_id=m0.id where t0.id=tid for update of m0;
 if uid is null or private.workspace_role(m.workspace_id) is distinct from 'owner' then raise exception 'Workspace owner authorization required'; end if;
 select * into t from public.tasks where id=tid and workspace_id=m.workspace_id for update;
 if confirmed is distinct from true then raise exception 'Fresh explicit execution authorization required'; end if;
 if m.execution_mode<>'chief_of_staff' or m.status<>'approved' or t.status<>'approved'
  or t.execution_status not in ('not_authorized','failed') then raise exception 'Task not eligible for execution'; end if;
 if request_id is null or token_hash is null or token_hash !~ '^[a-f0-9]{64}$' or selected_model is null
  or length(selected_model) not between 1 and 100 or selected_model !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' then raise exception 'Invalid execution configuration'; end if;
 select * into pr from public.task_plan_reviews where id=t.review_id and mission_id=m.id and workspace_id=m.workspace_id
  and run_id=t.plan_run_id and decision='approved' and tid=any(accepted_task_ids);
 if not found or t.suggested_agent_role<>'researcher' or not exists(select 1 from public.agents a join public.agent_definitions d on d.key=a.definition_key
  where a.id=t.agent_id and a.workspace_id=m.workspace_id and a.definition_key='researcher')
  or not exists(select 1 from jsonb_array_elements(pr.decision_snapshot) x where x->>'taskId'=tid::text and x->>'decision'='approved'
    and x->>'agentId'=t.agent_id::text and x->>'definitionKey'='researcher') then raise exception 'Approved Researcher assignment required'; end if;
 if (select count(*) from public.runs where task_id=tid and purpose='researcher')>=3 then raise exception 'Maximum 3 execution attempts reached'; end if;
 if exists(select 1 from public.runs where mission_id=m.id and status='running') then raise exception 'Mission already has a running attempt'; end if;
 select approval_id into parent_approval from public.runs where id=t.plan_run_id and workspace_id=m.workspace_id and mission_id=m.id and status='completed' and purpose='mission';
 if not found then raise exception 'Planning provenance required'; end if;
 -- approval_id retains legacy planning provenance only; this new authorization is mandatory.
 insert into public.task_execution_authorizations(workspace_id,mission_id,task_id,plan_review_id,agent_id,request_id,authorized_by)
 values(m.workspace_id,m.id,tid,pr.id,t.agent_id,request_id,uid) returning id into aid;
 insert into public.runs(workspace_id,mission_id,approval_id,adapter,status,requested_by,lease_hash,expires_at,model,purpose,task_id,execution_authorization_id)
 values(m.workspace_id,m.id,parent_approval,'gemini','running',uid,token_hash,clock_timestamp()+interval '120 seconds',selected_model,'researcher',tid,aid) returning id into rid;
 update public.tasks set execution_status='authorized',execution_run_id=rid where id=tid;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event) values(m.workspace_id,m.id,uid,'researcher.authorized:'||rid::text);
 return jsonb_build_object('runId',rid,'objective',m.objective,'title',t.title,'expectedDeliverable',t.expected_deliverable);
end $$;

-- Only trusted finalizers may call this helper. Lock order matches authorization/review.
create function private.lock_researcher_run(rid uuid, token_hash text, expected_status text) returns public.runs
language plpgsql security definer set search_path='' as $$
declare r public.runs; t public.tasks; m public.missions; a public.task_execution_authorizations; begin
 select m0.* into m from public.missions m0 join public.runs r0 on r0.mission_id=m0.id where r0.id=rid for update of m0;
 select t0.* into t from public.tasks t0 join public.runs r0 on r0.task_id=t0.id where r0.id=rid for update of t0;
 select * into r from public.runs where id=rid for update;
 if r.id is null or r.purpose<>'researcher' or r.adapter<>'gemini' or r.status<>'running' or m.status<>'approved'
  or m.execution_mode<>'chief_of_staff' or t.id is null or t.workspace_id<>r.workspace_id or t.mission_id<>r.mission_id
  or t.status<>'approved' or t.execution_status<>expected_status or t.execution_run_id is distinct from rid
  or token_hash is null or r.lease_hash is distinct from token_hash or r.expires_at<=clock_timestamp() then raise exception 'Invalid or expired execution lease'; end if;
 select * into a from public.task_execution_authorizations where id=r.execution_authorization_id and workspace_id=r.workspace_id
  and mission_id=r.mission_id and task_id=t.id and authorized_by=r.requested_by and plan_review_id=t.review_id and agent_id=t.agent_id;
 if not found or not exists(select 1 from public.workspace_members where workspace_id=r.workspace_id and user_id=a.authorized_by and role='owner')
  or t.suggested_agent_role<>'researcher' or not exists(select 1 from public.agents where id=t.agent_id and workspace_id=r.workspace_id and definition_key='researcher')
  or not exists(select 1 from public.task_plan_reviews where id=t.review_id and mission_id=r.mission_id and run_id=t.plan_run_id
    and workspace_id=r.workspace_id and decision='approved' and t.id=any(accepted_task_ids)) then raise exception 'Execution authorization no longer valid'; end if;
 return r;
end $$;
create function private.start_researcher_execution(rid uuid, token_hash text) returns void
language plpgsql security definer set search_path='' as $$
declare r public.runs; begin
 r:=private.lock_researcher_run(rid,token_hash,'authorized');
 update public.tasks set execution_status='running' where id=r.task_id;
 update public.runs set started_at=clock_timestamp() where id=rid;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event) values(r.workspace_id,r.mission_id,r.requested_by,'researcher.started:'||rid::text);
end $$;
create function private.finish_researcher_execution(rid uuid, token_hash text, doc jsonb, error_code text, model_version text) returns void
language plpgsql security definer set search_path='' as $$
declare r public.runs; begin
 r:=private.lock_researcher_run(rid,token_hash,'running');
 if error_code is null then
  if model_version is not null and (length(model_version) not between 1 and 100 or model_version !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*$') then raise exception 'Invalid model provenance'; end if;
  perform private.validate_research_document(doc);
  insert into public.artifacts(workspace_id,mission_id,run_id,task_id,kind,content)
   values(r.workspace_id,r.mission_id,rid,r.task_id,'researcher_document',doc);
 else
  if doc is not null or model_version is not null or error_code not in ('timeout','provider_error','invalid_output') then raise exception 'Invalid execution failure'; end if;
 end if;
 update public.runs set status=case when error_code is null then 'completed' else 'failed' end,ended_at=clock_timestamp(),failure_code=error_code,resolved_model=model_version where id=rid;
 update public.tasks set execution_status=case when error_code is null then 'pending_review' else 'failed' end where id=r.task_id;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event)
  values(r.workspace_id,r.mission_id,r.requested_by,'researcher.'||coalesce(error_code,'result_pending_review')||':'||rid::text);
end $$;
create function private.recover_researcher_execution(rid uuid) returns void
language plpgsql security definer set search_path='' as $$
declare m public.missions; r public.runs; t public.tasks; begin
 select m0.* into m from public.missions m0 join public.runs r0 on r0.mission_id=m0.id where r0.id=rid for update of m0;
 if auth.uid() is null or private.workspace_role(m.workspace_id) is distinct from 'owner' then raise exception 'Workspace owner authorization required'; end if;
 select t0.* into t from public.tasks t0 join public.runs r0 on r0.task_id=t0.id where r0.id=rid for update of t0;
 select * into r from public.runs where id=rid for update;
 if r.purpose<>'researcher' or r.status<>'running' or r.expires_at>clock_timestamp() or t.execution_run_id is distinct from rid
  or t.execution_status not in ('authorized','running') then raise exception 'No expired execution to recover'; end if;
 update public.runs set status='failed',ended_at=clock_timestamp(),failure_code='interrupted' where id=rid;
 update public.tasks set execution_status='failed' where id=t.id;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event) values(r.workspace_id,r.mission_id,auth.uid(),'researcher.interrupted:'||rid::text);
end $$;
create function private.review_researcher_deliverable(rid uuid, decision text, confirmed boolean, request_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare m public.missions; r public.runs; t public.tasks; a public.artifacts; previous public.task_execution_reviews; review_uuid uuid; begin
 select m0.* into m from public.missions m0 join public.runs r0 on r0.mission_id=m0.id where r0.id=rid for update of m0;
 if auth.uid() is null or private.workspace_role(m.workspace_id) is distinct from 'owner' then raise exception 'Workspace owner authorization required'; end if;
 if confirmed is distinct from true or request_id is null or decision is null or decision not in ('accepted','rejected') then raise exception 'Explicit deliverable decision required'; end if;
 select * into previous from public.task_execution_reviews v where v.run_id=rid;
 if found then
  if previous.request_id=request_id and previous.decision=decision and previous.decided_by=auth.uid() then return previous.id; end if;
  raise exception 'Deliverable already reviewed';
 end if;
 select t0.* into t from public.tasks t0 join public.runs r0 on r0.task_id=t0.id where r0.id=rid for update of t0;
 select * into r from public.runs where id=rid for update;
 if r.purpose<>'researcher' or r.status<>'completed' or t.execution_status<>'pending_review' or t.execution_run_id is distinct from rid
  or t.status<>'approved' or t.workspace_id<>r.workspace_id or t.mission_id<>r.mission_id then raise exception 'Generated deliverable awaiting review required'; end if;
 select * into a from public.artifacts where run_id=rid and task_id=t.id and workspace_id=r.workspace_id and mission_id=r.mission_id and kind='researcher_document';
 if not found then raise exception 'Researcher artifact required'; end if;
 insert into public.task_execution_reviews(workspace_id,mission_id,task_id,run_id,artifact_id,request_id,decision,decided_by)
 values(r.workspace_id,r.mission_id,t.id,rid,a.id,request_id,decision,auth.uid()) returning id into review_uuid;
 update public.tasks set execution_status=decision where id=t.id;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event) values(r.workspace_id,r.mission_id,auth.uid(),'researcher.deliverable_'||decision||':'||rid::text);
 return review_uuid;
end $$;

create function public.authorize_researcher_execution(tid uuid, token_hash text, selected_model text, request_id uuid, confirmed boolean) returns jsonb
language sql security invoker set search_path='' as $$ select private.authorize_researcher_execution(tid,token_hash,selected_model,request_id,confirmed) $$;
create function public.start_researcher_execution(rid uuid, token_hash text) returns void
language sql security invoker set search_path='' as $$ select private.start_researcher_execution(rid,token_hash) $$;
create function public.finish_researcher_execution(rid uuid, token_hash text, doc jsonb, error_code text, model_version text) returns void
language sql security invoker set search_path='' as $$ select private.finish_researcher_execution(rid,token_hash,doc,error_code,model_version) $$;
create function public.recover_researcher_execution(rid uuid) returns void
language sql security invoker set search_path='' as $$ select private.recover_researcher_execution(rid) $$;
create function public.review_researcher_deliverable(rid uuid, decision text, confirmed boolean, request_id uuid) returns uuid
language sql security invoker set search_path='' as $$ select private.review_researcher_deliverable(rid,decision,confirmed,request_id) $$;
revoke all on function private.validate_research_document(jsonb), private.lock_researcher_run(uuid,text,text) from public,anon,authenticated,service_role;
revoke all on function private.authorize_researcher_execution(uuid,text,text,uuid,boolean), public.authorize_researcher_execution(uuid,text,text,uuid,boolean),
 private.recover_researcher_execution(uuid), public.recover_researcher_execution(uuid),
 private.review_researcher_deliverable(uuid,text,boolean,uuid), public.review_researcher_deliverable(uuid,text,boolean,uuid),
 private.start_researcher_execution(uuid,text), public.start_researcher_execution(uuid,text),
 private.finish_researcher_execution(uuid,text,jsonb,text,text), public.finish_researcher_execution(uuid,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function private.authorize_researcher_execution(uuid,text,text,uuid,boolean), public.authorize_researcher_execution(uuid,text,text,uuid,boolean),
 private.recover_researcher_execution(uuid), public.recover_researcher_execution(uuid),
 private.review_researcher_deliverable(uuid,text,boolean,uuid), public.review_researcher_deliverable(uuid,text,boolean,uuid) to authenticated;
grant execute on function private.start_researcher_execution(uuid,text), public.start_researcher_execution(uuid,text),
 private.finish_researcher_execution(uuid,text,jsonb,text,text), public.finish_researcher_execution(uuid,text,jsonb,text,text) to service_role;
