-- M1.1 additive migration. Apply only after reviewing the hosted M0 reconciliation.
-- Never replay the foundation. Clients retain SELECT-only table grants and RLS.
alter table public.missions add column execution_mode text not null default 'mock'
 check (execution_mode in ('mock','chief_of_staff'));
alter table public.approvals drop constraint approvals_scope_check;
alter table public.approvals add constraint approvals_scope_check check (scope in ('mock_run','chief_of_staff_plan'));
alter table public.runs drop constraint runs_adapter_check;
alter table public.runs add constraint runs_adapter_check check (adapter in ('mock','openai'));
alter table public.runs add column requested_by uuid references auth.users(id),
 add column lease_hash text, add column expires_at timestamptz, add column model text,
 add column failure_code text;
alter table public.runs add constraint planning_run_metadata check (
 adapter='mock' or (requested_by is not null and lease_hash is not null and lease_hash ~ '^[a-f0-9]{64}$'
 and expires_at is not null and model is not null and length(model) between 1 and 100));
alter table public.artifacts add column kind text not null default 'mock'
 check (kind in ('mock','chief_of_staff_plan'));
create unique index one_plan_artifact_per_run on public.artifacts(run_id) where kind='chief_of_staff_plan';
alter table public.tasks drop constraint tasks_status_check;
alter table public.tasks add constraint tasks_status_check check (status in ('pending','running','completed','failed','cancelled','proposed'));
alter table public.tasks add column plan_run_id uuid, add column proposal_position integer,
 add column suggested_agent_role text, add column expected_deliverable text,
 add foreign key(workspace_id,plan_run_id) references public.runs(workspace_id,id),
 add constraint proposal_is_non_executable check (plan_run_id is null or (
 status='proposed' and agent_id is null and proposal_position is not null and proposal_position between 1 and 12
 and suggested_agent_role is not null and suggested_agent_role in ('chief-of-staff','researcher','developer')
 and expected_deliverable is not null and length(btrim(expected_deliverable)) between 1 and 2000)),
 add unique(plan_run_id,proposal_position);

-- Keep M0 behavior behind a guarded entry point. Revoke the renamed helper too:
-- a SECURITY INVOKER wrapper must not leave a second executable path for clients.
alter function private.transition_mission(uuid,text) rename to transition_mock_mission;
revoke all on function private.transition_mock_mission(uuid,text) from public, anon, authenticated;
create function private.transition_mission(mid uuid, requested_action text) returns text
language plpgsql security definer set search_path='' as $$
declare m public.missions; begin
 select * into m from public.missions where id=mid for update;
 if auth.uid() is null or private.workspace_role(m.workspace_id) is null then raise exception 'Workspace access denied'; end if;
 if m.execution_mode <> 'mock' then raise exception 'AI planning cannot use mock transitions'; end if;
 return private.transition_mock_mission(mid,requested_action);
end $$;
revoke all on function private.transition_mission(uuid,text) from public, anon;
grant execute on function private.transition_mission(uuid,text) to authenticated;
-- Rebind the existing public wrapper explicitly after renaming its target.
create or replace function public.transition_mission(mid uuid, requested_action text) returns text
language sql security invoker set search_path='' as $$ select private.transition_mission(mid,requested_action) $$;

