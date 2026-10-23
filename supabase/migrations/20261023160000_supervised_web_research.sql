-- M1.5B only. Apply once after M1.5A; never replay historical migrations.
alter table public.mission_extension_reviews add unique(workspace_id,id);
alter table public.task_execution_authorizations alter column plan_review_id drop not null;
alter table public.task_execution_authorizations add column extension_review_id uuid,
 add column research_mode text not null default 'brief' check(research_mode in ('brief','web')),
 add column search_budget integer not null default 0,
 add column synthesis_budget integer not null default 2,
 add foreign key(workspace_id,extension_review_id) references public.mission_extension_reviews(workspace_id,id),
 add constraint execution_review_origin check((plan_review_id is not null)<>(extension_review_id is not null)),
 add constraint execution_budgets check((research_mode='brief' and search_budget=0 and synthesis_budget=2) or (research_mode='web' and search_budget=1 and synthesis_budget=1));
alter table public.runs add column research_mode text not null default 'brief' check(research_mode in ('brief','web')),
 add column web_metadata jsonb,
 add constraint web_run_context check(research_mode='brief' or (purpose='researcher' and adapter='gemini'));
alter table public.tasks drop constraint proposal_is_non_executable;
alter table public.tasks add constraint proposal_is_non_executable check (
 (extension_id is null and (
  (plan_run_id is null and review_id is null and status not in ('approved','rejected')) or
  (plan_run_id is not null and proposal_position between 1 and 12 and proposal_position is not null
   and suggested_agent_role is not null and suggested_agent_role in ('chief-of-staff','researcher','developer')
   and expected_deliverable is not null and length(btrim(expected_deliverable)) between 1 and 2000
   and ((status='proposed' and agent_id is null and review_id is null)
    or(status='approved' and agent_id is not null and review_id is not null)
    or(status='rejected' and agent_id is null and review_id is not null))))) or
 (extension_id is not null and plan_run_id is null and review_id is null and status='approved' and agent_id is not null
  and proposal_position is not null and proposal_position between 1 and 8
  and suggested_agent_role is not null and suggested_agent_role in ('chief-of-staff','researcher','developer')
  and expected_deliverable is not null and length(btrim(expected_deliverable)) between 1 and 2000)
);
alter table public.tasks drop constraint approved_researcher_execution;
alter table public.tasks add constraint approved_researcher_execution check(
 (execution_status='not_authorized' and execution_run_id is null) or
 (execution_status<>'not_authorized' and execution_run_id is not null and status='approved' and agent_id is not null and suggested_agent_role='researcher'
  and ((extension_id is null and plan_run_id is not null and review_id is not null) or (extension_id is not null and plan_run_id is null and review_id is null))));
create or replace function private.guard_extension_task() returns trigger language plpgsql set search_path='' as $$ begin
 if old.extension_id is not null then
  if TG_OP='DELETE' then raise exception 'Approved extension task history is immutable';end if;
  if (to_jsonb(new)-array['execution_status','execution_run_id']) is distinct from (to_jsonb(old)-array['execution_status','execution_run_id']) then raise exception 'Approved extension task history is immutable';end if;
 elsif TG_OP='UPDATE' and new.extension_id is not null then raise exception 'Cannot replace task provenance';end if;
 if TG_OP='DELETE' then return old;end if;return new;
