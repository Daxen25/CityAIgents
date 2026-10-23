-- M1.5A only: new extension history; never replay historical migrations.
create table public.mission_extensions (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),mission_id uuid not null,
 version integer not null check(version>0),request_id uuid not null unique,requested_by uuid not null references auth.users(id),
 instruction text not null check(length(btrim(instruction)) between 1 and 2000),provider text not null default 'gemini' check(provider='gemini'),
 model text not null check(model ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'),resolved_model text check(resolved_model ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'),
 status text not null check(status in ('running','proposed','approved','rejected','failed','stale')),
 context jsonb not null check(octet_length(context::text)<=12000),fingerprint text not null,lease_hash text not null check(lease_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz not null,created_at timestamptz not null default clock_timestamp(),ended_at timestamptz,
 proposal jsonb,failure_code text check(failure_code in ('timeout','provider_error','invalid_output','interrupted','stale_context')),
 unique(workspace_id,id),unique(mission_id,version),foreign key(workspace_id,mission_id) references public.missions(workspace_id,id)
);
create unique index one_open_extension on public.mission_extensions(mission_id) where status in ('running','proposed');
create table public.mission_extension_reviews (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),mission_id uuid not null,
 proposal_id uuid not null unique,request_id uuid not null unique,accepted_positions integer[] not null check(cardinality(accepted_positions) between 0 and 8 and array_position(accepted_positions,null) is null),
 decided_by uuid not null references auth.users(id),decided_at timestamptz not null default clock_timestamp(),
 foreign key(workspace_id,proposal_id) references public.mission_extensions(workspace_id,id),
 foreign key(workspace_id,mission_id) references public.missions(workspace_id,id)
);
alter table public.tasks add column extension_id uuid,
 add foreign key(workspace_id,extension_id) references public.mission_extensions(workspace_id,id);
create unique index one_task_per_extension_position on public.tasks(extension_id,proposal_position) where extension_id is not null;
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
  and execution_status='not_authorized' and execution_run_id is null and proposal_position is not null and proposal_position between 1 and 8
  and suggested_agent_role is not null and suggested_agent_role in ('chief-of-staff','researcher','developer')
  and expected_deliverable is not null and length(btrim(expected_deliverable)) between 1 and 2000)
);
-- No client DML or service-role table writes. The lease capability is never SELECT-granted.
alter table public.mission_extensions enable row level security;
alter table public.mission_extension_reviews enable row level security;
create policy member_read on public.mission_extensions for select to authenticated using(private.workspace_role(workspace_id) is not null);
create policy member_read on public.mission_extension_reviews for select to authenticated using(private.workspace_role(workspace_id) is not null);
revoke all on public.mission_extensions,public.mission_extension_reviews from public,anon,authenticated,service_role;
grant select(id,workspace_id,mission_id,version,request_id,requested_by,instruction,provider,model,resolved_model,status,created_at,expires_at,ended_at,proposal,failure_code) on public.mission_extensions to authenticated;
grant select on public.mission_extension_reviews to authenticated;

create function private.extension_fingerprint(mid uuid) returns text language sql stable set search_path='' as $$
 select md5(jsonb_build_object(
 'mission',(select jsonb_build_array(title,objective,status,execution_mode) from public.missions where id=mid),
 'tasks',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.tasks t where mission_id=mid),
 'runs',(select coalesce(jsonb_agg(jsonb_build_array(id,status,started_at,ended_at,resolved_model) order by id),'[]') from public.runs where mission_id=mid),
 'artifacts',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from public.artifacts a where mission_id=mid),
 'plan_reviews',(select coalesce(jsonb_agg(to_jsonb(v) order by v.id),'[]') from public.task_plan_reviews v where mission_id=mid),
 'extension_history',(select coalesce(jsonb_agg(jsonb_build_array(id,status,proposal,failure_code) order by id),'[]') from public.mission_extensions where mission_id=mid and status not in ('running','proposed')),
 'extension_reviews',(select coalesce(jsonb_agg(to_jsonb(v) order by v.id),'[]') from public.mission_extension_reviews v where mission_id=mid),
 'reviews',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') from public.task_execution_reviews r where mission_id=mid)
 )::text)