create function private.begin_chief_plan(mid uuid, token_hash text, selected_model text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.missions; aid uuid; rid uuid; attempts integer; uid uuid := auth.uid(); begin
 select * into m from public.missions where id=mid for update;
 if uid is null or private.workspace_role(m.workspace_id) is distinct from 'owner' then raise exception 'Workspace owner authorization required'; end if;
 if token_hash is null or token_hash !~ '^[a-f0-9]{64}$' or selected_model is null or length(selected_model) not between 1 and 100 then raise exception 'Invalid planning configuration'; end if;
 if not (m.status='draft' and m.execution_mode='mock' or m.status='failed' and m.execution_mode='chief_of_staff') then raise exception 'Mission not eligible for planning'; end if;
 select count(*) into attempts from public.runs where mission_id=mid and adapter='openai';
 if attempts >= 3 then raise exception 'Maximum 3 planning attempts reached'; end if;
 if exists(select 1 from public.runs where mission_id=mid and status='running') then raise exception 'Planning already running'; end if;
 if exists(select 1 from public.approvals where mission_id=mid and scope<>'chief_of_staff_plan') then raise exception 'Mock approval cannot authorize AI planning'; end if;
 insert into public.approvals(workspace_id,mission_id,scope,status,decided_by,decided_at)
 values(m.workspace_id,mid,'chief_of_staff_plan','approved',uid,clock_timestamp())
 on conflict(mission_id) do update set status='approved',decided_by=uid,decided_at=clock_timestamp()
 returning id into aid;
 insert into public.runs(workspace_id,mission_id,approval_id,adapter,status,requested_by,lease_hash,expires_at,model)
 values(m.workspace_id,mid,aid,'openai','running',uid,token_hash,clock_timestamp()+interval '120 seconds',selected_model)
 returning id into rid;
 update public.missions set execution_mode='chief_of_staff',status='running' where id=mid;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event)
 values(m.workspace_id,mid,uid,'chief_of_staff.authorized');
 return jsonb_build_object('runId',rid,'title',m.title,'objective',m.objective);
end $$;

-- Validate independently of TypeScript: service finalization cannot persist arbitrary JSON.
create function private.validate_chief_plan(plan jsonb) returns void
language plpgsql set search_path='' as $$
declare item jsonb; begin
 if plan is null or jsonb_typeof(plan) is distinct from 'object' then raise exception 'Invalid plan'; end if;
 if (select count(*) from jsonb_object_keys(plan)) <> 3
 or not (plan ?& array['summary','tasks','risks'])
 or jsonb_typeof(plan->'summary') is distinct from 'string'
 or length(btrim(plan->>'summary')) not between 1 and 2000
 or jsonb_typeof(plan->'tasks') is distinct from 'array'
 or jsonb_typeof(plan->'risks') is distinct from 'array' then raise exception 'Invalid plan'; end if;
 if jsonb_array_length(plan->'tasks') not between 1 and 12 or jsonb_array_length(plan->'risks')>10 then raise exception 'Invalid plan'; end if;
 for item in select value from jsonb_array_elements(plan->'tasks') loop
  if jsonb_typeof(item) is distinct from 'object' then raise exception 'Invalid task'; end if;
  if (select count(*) from jsonb_object_keys(item))<>3
   or not (item ?& array['title','suggested_agent_role','expected_deliverable'])
   or jsonb_typeof(item->'title') is distinct from 'string'
   or length(btrim(item->>'title')) not between 1 and 200
   or item->>'suggested_agent_role' not in ('chief-of-staff','researcher','developer')
   or jsonb_typeof(item->'suggested_agent_role') is distinct from 'string'
   or jsonb_typeof(item->'expected_deliverable') is distinct from 'string'
   or length(btrim(item->>'expected_deliverable')) not between 1 and 2000 then raise exception 'Invalid task'; end if;
 end loop;
 for item in select value from jsonb_array_elements(plan->'risks') loop
  if jsonb_typeof(item) is distinct from 'string' or length(btrim(item #>> '{}')) not between 1 and 500 then raise exception 'Invalid risk'; end if;
 end loop;
end $$;

-- Only the server's service-role client can finalize. Actor comes from the claimed run,
-- never a caller-supplied user ID. A per-invocation capability also binds the finalizer.
create function private.finish_chief_plan(rid uuid, token_hash text, plan jsonb, error_code text) returns void
language plpgsql security definer set search_path='' as $$
declare r public.runs; m public.missions; item jsonb; pos integer := 0; begin
 select m0.* into m from public.missions m0 join public.runs r0 on r0.mission_id=m0.id where r0.id=rid for update of m0;
 select * into r from public.runs where id=rid for update;
 if r.id is null or r.adapter<>'openai' or r.status<>'running' or m.execution_mode<>'chief_of_staff'
 or m.status<>'running' or token_hash is null or r.lease_hash is distinct from token_hash
 or r.expires_at<=clock_timestamp() then raise exception 'Invalid or expired planning lease'; end if;
 if not exists(select 1 from public.workspace_members where workspace_id=r.workspace_id and user_id=r.requested_by and role='owner')
 or not exists(select 1 from public.approvals where id=r.approval_id and mission_id=r.mission_id and scope='chief_of_staff_plan' and status='approved' and decided_by=r.requested_by)
 then raise exception 'Owner authorization no longer valid'; end if;
 if error_code is not null then
  if plan is not null or error_code not in ('timeout','provider_error','invalid_output') then raise exception 'Invalid failure'; end if;
 else
  perform private.validate_chief_plan(plan);
  insert into public.artifacts(workspace_id,mission_id,run_id,kind,content)
  values(r.workspace_id,r.mission_id,rid,'chief_of_staff_plan',plan);
  for item in select value from jsonb_array_elements(plan->'tasks') loop
   pos := pos+1;
   insert into public.tasks(workspace_id,mission_id,title,status,plan_run_id,proposal_position,suggested_agent_role,expected_deliverable)
   values(r.workspace_id,r.mission_id,item->>'title','proposed',rid,pos,item->>'suggested_agent_role',item->>'expected_deliverable');
  end loop;
 end if;
 update public.runs set status=case when error_code is null then 'completed' else 'failed' end,
  ended_at=clock_timestamp(),failure_code=error_code where id=rid;
 update public.missions set status=case when error_code is null then 'awaiting_approval' else 'failed' end where id=r.mission_id;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event)
 values(r.workspace_id,r.mission_id,r.requested_by,case when error_code is null then 'chief_of_staff.plan_review_required' else 'chief_of_staff.'||error_code end);
end $$;

create function private.recover_chief_plan(mid uuid) returns void
language plpgsql security definer set search_path='' as $$
declare m public.missions; rid uuid; begin
 select * into m from public.missions where id=mid for update;
 if auth.uid() is null or private.workspace_role(m.workspace_id) is distinct from 'owner' then raise exception 'Workspace owner authorization required'; end if;
 if m.execution_mode<>'chief_of_staff' or m.status<>'running' then raise exception 'No interrupted planning run'; end if;
 update public.runs set status='failed',ended_at=clock_timestamp(),failure_code='interrupted'
 where mission_id=mid and adapter='openai' and status='running' and expires_at<=clock_timestamp() returning id into rid;
 if rid is null then raise exception 'Planning lease has not expired'; end if;
 update public.missions set status='failed' where id=mid;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event) values(m.workspace_id,mid,auth.uid(),'chief_of_staff.interrupted');
