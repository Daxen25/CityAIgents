import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { executePlanning, planningConfig, type PlanningDependencies } from "../apps/web/lib/planning-engine";
import type { Plan } from "@agent-city/core";
const owner = "11111111-1111-4111-8111-111111111111", member = "22222222-2222-4222-8222-222222222222", outsider = "33333333-3333-4333-8333-333333333333";
const hash = "a".repeat(64);
const plan: Plan = { summary: "Human review required", tasks: [
  { title: "First proposal", suggested_agent_role: "researcher", expected_deliverable: "Evidence summary" },
  { title: "Second proposal", suggested_agent_role: "developer", expected_deliverable: "Reviewed design" },
], risks: ["Scope needs review"] };

test("M1.1 PostgreSQL authorization, atomic persistence, retries and isolation", async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean);
      create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
      alter table storage.objects enable row level security; grant usage on schema storage to authenticated; grant select on storage.objects to authenticated;
      create function storage.foldername(text) returns text[] language sql immutable as $$ select (string_to_array($1,'/'))[1:array_length(string_to_array($1,'/'),1)-1] $$;
      alter default privileges grant execute on functions to anon, authenticated;`);
    const migration = "supabase/migrations/20261021140000_multi_provider_planning.sql";
    for (const file of readdirSync("supabase/migrations").sort().filter((name) => name < "20261021140000_multi_provider_planning.sql"))
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
    await t.test("populated M1.1 upgrade preserves an in-flight OpenAI run and its finalizer", async () => {
      await db.exec("begin");
      try {
        await db.query("insert into auth.users values($1)", [owner]);
        await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
        await db.exec("set local role authenticated");
        const wid = (await db.query<{id: string}>("select public.create_workspace('Before M1.2') as id")).rows[0].id;
        const mid = (await db.query<{id: string}>("select public.create_mission($1,'Existing AI mission','Preserve a live planning lease','business') as id", [wid])).rows[0].id;
        const claim = (await db.query<{claim: {runId: string}}>("select public.begin_chief_plan($1,$2,'gpt-4.1-mini') as claim", [mid, hash])).rows[0].claim;
        await db.exec("reset role");
        await db.exec(readFileSync(migration, "utf8"));
        await db.exec("set local role service_role");
        await db.query("select public.finish_chief_plan($1,$2,$3::jsonb,null)", [claim.runId, hash, JSON.stringify(plan)]);
        await db.exec("reset role");
        assert.equal((await db.query<{status: string}>("select status from public.runs where id=$1", [claim.runId])).rows[0].status, "completed");
      } finally { await db.exec("rollback"); }
    });
    await db.exec(readFileSync(migration, "utf8"));
    for (const file of readdirSync("supabase/migrations").sort().filter((name) => name > "20261021140000_multi_provider_planning.sql"))
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
    await db.query("insert into auth.users values($1),($2),($3)", [owner, member, outsider]);
    async function asUser(id = owner, role = "authenticated") {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
      await db.exec(`set role ${role}`);
    }
    async function scalar<T = string>(sql: string, params: unknown[] = []): Promise<T> {
      const result = await db.query<Record<string, T>>(sql, params);
      return Object.values(result.rows[0])[0];
    }
    await asUser();
    const wid = await scalar("select public.create_workspace('Planning tests')");
    await db.exec("reset role");
    await db.query("insert into public.workspace_members values($1,$2,'member')", [wid, member]);
    await asUser();
    const mission = () => scalar("select public.create_mission($1,'Planning mission','Produce a supervised reviewable plan','business')", [wid]);
    const begin = (mid: string) => scalar<{runId: string; title: string; objective: string}>("select public.begin_chief_plan($1,$2,'gpt-4.1-mini')", [mid, hash]);
    async function finish(rid: string, content: unknown = plan, error: string | null = null, capability = hash) {
      await asUser("", "service_role");
      await db.query("select public.finish_chief_plan($1,$2,$3::jsonb,$4)", [rid, capability, content === null ? null : JSON.stringify(content), error]);
    }
    const mid = await mission();
    await t.test("anonymous, nonmember and member cannot authorize planning", async () => {
      for (const uid of ["", outsider, member]) {
        await asUser(uid);
        await assert.rejects(begin(mid), /owner authorization/);
      }
      await asUser("", "anon");
      await assert.rejects(begin(mid), /permission denied/);
      await asUser();
      assert.equal(await scalar<number>("select count(*)::int from public.runs"), 0);
    });
    let rid: string;
    await t.test("owner claim binds approval, model, actor and lease atomically", async () => {
      rid = (await begin(mid)).runId;
      assert.equal(await scalar("select execution_mode from public.missions where id=$1", [mid]), "chief_of_staff");
      const result = await db.query("select scope,status,decided_by from public.approvals where mission_id=$1", [mid]);
      assert.deepEqual(result.rows[0], { scope: "chief_of_staff_plan", status: "approved", decided_by: owner });
      assert.equal(await scalar("select requested_by from public.runs where id=$1", [rid]), owner);
    });
    await t.test("duplicate starts and mock transitions cannot touch an AI mission", async () => {
      await assert.rejects(begin(mid), /not eligible/);
      for (const action of ["submit", "approve", "reject", "start", "complete", "fail", "cancel"])
        await assert.rejects(db.query("select public.transition_mission($1,$2)", [mid, action]), /cannot use mock/);
      await assert.rejects(db.query("select private.transition_mock_mission($1,'complete')", [mid]), /permission denied/);
      assert.equal(await scalar<number>("select count(*)::int from public.runs where mission_id=$1", [mid]), 1);
    });
    await t.test("client finalization and direct table forgery are denied", async () => {
      await assert.rejects(db.query("select public.finish_chief_plan($1,$2,$3::jsonb,null)", [rid!, hash, JSON.stringify(plan)]), /permission denied/);
      for (const table of ["missions", "runs", "approvals", "tasks", "artifacts"])
        await assert.rejects(db.exec(`delete from public.${table}`), /permission denied/);
      const acl = await db.query<{proname: string; client: boolean; anon: boolean}>(`select p.proname,has_function_privilege('authenticated',p.oid,'execute') as client,has_function_privilege('anon',p.oid,'execute') as anon from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname in ('finish_chief_plan','validate_chief_plan','transition_mock_mission')`);
      assert.equal(acl.rows.length, 4);
      for (const row of acl.rows) { assert.equal(row.client, false, row.proname); assert.equal(row.anon, false, row.proname); }
    });
    await t.test("capability mismatch and invalid plan cannot partially persist", async () => {
      await assert.rejects(finish(rid!, plan, null, "b".repeat(64)), /lease/);
      for (const bad of [
        { ...plan, summary: "" }, { ...plan, tasks: [] }, { ...plan, tasks: Array(13).fill(plan.tasks[0]) },
        { ...plan, risks: Array(11).fill("risk") }, { ...plan, extra: true },
        { ...plan, tasks: [{ ...plan.tasks[0], suggested_agent_role: null }] },
        { ...plan, tasks: [{ ...plan.tasks[0], expected_deliverable: "" }] },
        { ...plan, risks: [null] },
      ]) await assert.rejects(finish(rid!, bad), /Invalid/);
      await asUser();
      assert.equal(await scalar<number>("select count(*)::int from public.artifacts"), 0);
      assert.equal(await scalar<number>("select count(*)::int from public.tasks"), 0);
      assert.equal(await scalar("select status from public.runs where id=$1", [rid!]), "running");
    });
    await t.test("finalization atomically persists ordered non-executable proposals and artifact", async () => {
      await finish(rid!);
      await assert.rejects(finish(rid!), /lease/);
      await asUser();
      assert.deepEqual(await scalar("select content from public.artifacts where run_id=$1", [rid!]), plan);
      const tasks = await db.query("select title,status,agent_id,proposal_position from public.tasks order by proposal_position");
      assert.deepEqual(tasks.rows, plan.tasks.map((task, i) => ({ title: task.title, status: "proposed", agent_id: null, proposal_position: i+1 })));
      assert.equal(await scalar("select status from public.missions where id=$1", [mid]), "awaiting_approval");
      assert.equal(await scalar("select actor_id from public.activity_events where event='chief_of_staff.plan_review_required'"), owner);
      await assert.rejects(begin(mid), /not eligible/);
      await assert.rejects(db.query("select public.transition_mission($1,'approve')", [mid]), /cannot use mock/);
    });
    await t.test("workspace RLS hides plans, tasks and runs from outsiders", async () => {
      await asUser(outsider);
      for (const table of ["tasks", "runs", "artifacts", "approvals", "missions", "activity_events"])
        assert.equal(await scalar<number>(`select count(*)::int from public.${table}`), 0, table);
      await asUser(member);
      assert.equal(await scalar<number>("select count(*)::int from public.tasks"), 2);
      await asUser();
    });
    await t.test("mock approval is not AI authorization and mock remains usable", async () => {
      const mock = await mission();
      await db.query("select public.transition_mission($1,'submit')", [mock]);
      await db.query("select public.transition_mission($1,'approve')", [mock]);
      await assert.rejects(begin(mock), /not eligible/);
      await db.query("select public.transition_mission($1,'start')", [mock]);
      await db.query("select public.transition_mission($1,'complete')", [mock]);
      assert.equal(await scalar("select adapter from public.runs where mission_id=$1", [mock]), "mock");
    });
    await t.test("timeout, invalid-output and provider failures consume a bounded total of 3 attempts", async () => {
      const retry = await mission();
      for (const code of ["timeout", "invalid_output", "provider_error"]) {
        const claim = await begin(retry);
        await finish(claim.runId, null, code);
        await asUser();
        assert.equal(await scalar("select status from public.missions where id=$1", [retry]), "failed");
      }
      await assert.rejects(begin(retry), /Maximum 3/);
      assert.equal(await scalar<number>("select count(*)::int from public.artifacts where mission_id=$1", [retry]), 0);
    });
    await t.test("interrupted runs require expiry, owner recovery and fresh authorization", async () => {
      const interrupted = await mission();
      const claim = await begin(interrupted);
      await assert.rejects(db.query("select public.recover_chief_plan($1)", [interrupted]), /not expired/);
      await asUser(member);
      await assert.rejects(db.query("select public.recover_chief_plan($1)", [interrupted]), /owner authorization/);
      await db.exec("reset role");
      await db.query("update public.runs set expires_at=clock_timestamp()-interval '1 second' where id=$1", [claim.runId]);
      await assert.rejects(finish(claim.runId), /expired/);
      await asUser();
      await db.query("select public.recover_chief_plan($1)", [interrupted]);
      await assert.rejects(finish(claim.runId), /lease/);
      await asUser();
      assert.equal(await scalar("select failure_code from public.runs where id=$1", [claim.runId]), "interrupted");
      const fresh = await begin(interrupted);
      assert.notEqual(fresh.runId, claim.runId);
      await finish(fresh.runId);
      await asUser();
    });
    await t.test("owner revocation after claim prevents finalization", async () => {
      const revoked = await mission();
      const claim = await begin(revoked);
      await db.exec("reset role");
      await db.query("update public.workspace_members set role='member' where workspace_id=$1 and user_id=$2", [wid, owner]);
      await assert.rejects(finish(claim.runId), /no longer valid/);
      await db.exec("reset role");
      await db.query("update public.workspace_members set role='owner' where workspace_id=$1 and user_id=$2", [wid, owner]);
      await asUser();
    });
    await t.test("Gemini uses the same owner/lease/finalizer protections and records provider metadata", async () => {
      await asUser();
      const gemini = await mission();
      await asUser(member);
      await assert.rejects(db.query("select public.begin_chief_plan($1,$2,'gemini-flash-latest','gemini')", [gemini, hash]), /owner authorization/);
      await asUser();
      await assert.rejects(db.query("select public.begin_chief_plan($1,$2,'fixture','invalid')", [gemini, hash]), /Invalid AI provider/);
      const claim = await scalar<{runId: string}>("select public.begin_chief_plan($1,$2,'gemini-flash-latest','gemini')", [gemini, hash]);
      assert.equal(await scalar("select adapter from public.runs where id=$1", [claim.runId]), "gemini");
      assert.equal(await scalar("select model from public.runs where id=$1", [claim.runId]), "gemini-flash-latest");
      await assert.rejects(db.query("select public.finish_chief_plan($1,$2,$3::jsonb,null)", [claim.runId, hash, JSON.stringify(plan)]), /permission denied/);
      await assert.rejects(db.query("select public.transition_mission($1,'complete')", [gemini]), /cannot use mock/);
      await assert.rejects(finish(claim.runId, plan, null, "b".repeat(64)), /lease/);
      await finish(claim.runId);
      await assert.rejects(finish(claim.runId), /lease/);
      await asUser();
      assert.equal(await scalar("select status from public.missions where id=$1", [gemini]), "awaiting_approval");
      assert.equal(await scalar<number>("select count(*)::int from public.tasks where plan_run_id=$1 and status='proposed'", [claim.runId]), 2);
    });
    await t.test("attempt budget is shared across Gemini and legacy OpenAI entry points", async () => {
      const mixed = await mission();
      for (const provider of ["gemini", "openai", "gemini"]) {
        const claim = await scalar<{runId: string}>("select public.begin_chief_plan($1,$2,'fixture',$3)", [mixed, hash, provider]);
        await finish(claim.runId, null, "provider_error"); await asUser();
      }
      await assert.rejects(begin(mixed), /Maximum 3/); // Legacy three-argument RPC cannot bypass the budget.
      await assert.rejects(db.query("select public.begin_chief_plan($1,$2,'fixture','gemini')", [mixed, hash]), /Maximum 3/);
    });
    await t.test("Gemini interrupted run recovery also fences stale finalizers", async () => {
      const interrupted = await mission();
      const claim = await scalar<{runId: string}>("select public.begin_chief_plan($1,$2,'fixture','gemini')", [interrupted, hash]);
      await assert.rejects(db.query("select public.recover_chief_plan($1)", [interrupted]), /not expired/);
      await db.exec("reset role");
      await db.query("update public.runs set expires_at=clock_timestamp()-interval '1 second' where id=$1", [claim.runId]);
      await asUser(); await db.query("select public.recover_chief_plan($1)", [interrupted]);
      await assert.rejects(finish(claim.runId), /lease/); await asUser();
      const next = await begin(interrupted); // Explicit provider switch only after recovery/consent.
      await finish(next.runId); await asUser();
    });
    await t.test("a finalizer constraint error rolls back artifacts/tasks and requires explicit expired-run recovery", async () => {
      const interrupted = await mission();
      const claim = await scalar<{runId: string}>("select public.begin_chief_plan($1,$2,'fixture','gemini')", [interrupted, hash]);
      await db.exec("reset role");
      await db.exec("alter table public.tasks add constraint offline_persistence_failure check (title <> 'Reject offline proposal')");
      const failingPlan = { ...plan, tasks: [{ ...plan.tasks[0], title: "Reject offline proposal" }] };
      try {
        await assert.rejects(finish(claim.runId, failingPlan), (error: Error & { code?: string }) => {
          assert.equal(error.code, "23514"); return true;
        });
        await asUser();
        assert.equal(await scalar<number>("select count(*)::int from public.artifacts where run_id=$1", [claim.runId]), 0);
        assert.equal(await scalar<number>("select count(*)::int from public.tasks where plan_run_id=$1", [claim.runId]), 0);
        assert.equal(await scalar("select status from public.runs where id=$1", [claim.runId]), "running");
        await assert.rejects(db.query("select public.recover_chief_plan($1)", [interrupted]), /not expired/);
        await db.exec("reset role");
        await db.query("update public.runs set expires_at=clock_timestamp()-interval '1 second' where id=$1", [claim.runId]);
        await asUser();
        await db.query("select public.recover_chief_plan($1)", [interrupted]);
        await assert.rejects(finish(claim.runId), /lease/);
        await asUser();
        const fresh = await begin(interrupted); // An explicitly authorized new attempt, not an automatic retry.
        await finish(fresh.runId);
        await asUser();
        assert.equal(await scalar<number>("select count(*)::int from public.artifacts where run_id=$1", [fresh.runId]), 1);
      } finally {
        await db.exec("reset role; alter table public.tasks drop constraint offline_persistence_failure");
        await asUser();
      }
    });
    await t.test("application orchestration and PostgreSQL combine to reject duplicate calls before provider", async () => {
      const integrated = await mission();
      let modelCalls = 0;
      const deps: PlanningDependencies = {
        config: () => planningConfig({ AGENT_CITY_AI_PROVIDER: "openai", AGENT_CITY_MODE: "supabase", AGENT_CITY_AI_PLANNING_ENABLED: "true", OPENAI_API_KEY: "fixture", SUPABASE_SERVICE_ROLE_KEY: "fixture" }),
        authenticate: async () => { await asUser(); },
        capability: () => ({ hash }),
        claim: async (id) => begin(id),
        generate: async () => { modelCalls++; await assert.rejects(begin(integrated)); return plan; },
        finish: async (rid, _hash, plan, error) => finish(rid, plan, error),
      };
      await executePlanning(integrated, true, deps);
      await assert.rejects(executePlanning(integrated, true, deps));
      assert.equal(modelCalls, 1);
    });
  } finally { await db.close(); }
});
