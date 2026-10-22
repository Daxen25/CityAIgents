-- M1.3 only: human review and assignment, never execution. Do not replay history.
create table public.task_plan_reviews (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 mission_id uuid not null unique, run_id uuid not null unique,
 request_id uuid not null unique,
 decision text not null check(decision in ('approved','rejected')),
 accepted_task_ids uuid[] not null,
 decision_snapshot jsonb not null check(jsonb_typeof(decision_snapshot)='array'),
 decided_by uuid not null references auth.users(id), decided_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),
 foreign key(workspace_id,mission_id) references public.missions(workspace_id,id),
 foreign key(workspace_id,run_id) references public.runs(workspace_id,id),
 check((decision='approved' and cardinality(accepted_task_ids) between 1 and 12)
    or (decision='rejected' and cardinality(accepted_task_ids)=0))
);
create index task_plan_reviews_workspace on public.task_plan_reviews(workspace_id);
alter table public.task_plan_reviews enable row level security;
create policy member_read on public.task_plan_reviews for select to authenticated
 using(private.workspace_role(workspace_id) is not null);
revoke all on public.task_plan_reviews from public, anon, authenticated;
grant select on public.task_plan_reviews to authenticated;

alter table public.tasks add column review_id uuid,
 add foreign key(workspace_id,review_id) references public.task_plan_reviews(workspace_id,id);
alter table public.tasks drop constraint tasks_status_check;
alter table public.tasks add constraint tasks_status_check
 check(status in ('pending','running','completed','failed','cancelled','proposed','approved','rejected'));
alter table public.tasks drop constraint proposal_is_non_executable;
-- Historical M0 tasks and unreviewed M1.x proposals remain valid. A reviewed task
-- cannot become running/completed even through a future accidental table write.
alter table public.tasks add constraint proposal_is_non_executable check (
 (plan_run_id is null and review_id is null and status not in ('approved','rejected')) or
 (plan_run_id is not null and proposal_position is not null and proposal_position between 1 and 12
  and suggested_agent_role is not null and suggested_agent_role in ('chief-of-staff','researcher','developer')
  and expected_deliverable is not null and length(btrim(expected_deliverable)) between 1 and 2000
  and ((status='proposed' and agent_id is null and review_id is null)
    or (status='approved' and agent_id is not null and review_id is not null)
    or (status='rejected' and agent_id is null and review_id is not null)))
);

