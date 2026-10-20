-- M0: all user data is scoped to a workspace. No service-role key in the app.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table public.workspaces (
 id uuid primary key default gen_random_uuid(), name text not null check(length(btrim(name)) between 2 and 80),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now()
);
create table public.workspace_members (
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 user_id uuid not null references auth.users(id), role text not null check(role in ('owner','member')),
 primary key(workspace_id,user_id)
);
create index workspace_members_user on public.workspace_members(user_id,workspace_id);
create table public.agent_definitions (
 key text primary key, version integer not null default 1 check(version>0), name text not null, description text not null
);
create table public.projects (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
 name text not null, created_at timestamptz not null default now(), unique(workspace_id,id)
);
create table public.agents (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
 definition_key text not null references public.agent_definitions(key), enabled boolean not null default false,
 unique(workspace_id,id), unique(workspace_id,definition_key)
);
create table public.missions (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
 project_id uuid, title text not null check(length(btrim(title)) between 3 and 120),
 objective text not null check(length(btrim(objective)) between 10 and 4000),
 kind text not null check(kind in ('personal','business')),
 status text not null default 'draft' check(status in ('draft','awaiting_approval','approved','running','completed','failed','cancelled')),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 unique(workspace_id,id), foreign key(workspace_id,project_id) references public.projects(workspace_id,id)
);
create table public.tasks (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
 mission_id uuid not null, agent_id uuid, title text not null,
 status text not null default 'pending' check(status in ('pending','running','completed','failed','cancelled')),
 unique(workspace_id,id), foreign key(workspace_id,mission_id) references public.missions(workspace_id,id),
 foreign key(workspace_id,agent_id) references public.agents(workspace_id,id)
);
create table public.approvals (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
 mission_id uuid not null unique, scope text not null default 'mock_run' check(scope='mock_run'),
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 decided_by uuid references auth.users(id), decided_at timestamptz,
 unique(workspace_id,id), foreign key(workspace_id,mission_id) references public.missions(workspace_id,id),
 check((status='pending' and decided_by is null and decided_at is null) or (status<>'pending' and decided_by is not null and decided_at is not null))
);
create table public.runs (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
 mission_id uuid not null, approval_id uuid not null, adapter text not null default 'mock' check(adapter='mock'),
 status text not null check(status in ('running','completed','failed')), started_at timestamptz not null default now(), ended_at timestamptz,
 unique(workspace_id,id), foreign key(workspace_id,mission_id) references public.missions(workspace_id,id),
 foreign key(workspace_id,approval_id) references public.approvals(workspace_id,id)
);
create unique index one_running_run on public.runs(mission_id) where status='running';
create table public.artifacts (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
 mission_id uuid not null, run_id uuid not null, storage_path text, media_type text not null default 'application/json',
 content jsonb, created_at timestamptz not null default now(),
 foreign key(workspace_id,mission_id) references public.missions(workspace_id,id), foreign key(workspace_id,run_id) references public.runs(workspace_id,id)
);
create table public.activity_events (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
 mission_id uuid not null, actor_id uuid not null references auth.users(id), event text not null,
 created_at timestamptz not null default now(), foreign key(workspace_id,mission_id) references public.missions(workspace_id,id)
);

-- Private helper avoids recursive membership policies. Only caller identity is considered.
create function private.workspace_role(wid uuid) returns text
language sql stable security definer set search_path = '' as $$
 select role from public.workspace_members where workspace_id=wid and user_id=(select auth.uid())
$$;
revoke all on function private.workspace_role(uuid) from public, anon;
grant execute on function private.workspace_role(uuid) to authenticated;

alter table public.workspaces enable row level security;
create policy member_read on public.workspaces for select to authenticated using(private.workspace_role(id) is not null);
alter table public.workspace_members enable row level security;
create policy member_read on public.workspace_members for select to authenticated using(private.workspace_role(workspace_id) is not null);
alter table public.agent_definitions enable row level security;
create policy authenticated_read on public.agent_definitions for select to authenticated using((select auth.uid()) is not null);

do $$ declare t text; begin
 foreach t in array array['projects','agents','missions','tasks','approvals','runs','artifacts','activity_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy member_read on public.%I for select to authenticated using (private.workspace_role(workspace_id) is not null)',t);
  execute format('create index %I on public.%I(workspace_id)',t||'_workspace',t);
 end loop;
end $$;
-- Mutation is RPC-only. This blocks forged statuses, approvals, ownership and audit records.
revoke all on public.workspaces, public.workspace_members, public.agent_definitions, public.projects, public.agents, public.missions, public.tasks, public.approvals, public.runs, public.artifacts, public.activity_events from anon, authenticated;
grant select on public.workspaces, public.workspace_members, public.agent_definitions, public.projects, public.agents, public.missions, public.tasks, public.approvals, public.runs, public.artifacts, public.activity_events to authenticated;