$$;
create function private.begin_mission_extension(mid uuid,instruction text,request_id uuid,token_hash text,selected_model text,confirmed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.missions;ctx jsonb;pid uuid;rev integer;uid uuid:=auth.uid();begin
 select * into m from public.missions where id=mid for update;
 if uid is null or private.workspace_role(m.workspace_id) is distinct from 'owner' then raise exception 'Workspace owner authorization required';end if;
 if confirmed is distinct from true then raise exception 'Fresh explicit authorization required';end if;
 if m.execution_mode<>'chief_of_staff' or m.status<>'approved' then raise exception 'Approved AI mission required';end if;
 if instruction is null or length(btrim(instruction)) not between 1 and 2000 or request_id is null or token_hash is null or token_hash !~ '^[a-f0-9]{64}$'
  or selected_model is null or selected_model !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$' then raise exception 'Invalid extension request';end if;
 if exists(select 1 from public.runs where mission_id=mid and status='running') or exists(select 1 from public.mission_extensions where mission_id=mid and status in ('running','proposed')) then raise exception 'Finish or recover active work before extending';end if;
 if (select count(*) from public.tasks where mission_id=mid)>30 then raise exception 'Mission context exceeds 30 tasks';end if;
 ctx:=jsonb_build_object('mission',jsonb_build_object('title',m.title,'objective',left(m.objective,2000)),
 'tasks',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'title',left(title,160),'role',suggested_agent_role,'status',status,'execution',execution_status) order by id),'[]') from public.tasks where mission_id=mid),
 'accepted_deliverables',(select coalesce(jsonb_agg(x),'[]') from (select jsonb_build_object('task_id',a.task_id,'summary',left(a.content->>'summary',500)) x from public.artifacts a join public.task_execution_reviews r on r.artifact_id=a.id where a.mission_id=mid and r.mission_id=mid and a.workspace_id=m.workspace_id and r.workspace_id=m.workspace_id and r.decision='accepted' order by r.decided_at desc limit 5) s),
 'previous_extensions',(select coalesce(jsonb_agg(x),'[]') from (select jsonb_build_object('version',version,'status',status,'summary',left(proposal->>'summary',200)) x from public.mission_extensions where mission_id=mid order by version desc limit 5) s),
 'instruction',btrim(instruction));
 if octet_length(ctx::text)>12000 then raise exception 'Mission context exceeds 12000 bytes';end if;
 select coalesce(max(version),0)+1 into rev from public.mission_extensions where mission_id=mid;
 insert into public.mission_extensions(workspace_id,mission_id,version,request_id,requested_by,instruction,model,status,context,fingerprint,lease_hash,expires_at)
 values(m.workspace_id,mid,rev,request_id,uid,btrim(instruction),selected_model,'running',ctx,private.extension_fingerprint(mid),token_hash,clock_timestamp()+interval '120 seconds') returning id into pid;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event) values(m.workspace_id,mid,uid,'extension.authorized:'||pid::text);
 return jsonb_build_object('proposalId',pid,'context',ctx);