create function private.review_task_plan(mid uuid, rid uuid, accepted_ids uuid[], decision text, confirmed boolean, request_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 m public.missions; r public.runs; previous public.task_plan_reviews; item public.tasks;
 content jsonb; chosen uuid[]; review_uuid uuid; assigned uuid; total integer;
 snapshot jsonb := '[]'::jsonb; entry jsonb; task_decision text; uid uuid := auth.uid();
begin
 -- The mission lock serializes planning, review and competing owner submissions.
 select * into m from public.missions where id=mid for update;
 if uid is null or private.workspace_role(m.workspace_id) is distinct from 'owner' then
  raise exception 'Workspace owner authorization required';
 end if;
 if confirmed is distinct from true then raise exception 'Explicit final confirmation required'; end if;
 if request_id is null or rid is null or decision is null or decision not in ('approved','rejected')
  or accepted_ids is null or array_position(accepted_ids,null) is not null then raise exception 'Invalid review request'; end if;
 chosen := array(select distinct value from unnest(accepted_ids) value order by value);
 if cardinality(chosen)<>cardinality(accepted_ids) or cardinality(chosen)>12 then raise exception 'Invalid task selection'; end if;
 if (decision='approved' and cardinality(chosen)=0) or (decision='rejected' and cardinality(chosen)<>0) then
  raise exception 'Approval requires accepted tasks; rejection accepts none';
 end if;
 select * into previous from public.task_plan_reviews v where v.mission_id=mid;
 if found then
  if previous.request_id=request_id and previous.run_id=rid and previous.decision=decision
   and previous.accepted_task_ids=chosen and previous.decided_by=uid then return previous.id; end if;
  raise exception 'Plan already reviewed';
 end if;
 if exists(select 1 from public.task_plan_reviews v where v.request_id=review_task_plan.request_id) then
  raise exception 'Review request already used';
 end if;
 if m.execution_mode<>'chief_of_staff' or m.status<>'awaiting_approval' then raise exception 'Plan is not awaiting review'; end if;
 select * into r from public.runs where id=rid and mission_id=mid and workspace_id=m.workspace_id
  and adapter in ('openai','gemini') and status='completed' for update;
 if not found then raise exception 'Completed planning run required'; end if;
 select a.content into content from public.artifacts a where a.run_id=rid and a.mission_id=mid
  and a.workspace_id=m.workspace_id and a.kind='chief_of_staff_plan';
 if not found then raise exception 'Plan artifact required'; end if;
 perform private.validate_chief_plan(content);
 -- Lock every task in deterministic order and reject inconsistent/manual state.
 perform 1 from public.tasks where plan_run_id=rid order by proposal_position for update;
 select count(*) into total from public.tasks where plan_run_id=rid;
 if total not between 1 and 12 or total<>jsonb_array_length(content->'tasks') then raise exception 'Plan task set mismatch'; end if;
 if exists(select 1 from public.tasks t where t.plan_run_id=rid and (
   t.workspace_id<>m.workspace_id or t.mission_id<>mid or t.status<>'proposed' or t.review_id is not null
   or t.title is distinct from (content->'tasks'->(t.proposal_position-1)->>'title')
   or t.suggested_agent_role is distinct from (content->'tasks'->(t.proposal_position-1)->>'suggested_agent_role')
   or t.expected_deliverable is distinct from (content->'tasks'->(t.proposal_position-1)->>'expected_deliverable')
 )) then raise exception 'Plan task set mismatch'; end if;
 if (select count(*) from public.tasks t where t.plan_run_id=rid and t.id=any(chosen))<>cardinality(chosen) then
  raise exception 'Task selection outside this plan';
 end if;
 -- Resolve assignments on the server from existing scoped agents/known definitions.
 -- Agent enabled=false is preserved: an assignment is not execution permission.
 if exists(select 1 from public.tasks t where t.plan_run_id=rid and t.id=any(chosen)
  and not exists(select 1 from public.agents a join public.agent_definitions d on d.key=a.definition_key
   where a.workspace_id=m.workspace_id and a.definition_key=t.suggested_agent_role)) then
  raise exception 'Known workspace agent assignment required';
 end if;
 review_uuid := gen_random_uuid();
 for item in select * from public.tasks where plan_run_id=rid order by proposal_position loop
  assigned := null;
  task_decision := case when item.id=any(chosen) then 'approved' else 'rejected' end;
  if task_decision='approved' then
   select id into assigned from public.agents where workspace_id=m.workspace_id and definition_key=item.suggested_agent_role;
  end if;
  snapshot := snapshot || jsonb_build_array(jsonb_build_object('taskId',item.id,'decision',task_decision,
   'agentId',assigned,'definitionKey',case when assigned is not null then item.suggested_agent_role else null end));
 end loop;
 insert into public.task_plan_reviews(id,workspace_id,mission_id,run_id,request_id,decision,accepted_task_ids,decision_snapshot,decided_by)
 values(review_uuid,m.workspace_id,mid,rid,request_id,decision,chosen,snapshot,uid);
 -- Persist exactly the assignments captured in the canonical audit snapshot.
 for entry in select value from jsonb_array_elements(snapshot) loop
  update public.tasks set status=entry->>'decision',agent_id=(entry->>'agentId')::uuid,review_id=review_uuid
   where id=(entry->>'taskId')::uuid;
  insert into public.activity_events(workspace_id,mission_id,actor_id,event)
   values(m.workspace_id,mid,uid,'task.'||(entry->>'decision')||':'||(entry->>'taskId'));
 end loop;
 update public.missions set status=case when decision='approved' then 'approved' else 'cancelled' end where id=mid;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event)
  values(m.workspace_id,mid,uid,'plan.review.'||decision);
 return review_uuid;
end $$;
create function public.review_task_plan(mid uuid, rid uuid, accepted_ids uuid[], decision text, confirmed boolean, request_id uuid) returns uuid
language sql security invoker set search_path='' as $$ select private.review_task_plan(mid,rid,accepted_ids,decision,confirmed,request_id) $$;
revoke all on function private.review_task_plan(uuid,uuid,uuid[],text,boolean,uuid),
 public.review_task_plan(uuid,uuid,uuid[],text,boolean,uuid) from public, anon, authenticated;
grant execute on function private.review_task_plan(uuid,uuid,uuid[],text,boolean,uuid),
 public.review_task_plan(uuid,uuid,uuid[],text,boolean,uuid) to authenticated;