create function private.create_workspace(workspace_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare wid uuid; uid uuid := auth.uid(); begin
 if uid is null then raise exception 'Authentication required'; end if;
 insert into public.workspaces(name,created_by) values(btrim(workspace_name),uid) returning id into wid;
 insert into public.workspace_members values(wid,uid,'owner');
 insert into public.agents(workspace_id,definition_key) select wid,key from public.agent_definitions;
 return wid;
end $$;
create function private.create_mission(wid uuid, mission_title text, mission_objective text, mission_kind text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare mid uuid; begin
 if auth.uid() is null or private.workspace_role(wid) is null then raise exception 'Workspace access denied'; end if;
 insert into public.missions(workspace_id,title,objective,kind,created_by)
 values(wid,btrim(mission_title),btrim(mission_objective),mission_kind,auth.uid()) returning id into mid;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event) values(wid,mid,auth.uid(),'mission.created');
 return mid;
end $$;
create function private.transition_mission(mid uuid, requested_action text) returns text
language plpgsql security definer set search_path = '' as $$
declare m public.missions; a public.approvals; new_status text; rid uuid; member_role text; begin
 select * into m from public.missions where id=mid for update;
 if not found then raise exception 'Mission not found'; end if;
 member_role := private.workspace_role(m.workspace_id);
 if auth.uid() is null or member_role is null then raise exception 'Workspace access denied'; end if;
 if requested_action in ('approve','reject') and member_role<>'owner' then raise exception 'Only workspace owners can decide approvals'; end if;
 new_status := case
 when m.status='draft' and requested_action='submit' then 'awaiting_approval'
 when m.status='awaiting_approval' and requested_action='approve' then 'approved'
 when m.status='awaiting_approval' and requested_action='reject' then 'cancelled'
 when m.status='approved' and requested_action='start' then 'running'
 when m.status='running' and requested_action='complete' then 'completed'
 when m.status='running' and requested_action='fail' then 'failed'
 when m.status in ('draft','awaiting_approval','approved') and requested_action='cancel' then 'cancelled'
 else null end;
 if new_status is null then raise exception 'Invalid transition: % -> %',m.status,requested_action; end if;
 if requested_action='submit' then
  insert into public.approvals(workspace_id,mission_id) values(m.workspace_id,mid);
 end if;
 if requested_action in ('approve','reject') then
  update public.approvals set status=case when requested_action='approve' then 'approved' else 'rejected' end,
   decided_by=auth.uid(),decided_at=now() where mission_id=mid and status='pending';
  if not found then raise exception 'Pending approval required'; end if;
 end if;
 if requested_action='start' then
  select * into a from public.approvals where mission_id=mid and workspace_id=m.workspace_id and status='approved' and scope='mock_run';
  if not found then raise exception 'Approved permission required'; end if;
  insert into public.runs(workspace_id,mission_id,approval_id,status) values(m.workspace_id,mid,a.id,'running');
 end if;
 if requested_action in ('complete','fail') then
  update public.runs set status=case when requested_action='complete' then 'completed' else 'failed' end,ended_at=now()
   where mission_id=mid and workspace_id=m.workspace_id and status='running' and adapter='mock' returning id into rid;
  if rid is null then raise exception 'Running mock execution required'; end if;
  if requested_action='complete' then
   insert into public.artifacts(workspace_id,mission_id,run_id,content)
    values(m.workspace_id,mid,rid,'{"adapter":"mock","summary":"Mock lifecycle completed. No agent work or external actions were performed."}'::jsonb);
  end if;
 end if;
 update public.missions set status=new_status where id=mid;
 insert into public.activity_events(workspace_id,mission_id,actor_id,event) values(m.workspace_id,mid,auth.uid(),'mock.'||requested_action);
 return new_status;
end $$;

-- Exposed wrappers remain SECURITY INVOKER; privileged functions stay in the unexposed private schema.
create function public.create_workspace(workspace_name text) returns uuid language sql security invoker set search_path='' as $$ select private.create_workspace(workspace_name) $$;
create function public.create_mission(wid uuid, mission_title text, mission_objective text, mission_kind text) returns uuid language sql security invoker set search_path='' as $$ select private.create_mission(wid,mission_title,mission_objective,mission_kind) $$;
create function public.transition_mission(mid uuid, requested_action text) returns text language sql security invoker set search_path='' as $$ select private.transition_mission(mid,requested_action) $$;
revoke all on function private.create_workspace(text), private.create_mission(uuid,text,text,text), private.transition_mission(uuid,text), public.create_workspace(text), public.create_mission(uuid,text,text,text), public.transition_mission(uuid,text) from public, anon;
grant execute on function private.create_workspace(text), private.create_mission(uuid,text,text,text), private.transition_mission(uuid,text), public.create_workspace(text), public.create_mission(uuid,text,text,text), public.transition_mission(uuid,text) to authenticated;