end $$;
create function private.validate_mission_extension(doc jsonb,snapshot jsonb) returns void language plpgsql set search_path='' as $$
declare item jsonb;d jsonb;pos integer:=0;key text;lim integer;begin
 if doc is null or jsonb_typeof(doc)<>'object' then raise exception 'Invalid extension';end if;
 if (select count(*) from jsonb_object_keys(doc))<>2 or not(doc ?& array['summary','tasks']) or jsonb_typeof(doc->'summary')<>'string'
 or length(btrim(doc->>'summary')) not between 1 and 1000 or jsonb_typeof(doc->'tasks')<>'array' then raise exception 'Invalid extension';end if;
 if jsonb_array_length(doc->'tasks') not between 1 and 8 then raise exception 'Invalid extension size';end if;
 for item in select value from jsonb_array_elements(doc->'tasks') loop
  pos:=pos+1;
  if jsonb_typeof(item)<>'object' then raise exception 'Invalid extension task';end if;
  if (select count(*) from jsonb_object_keys(item))<>6 or not(item ?& array['title','description','priority','suggested_agent_role','expected_deliverable','dependencies']) then raise exception 'Invalid extension task';end if;
  foreach key in array array['title','description','expected_deliverable'] loop
   lim:=case key when 'title' then 200 when 'description' then 1000 else 2000 end;
   if jsonb_typeof(item->key)<>'string' or length(btrim(item->>key)) not between 1 and lim then raise exception 'Invalid extension text';end if;
  end loop;
  if jsonb_typeof(item->'priority')<>'string' or item->>'priority' not in ('low','medium','high') or jsonb_typeof(item->'suggested_agent_role')<>'string' or item->>'suggested_agent_role' not in ('chief-of-staff','researcher','developer')
   or jsonb_typeof(item->'dependencies')<>'array' then raise exception 'Invalid role, priority or dependencies';end if;
  if jsonb_array_length(item->'dependencies')>5 then raise exception 'Too many dependencies';end if;
  for d in select value from jsonb_array_elements(item->'dependencies') loop
   if jsonb_typeof(d)<>'object' then raise exception 'Invalid dependency';end if;
   if (select count(*) from jsonb_object_keys(d))<>2 or not(d ?& array['existing_task_id','proposal_position']) or (d->'existing_task_id'='null'::jsonb)=(d->'proposal_position'='null'::jsonb) then raise exception 'Invalid dependency';end if;
   if d->'existing_task_id'<>'null'::jsonb then
    if jsonb_typeof(d->'existing_task_id')<>'string' or not exists(select 1 from jsonb_array_elements(snapshot->'tasks') t where (t->>'id')::uuid=(d->>'existing_task_id')::uuid and t->>'status' not in ('rejected','cancelled','failed')) then raise exception 'Dependency outside eligible mission tasks';end if;
   else
    if jsonb_typeof(d->'proposal_position')<>'number' or d->>'proposal_position' !~ '^[1-8]$' or (d->>'proposal_position')::integer>=pos then raise exception 'Dependencies must refer to earlier additions';end if;
   end if;
  end loop;
 end loop;
end $$;
create function private.finish_mission_extension(pid uuid,token_hash text,doc jsonb,error_code text,model_version text) returns void
language plpgsql security definer set search_path='' as $$
declare p public.mission_extensions;m public.missions;begin
 select m0.* into m from public.missions m0 join public.mission_extensions p0 on p0.mission_id=m0.id where p0.id=pid for update of m0;
 select * into p from public.mission_extensions where id=pid for update;
 if p.id is null or p.status<>'running' or token_hash is null or p.lease_hash<>token_hash or p.expires_at<=clock_timestamp()
  or not exists(select 1 from public.workspace_members where workspace_id=p.workspace_id and user_id=p.requested_by and role='owner') then raise exception 'Invalid or expired extension authorization';end if;
 if error_code is not null then
  if error_code not in ('timeout','provider_error','invalid_output') or doc is not null or model_version is not null then raise exception 'Invalid extension failure';end if;
  update public.mission_extensions set status='failed',failure_code=error_code,ended_at=clock_timestamp() where id=pid;
 else
  perform private.validate_mission_extension(doc,p.context);
  if model_version is not null and model_version !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$' then raise exception 'Invalid model provenance';end if;
  update public.mission_extensions set proposal=doc,resolved_model=model_version,ended_at=clock_timestamp(),
   status=case when m.status<>'approved' or private.extension_fingerprint(p.mission_id)<>p.fingerprint then 'stale' else 'proposed' end,
   failure_code=case when m.status<>'approved' or private.extension_fingerprint(p.mission_id)<>p.fingerprint then 'stale_context' else null end where id=pid;
 end if;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event) values(p.workspace_id,p.mission_id,p.requested_by,'extension.finished:'||pid::text);