end $$;
-- Revalidated on authorization AND trusted start/finalization. No caller actor IDs.
create function private.researcher_provenance(t public.tasks, owner_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$ declare review_uuid uuid; begin
 if t.suggested_agent_role is distinct from 'researcher' or not exists(select 1 from public.agents where id=t.agent_id and workspace_id=t.workspace_id and definition_key='researcher') then raise exception 'Approved Researcher assignment required';end if;
 if t.extension_id is null then
  select p.id into review_uuid from public.task_plan_reviews p where p.id=t.review_id and p.workspace_id=t.workspace_id and p.mission_id=t.mission_id and p.run_id=t.plan_run_id and p.decision='approved' and t.id=any(p.accepted_task_ids)
   and exists(select 1 from jsonb_array_elements(p.decision_snapshot) x where x->>'taskId'=t.id::text and x->>'decision'='approved' and x->>'agentId'=t.agent_id::text and x->>'definitionKey'='researcher');
 else
  select v.id into review_uuid from public.mission_extension_reviews v join public.mission_extensions p on p.id=v.proposal_id and p.workspace_id=v.workspace_id and p.mission_id=v.mission_id
   where p.id=t.extension_id and p.workspace_id=t.workspace_id and p.mission_id=t.mission_id and p.status='approved'
    and v.decided_by=owner_id and t.proposal_position=any(v.accepted_positions)
    and p.proposal->'tasks'->(t.proposal_position-1)->>'title'=t.title
    and p.proposal->'tasks'->(t.proposal_position-1)->>'expected_deliverable'=t.expected_deliverable
    and p.proposal->'tasks'->(t.proposal_position-1)->>'suggested_agent_role'='researcher';
 end if;
 if review_uuid is null then raise exception 'Approved Researcher assignment provenance required';end if;return review_uuid;
end $$;
create function private.authorize_researcher_execution_v2(tid uuid, token_hash text, selected_model text, request_id uuid, confirmed boolean, research_mode text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.missions; t public.tasks; pr public.task_plan_reviews; aid uuid; rid uuid; parent_approval uuid; provenance uuid; uid uuid:=auth.uid(); begin
 select m0.* into m from public.missions m0 join public.tasks t0 on t0.mission_id=m0.id where t0.id=tid for update of m0;
 if uid is null or private.workspace_role(m.workspace_id) is distinct from 'owner' then raise exception 'Workspace owner authorization required'; end if;
 select * into t from public.tasks where id=tid and workspace_id=m.workspace_id for update;
 if confirmed is distinct from true then raise exception 'Fresh explicit execution authorization required'; end if;
 if m.execution_mode<>'chief_of_staff' or m.status<>'approved' or t.status<>'approved'
  or t.execution_status not in ('not_authorized','failed') then raise exception 'Task not eligible for execution'; end if;
 if request_id is null or token_hash is null or token_hash !~ '^[a-f0-9]{64}$' or selected_model is null
  or length(selected_model) not between 1 and 100 or selected_model !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' then raise exception 'Invalid execution configuration'; end if;
 if research_mode is null or research_mode not in ('brief','web') then raise exception 'Invalid research mode';end if;
 provenance:=private.researcher_provenance(t,uid);
 if (select count(*) from public.runs where task_id=tid and purpose='researcher')>=3 then raise exception 'Maximum 3 execution attempts reached'; end if;
 if exists(select 1 from public.runs where mission_id=m.id and status='running') then raise exception 'Mission already has a running attempt'; end if;
 select approval_id into parent_approval from public.runs where (id=t.plan_run_id or (t.extension_id is not null and mission_id=t.mission_id)) and workspace_id=m.workspace_id and mission_id=m.id and status='completed' and purpose='mission' order by started_at limit 1;
 if not found then raise exception 'Planning provenance required'; end if;
 -- approval_id retains legacy planning provenance only; this new authorization is mandatory.
 insert into public.task_execution_authorizations(workspace_id,mission_id,task_id,plan_review_id,extension_review_id,agent_id,request_id,authorized_by,research_mode,search_budget,synthesis_budget)
 values(m.workspace_id,m.id,tid,case when t.extension_id is null then provenance end,case when t.extension_id is not null then provenance end,t.agent_id,request_id,uid,research_mode,case when research_mode='web' then 1 else 0 end,case when research_mode='web' then 1 else 2 end) returning id into aid;
 insert into public.runs(workspace_id,mission_id,approval_id,adapter,status,requested_by,lease_hash,expires_at,model,purpose,task_id,execution_authorization_id,research_mode)
 values(m.workspace_id,m.id,parent_approval,'gemini','running',uid,token_hash,clock_timestamp()+interval '120 seconds',selected_model,'researcher',tid,aid,research_mode) returning id into rid;
 update public.tasks set execution_status='authorized',execution_run_id=rid where id=tid;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event) values(m.workspace_id,m.id,uid,'researcher.authorized:'||rid::text);
 return jsonb_build_object('runId',rid,'objective',m.objective,'title',t.title,'expectedDeliverable',t.expected_deliverable);
end $$;

create function public.authorize_researcher_execution_v2(tid uuid,token_hash text,selected_model text,request_id uuid,confirmed boolean,research_mode text) returns jsonb language sql security invoker set search_path='' as $$ select private.authorize_researcher_execution_v2(tid,token_hash,selected_model,request_id,confirmed,research_mode) $$;
-- Old RPC retains Requirements Brief semantics; mode cannot be silently changed.
create or replace function private.authorize_researcher_execution(tid uuid,token_hash text,selected_model text,request_id uuid,confirmed boolean) returns jsonb language sql security definer set search_path='' as $$ select private.authorize_researcher_execution_v2(tid,token_hash,selected_model,request_id,confirmed,'brief') $$;
create or replace function private.lock_researcher_run(rid uuid, token_hash text, expected_status text) returns public.runs
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
  and mission_id=r.mission_id and task_id=t.id and authorized_by=r.requested_by and plan_review_id is not distinct from t.review_id and agent_id=t.agent_id and research_mode=r.research_mode;
 if not found or not exists(select 1 from public.workspace_members where workspace_id=r.workspace_id and user_id=a.authorized_by and role='owner')
  or t.suggested_agent_role<>'researcher' or not exists(select 1 from public.agents where id=t.agent_id and workspace_id=r.workspace_id and definition_key='researcher')
 then raise exception 'Execution authorization no longer valid'; end if;
 if private.researcher_provenance(t,a.authorized_by) is distinct from coalesce(a.plan_review_id,a.extension_review_id) then raise exception 'Execution provenance no longer valid';end if;
 return r;
end $$;
create or replace function private.finish_researcher_execution(rid uuid, token_hash text, doc jsonb, error_code text, model_version text) returns void
language plpgsql security definer set search_path='' as $$
declare r public.runs; begin
 r:=private.lock_researcher_run(rid,token_hash,'running');
 if r.research_mode<>'brief' then raise exception 'Wrong execution mode';end if;
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
-- Strict SQL shape, size, public HTTPS URL and evidence-reference validation.
create function private.validate_web_research(doc jsonb) returns void language plpgsql set search_path='' as $$
declare s jsonb; f jsonb; v jsonb; k text; ids text[]:=array[]::text[]; urls text[]:=array[]::text[]; host text; begin
 if doc is null or jsonb_typeof(doc)<>'object' or octet_length(doc::text)>48000 then raise exception 'Invalid web report';end if;
 if (select count(*) from jsonb_object_keys(doc))<>10 or not(doc ?& array['objective','summary','findings','unverified_assertions','conflicting_or_incomplete_information','open_questions','recommendations','limitations','sources','verification']) or doc->>'verification' is distinct from 'provider_excerpts_not_independently_verified' then raise exception 'Invalid web report';end if;
 foreach k in array array['objective','summary'] loop
  if jsonb_typeof(doc->k) is distinct from 'string' or length(btrim(doc->>k)) not between 1 and 2000 then raise exception 'Invalid report text';end if;
 end loop;
 foreach k in array array['findings','sources','unverified_assertions','conflicting_or_incomplete_information','open_questions','recommendations','limitations'] loop
  if jsonb_typeof(doc->k) is distinct from 'array' then raise exception 'Invalid report array';end if;
 end loop;
 if jsonb_array_length(doc->'sources') not between 1 and 5 or jsonb_array_length(doc->'findings') not between 1 and 8 then raise exception 'Invalid evidence count';end if;
 for s in select value from jsonb_array_elements(doc->'sources') loop
  if jsonb_typeof(s)<>'object' then raise exception 'Invalid source';end if;
  if (select count(*) from jsonb_object_keys(s))<>6 or not(s ?& array['id','title','url','excerpt','retrieved_at','provider']) or s->>'provider' is distinct from 'tavily' or (s->>'id') !~ '^S[1-5]$' or s->>'id'=any(ids) or s->>'url'=any(urls) then raise exception 'Invalid source';end if;
  foreach k in array array['id','title','url','excerpt','retrieved_at','provider'] loop
   if jsonb_typeof(s->k) is distinct from 'string' or length(btrim(s->>k))<1 then raise exception 'Invalid source text';end if;
  end loop;
  host:=substring(s->>'url' from '^https://([a-z0-9.-]+)(?:/|$)');
  if length(s->>'title')>300 or length(s->>'excerpt')>2000 or length(s->>'url')>2000 or host is null or position('.' in host)=0 or host ~ '^[0-9.]+$' or host ~ '(^|\.)(localhost|local|internal|test|invalid|example|onion|arpa)$' or host like 'metadata.%' or s->>'url' ~ '[[:space:]\\]' or s->>'retrieved_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then raise exception 'Unsafe source metadata';end if;
  ids:=array_append(ids,s->>'id');urls:=array_append(urls,s->>'url');
 end loop;
 for f in select value from jsonb_array_elements(doc->'findings') loop
  if jsonb_typeof(f)<>'object' then raise exception 'Invalid finding';end if;
  if (select count(*) from jsonb_object_keys(f))<>3 or not(f ?& array['claim','basis','source_ids']) or jsonb_typeof(f->'claim') is distinct from 'string' or length(btrim(f->>'claim')) not between 1 and 1000 or f->>'basis' is null or f->>'basis' not in ('source_excerpt','model_inference') or jsonb_typeof(f->'source_ids') is distinct from 'array' then raise exception 'Invalid finding';end if;
  if jsonb_array_length(f->'source_ids')>5 or ((f->>'basis'='source_excerpt')<>(jsonb_array_length(f->'source_ids')>0)) or (select count(distinct value)<>count(*) from jsonb_array_elements(f->'source_ids')) then raise exception 'Invalid citation';end if;
  for v in select value from jsonb_array_elements(f->'source_ids') loop if jsonb_typeof(v)<>'string' or not((v #>> '{}')=any(ids)) then raise exception 'Unknown citation';end if;end loop;
 end loop;
 foreach k in array array['unverified_assertions','conflicting_or_incomplete_information','open_questions','recommendations','limitations'] loop
  if jsonb_array_length(doc->k)>8 or (k='limitations' and jsonb_array_length(doc->k)=0) then raise exception 'Invalid report section';end if;
  for v in select value from jsonb_array_elements(doc->k) loop if jsonb_typeof(v)<>'string' or length(btrim(v #>> '{}')) not between 1 and 500 then raise exception 'Invalid section text';end if;end loop;
 end loop;
end $$;
create function private.validate_web_metadata(m jsonb) returns boolean language sql immutable set search_path='' as $$ select coalesce(jsonb_typeof(m)='object' and (select count(*)=5 from jsonb_object_keys(m)) and m ?& array['search_requests','provider_requests','sources_discovered','stage','http_status'] and jsonb_typeof(m->'search_requests')='number' and jsonb_typeof(m->'provider_requests')='number' and jsonb_typeof(m->'sources_discovered')='number' and jsonb_typeof(m->'stage')='string' and m->>'search_requests' in ('0','1') and m->>'provider_requests' in ('0','1') and m->>'sources_discovered' in ('0','1','2','3','4','5') and m->>'stage' in ('search','synthesis','complete') and (m->'http_status'='null'::jsonb or (jsonb_typeof(m->'http_status')='number' and m->>'http_status' ~ '^[1-5][0-9]{2}$')),false) $$;
alter table public.runs add constraint web_metadata_context check(web_metadata is null or (research_mode='web' and private.validate_web_metadata(web_metadata)));
create function private.finish_web_research(rid uuid, token_hash text, doc jsonb, error_code text, model_version text,web_metadata jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare r public.runs; begin
 r:=private.lock_researcher_run(rid,token_hash,'running');
 if r.research_mode<>'web' then raise exception 'Wrong execution mode';end if;
 if web_metadata is null or not private.validate_web_metadata(web_metadata) then raise exception 'Invalid web diagnostics';end if;
 if error_code is null then
  if model_version is not null and (length(model_version) not between 1 and 100 or model_version !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*$') then raise exception 'Invalid model provenance'; end if;
  perform private.validate_web_research(doc);
  if web_metadata->>'stage' is distinct from 'complete' or web_metadata->>'search_requests' is distinct from '1' or web_metadata->>'provider_requests' is distinct from '1' or (web_metadata->>'sources_discovered')::int<>jsonb_array_length(doc->'sources') then raise exception 'Incomplete web evidence';end if;
  insert into public.artifacts(workspace_id,mission_id,run_id,task_id,kind,content)
   values(r.workspace_id,r.mission_id,rid,r.task_id,'researcher_document',doc);
 else
  if doc is not null or model_version is not null or error_code not in ('timeout','provider_error','invalid_output') then raise exception 'Invalid execution failure'; end if;
 end if;
 update public.runs set status=case when error_code is null then 'completed' else 'failed' end,ended_at=clock_timestamp(),failure_code=error_code,resolved_model=model_version,web_metadata=finish_web_research.web_metadata where id=rid;
 update public.tasks set execution_status=case when error_code is null then 'pending_review' else 'failed' end where id=r.task_id;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event)
  values(r.workspace_id,r.mission_id,r.requested_by,'researcher.'||coalesce(error_code,'result_pending_review')||':'||rid::text);
end $$;
create function public.finish_web_research(rid uuid,token_hash text,doc jsonb,error_code text,model_version text,web_metadata jsonb) returns void language sql security invoker set search_path='' as $$ select private.finish_web_research(rid,token_hash,doc,error_code,model_version,web_metadata) $$;
-- Persisted execution authorizations are immutable, including the mode and budgets.
create function private.guard_execution_authorization() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'Execution authorization is immutable';end $$;
create trigger execution_authorization_history before update or delete on public.task_execution_authorizations for each row execute function private.guard_execution_authorization();
-- Research artifacts are immutable; legacy mock/plan operations retain their existing behavior.
create function private.guard_research_artifact() returns trigger language plpgsql set search_path='' as $$ begin if old.kind='researcher_document' then raise exception 'Researcher artifact is immutable';end if;if TG_OP='DELETE' then return old;end if;return new;end $$;
create trigger research_artifact_history before update or delete on public.artifacts for each row execute function private.guard_research_artifact();
revoke all on function private.researcher_provenance(public.tasks,uuid),private.validate_web_research(jsonb),private.validate_web_metadata(jsonb),private.guard_execution_authorization(),private.guard_research_artifact(),private.authorize_researcher_execution_v2(uuid,text,text,uuid,boolean,text),public.authorize_researcher_execution_v2(uuid,text,text,uuid,boolean,text),private.finish_web_research(uuid,text,jsonb,text,text,jsonb),public.finish_web_research(uuid,text,jsonb,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.authorize_researcher_execution_v2(uuid,text,text,uuid,boolean,text),public.authorize_researcher_execution_v2(uuid,text,text,uuid,boolean,text) to authenticated;
grant execute on function private.finish_web_research(uuid,text,jsonb,text,text,jsonb),public.finish_web_research(uuid,text,jsonb,text,text,jsonb),private.validate_web_metadata(jsonb) to service_role;