end $$;

create function public.begin_chief_plan(mid uuid, token_hash text, selected_model text) returns jsonb
language sql security invoker set search_path='' as $$ select private.begin_chief_plan(mid,token_hash,selected_model) $$;
create function public.finish_chief_plan(rid uuid, token_hash text, plan jsonb, error_code text) returns void
language sql security invoker set search_path='' as $$ select private.finish_chief_plan(rid,token_hash,plan,error_code) $$;
create function public.recover_chief_plan(mid uuid) returns void
language sql security invoker set search_path='' as $$ select private.recover_chief_plan(mid) $$;

revoke all on function private.begin_chief_plan(uuid,text,text), public.begin_chief_plan(uuid,text,text),
 private.recover_chief_plan(uuid), public.recover_chief_plan(uuid),
 private.finish_chief_plan(uuid,text,jsonb,text), public.finish_chief_plan(uuid,text,jsonb,text),
 private.validate_chief_plan(jsonb) from public, anon, authenticated;
grant execute on function private.begin_chief_plan(uuid,text,text), public.begin_chief_plan(uuid,text,text),
 private.recover_chief_plan(uuid), public.recover_chief_plan(uuid) to authenticated;
grant usage on schema private to service_role;
grant execute on function private.finish_chief_plan(uuid,text,jsonb,text), public.finish_chief_plan(uuid,text,jsonb,text) to service_role;