end $$;
create function private.review_mission_extension(pid uuid,accepted_positions integer[],request_id uuid,confirmed boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare p public.mission_extensions;m public.missions;previous public.mission_extension_reviews;chosen integer[];rid uuid;item jsonb;pos integer:=0;agent uuid;d jsonb;uid uuid:=auth.uid();begin
 select m0.* into m from public.missions m0 join public.mission_extensions p0 on p0.mission_id=m0.id where p0.id=pid for update of m0;
 if uid is null or private.workspace_role(m.workspace_id) is distinct from 'owner' then raise exception 'Workspace owner authorization required';end if;
 if confirmed is distinct from true or request_id is null or accepted_positions is null or array_position(accepted_positions,null) is not null then raise exception 'Explicit review required';end if;
 chosen:=array(select distinct v from unnest(accepted_positions) v order by v);
 if cardinality(chosen)<>cardinality(accepted_positions) or cardinality(chosen)>8 then raise exception 'Invalid selection';end if;
 select * into previous from public.mission_extension_reviews where proposal_id=pid;
 if found then
  if previous.request_id=request_id and previous.accepted_positions=chosen and previous.decided_by=uid then return previous.id;end if;
  raise exception 'Extension already reviewed';
 end if;
 select * into p from public.mission_extensions where id=pid for update;
 if p.status not in ('proposed','stale') then raise exception 'Extension is not awaiting review';end if;
 if cardinality(chosen)>0 and (p.status='stale' or m.status<>'approved' or private.extension_fingerprint(m.id)<>p.fingerprint or exists(select 1 from public.runs where mission_id=m.id and status='running')) then
  update public.mission_extensions set status='stale',failure_code='stale_context' where id=pid;
  insert into public.activity_events(workspace_id,mission_id,actor_id,event) values(m.workspace_id,m.id,uid,'extension.stale:'||pid::text);
  return null; -- Commit stale marker; never apply tasks from changed context.
 end if;
 if cardinality(chosen)>0 then perform private.validate_mission_extension(p.proposal,p.context);end if;
 if exists(select 1 from unnest(chosen) v where v<1 or v>jsonb_array_length(p.proposal->'tasks')) then raise exception 'Selection outside proposal';end if;
 for item in select value from jsonb_array_elements(p.proposal->'tasks') loop
  pos:=pos+1;
  if pos=any(chosen) then
   for d in select value from jsonb_array_elements(item->'dependencies') loop
    if d->'proposal_position'<>'null'::jsonb and not((d->>'proposal_position')::integer=any(chosen)) then raise exception 'Accept required dependencies or reject dependent task';end if;
   end loop;
   select id into agent from public.agents where workspace_id=m.workspace_id and definition_key=item->>'suggested_agent_role';
   if agent is null then raise exception 'Known workspace assignment required';end if;
   insert into public.tasks(workspace_id,mission_id,extension_id,title,status,agent_id,proposal_position,suggested_agent_role,expected_deliverable)
   values(m.workspace_id,m.id,pid,item->>'title','approved',agent,pos,item->>'suggested_agent_role',item->>'expected_deliverable');
   insert into public.activity_events(workspace_id,mission_id,actor_id,event) values(m.workspace_id,m.id,uid,'extension.task_approved:'||pid::text||':'||pos::text);
  end if;
 end loop;
 insert into public.mission_extension_reviews(workspace_id,mission_id,proposal_id,request_id,accepted_positions,decided_by)
 values(m.workspace_id,m.id,pid,request_id,chosen,uid) returning id into rid;
 update public.mission_extensions set status=case when cardinality(chosen)>0 then 'approved' else 'rejected' end where id=pid;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event) values(m.workspace_id,m.id,uid,'extension.reviewed:'||pid::text);
 return rid;
end $$;
create function private.recover_mission_extension(pid uuid) returns void language plpgsql security definer set search_path='' as $$
declare p public.mission_extensions;begin
 perform 1 from public.missions m join public.mission_extensions e on e.mission_id=m.id where e.id=pid for update of m;
 select * into p from public.mission_extensions where id=pid for update;
 if auth.uid() is null or private.workspace_role(p.workspace_id) is distinct from 'owner' then raise exception 'Workspace owner authorization required';end if;
 if p.status<>'running' or p.expires_at>clock_timestamp() then raise exception 'No expired extension to recover';end if;
 update public.mission_extensions set status='failed',failure_code='interrupted',ended_at=clock_timestamp() where id=pid;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event) values(p.workspace_id,p.mission_id,auth.uid(),'extension.recovered:'||pid::text);
