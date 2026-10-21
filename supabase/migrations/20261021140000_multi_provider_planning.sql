-- M1.2 only. Do not replay M0/M1.1 or reconcile their remote version IDs.
-- Provider identity uses runs.adapter; historical OpenAI rows and RLS remain unchanged.
alter table public.runs drop constraint runs_adapter_check;
alter table public.runs add constraint runs_adapter_check check (adapter in ('mock','openai','gemini'));

create function private.begin_chief_plan(mid uuid, token_hash text, selected_model text, selected_provider text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.missions; aid uuid; rid uuid; attempts integer; uid uuid := auth.uid(); begin
 select * into m from public.missions where id=mid for update;
 if uid is null or private.workspace_role(m.workspace_id) is distinct from 'owner' then raise exception 'Workspace owner authorization required'; end if;
 if selected_provider is null or selected_provider not in ('openai','gemini') then raise exception 'Invalid AI provider'; end if;
 if token_hash is null or token_hash !~ '^[a-f0-9]{64}$' or selected_model is null or length(selected_model) not between 1 and 100 then raise exception 'Invalid planning configuration'; end if;
 if not (m.status='draft' and m.execution_mode='mock' or m.status='failed' and m.execution_mode='chief_of_staff') then raise exception 'Mission not eligible for planning'; end if;
 select count(*) into attempts from public.runs where mission_id=mid and adapter in ('openai','gemini');
 if attempts >= 3 then raise exception 'Maximum 3 planning attempts reached'; end if;
 if exists(select 1 from public.runs where mission_id=mid and status='running') then raise exception 'Planning already running'; end if;
 if exists(select 1 from public.approvals where mission_id=mid and scope<>'chief_of_staff_plan') then raise exception 'Mock approval cannot authorize AI planning'; end if;
 insert into public.approvals(workspace_id,mission_id,scope,status,decided_by,decided_at)
 values(m.workspace_id,mid,'chief_of_staff_plan','approved',uid,clock_timestamp())
 on conflict(mission_id) do update set status='approved',decided_by=uid,decided_at=clock_timestamp()
 returning id into aid;
 insert into public.runs(workspace_id,mission_id,approval_id,adapter,status,requested_by,lease_hash,expires_at,model)
 values(m.workspace_id,mid,aid,selected_provider,'running',uid,token_hash,clock_timestamp()+interval '120 seconds',selected_model)
 returning id into rid;
 update public.missions set execution_mode='chief_of_staff',status='running' where id=mid;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event)
 values(m.workspace_id,mid,uid,'chief_of_staff.authorized');
 return jsonb_build_object('runId',rid,'title',m.title,'objective',m.objective);
end $$;

create or replace function private.finish_chief_plan(rid uuid, token_hash text, plan jsonb, error_code text) returns void
language plpgsql security definer set search_path='' as $$
declare r public.runs; m public.missions; item jsonb; pos integer := 0; begin
 select m0.* into m from public.missions m0 join public.runs r0 on r0.mission_id=m0.id where r0.id=rid for update of m0;
 select * into r from public.runs where id=rid for update;
 if r.id is null or r.adapter not in ('openai','gemini') or r.status<>'running' or m.execution_mode<>'chief_of_staff'
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

create or replace function private.recover_chief_plan(mid uuid) returns void
language plpgsql security definer set search_path='' as $$
declare m public.missions; rid uuid; begin
 select * into m from public.missions where id=mid for update;
 if auth.uid() is null or private.workspace_role(m.workspace_id) is distinct from 'owner' then raise exception 'Workspace owner authorization required'; end if;
 if m.execution_mode<>'chief_of_staff' or m.status<>'running' then raise exception 'No interrupted planning run'; end if;
 update public.runs set status='failed',ended_at=clock_timestamp(),failure_code='interrupted'
 where mission_id=mid and adapter in ('openai','gemini') and status='running' and expires_at<=clock_timestamp() returning id into rid;
 if rid is null then raise exception 'Planning lease has not expired'; end if;
 update public.missions set status='failed' where id=mid;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event) values(m.workspace_id,mid,auth.uid(),'chief_of_staff.interrupted');
end $$;

-- Preserve the old three-argument API, including its shared cross-provider attempt limit.
create or replace function private.begin_chief_plan(mid uuid, token_hash text, selected_model text) returns jsonb
language sql security invoker set search_path='' as $$ select private.begin_chief_plan(mid,token_hash,selected_model,'openai') $$;
create function public.begin_chief_plan(mid uuid, token_hash text, selected_model text, selected_provider text) returns jsonb
language sql security invoker set search_path='' as $$ select private.begin_chief_plan(mid,token_hash,selected_model,selected_provider) $$;
revoke all on function private.begin_chief_plan(uuid,text,text,text), public.begin_chief_plan(uuid,text,text,text) from public, anon, authenticated;
grant execute on function private.begin_chief_plan(uuid,text,text,text), public.begin_chief_plan(uuid,text,text,text) to authenticated;
-- CREATE OR REPLACE preserves the established finalizer/recovery ACLs. Reassert the
-- privileged finalization boundary, including direct Supabase-style default grants.
revoke all on function private.finish_chief_plan(uuid,text,jsonb,text), public.finish_chief_plan(uuid,text,jsonb,text) from public, anon, authenticated;
grant execute on function private.finish_chief_plan(uuid,text,jsonb,text), public.finish_chief_plan(uuid,text,jsonb,text) to service_role;