end $$;
-- Frozen request/context/output and immutable decisions, including against accidental future RPCs.
create function private.guard_extension_history() returns trigger language plpgsql set search_path='' as $$ begin
 if TG_OP='DELETE' then raise exception 'Extension history is immutable';end if;
 if TG_TABLE_NAME='mission_extension_reviews' then raise exception 'Extension reviews are immutable';end if;
 if (to_jsonb(new)-array['status','proposal','failure_code','resolved_model','ended_at']) is distinct from (to_jsonb(old)-array['status','proposal','failure_code','resolved_model','ended_at'])
  or old.status not in ('running','proposed','stale')
  or (old.status='running' and new.status not in ('proposed','failed','stale'))
  or (old.status='stale' and new.status='approved')
  or (old.status in ('proposed','stale') and (new.status not in ('approved','rejected','stale') or new.proposal is distinct from old.proposal or new.resolved_model is distinct from old.resolved_model or new.ended_at is distinct from old.ended_at)) then raise exception 'Extension history is immutable';end if;
 return new;
end $$;
create trigger extension_history before update or delete on public.mission_extensions for each row execute function private.guard_extension_history();
create trigger extension_review_history before update or delete on public.mission_extension_reviews for each row execute function private.guard_extension_history();

create function private.guard_extension_task() returns trigger language plpgsql set search_path='' as $$ begin
 if old.extension_id is not null or (TG_OP='UPDATE' and new.extension_id is not null) then raise exception 'Approved extension task history is immutable in M1.5A';end if;
 if TG_OP='DELETE' then return old;end if;return new;
end $$;
create trigger extension_task_history before update or delete on public.tasks for each row execute function private.guard_extension_task();

create function public.begin_mission_extension(mid uuid,instruction text,request_id uuid,token_hash text,selected_model text,confirmed boolean) returns jsonb language sql security invoker set search_path='' as $$ select private.begin_mission_extension(mid,instruction,request_id,token_hash,selected_model,confirmed) $$;
create function public.finish_mission_extension(pid uuid,token_hash text,doc jsonb,error_code text,model_version text) returns void language sql security invoker set search_path='' as $$ select private.finish_mission_extension(pid,token_hash,doc,error_code,model_version) $$;
create function public.review_mission_extension(pid uuid,accepted_positions integer[],request_id uuid,confirmed boolean) returns uuid language sql security invoker set search_path='' as $$ select private.review_mission_extension(pid,accepted_positions,request_id,confirmed) $$;
create function public.recover_mission_extension(pid uuid) returns void language sql security invoker set search_path='' as $$ select private.recover_mission_extension(pid) $$;
revoke all on function private.guard_extension_task(),private.extension_fingerprint(uuid),private.validate_mission_extension(jsonb,jsonb),private.guard_extension_history(),private.begin_mission_extension(uuid,text,uuid,text,text,boolean),public.begin_mission_extension(uuid,text,uuid,text,text,boolean),private.finish_mission_extension(uuid,text,jsonb,text,text),public.finish_mission_extension(uuid,text,jsonb,text,text),private.review_mission_extension(uuid,integer[],uuid,boolean),public.review_mission_extension(uuid,integer[],uuid,boolean),private.recover_mission_extension(uuid),public.recover_mission_extension(uuid) from public,anon,authenticated,service_role;
grant execute on function private.begin_mission_extension(uuid,text,uuid,text,text,boolean),public.begin_mission_extension(uuid,text,uuid,text,text,boolean),private.review_mission_extension(uuid,integer[],uuid,boolean),public.review_mission_extension(uuid,integer[],uuid,boolean),private.recover_mission_extension(uuid),public.recover_mission_extension(uuid) to authenticated;
grant execute on function private.finish_mission_extension(uuid,text,jsonb,text,text),public.finish_mission_extension(uuid,text,jsonb,text,text) to service_role;
