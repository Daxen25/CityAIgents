import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const owner = "11111111-1111-4111-8111-111111111111", member = "22222222-2222-4222-8222-222222222222", outsider = "33333333-3333-4333-8333-333333333333";
const hash = "a".repeat(64);
const plan = { summary: "Human-reviewed work only", tasks: [
  { title: "Research proposal", suggested_agent_role: "researcher", expected_deliverable: "Evidence" },
  { title: "Developer proposal", suggested_agent_role: "developer", expected_deliverable: "Design" },
  { title: "Review proposal", suggested_agent_role: "chief-of-staff", expected_deliverable: "Review" },
], risks: ["Execution not authorized"] };

test("M1.3 owner review, scoped assignments, immutable decisions and execution boundary", async (t) => {
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
      alter default privileges grant execute on functions to anon, authenticated;
      alter default privileges grant all on tables to anon, authenticated;`);
    const migration = "20261022090000_task_plan_review.sql";
    for (const file of readdirSync("supabase/migrations").sort().filter((name) => name < migration))
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
    await db.query("insert into auth.users values($1),($2),($3)", [owner,member,outsider]);
    async function asUser(id = owner, role = "authenticated") {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
      await db.exec(`set role ${role}`);
    }
    async function scalar<T = string>(sql: string, params: unknown[] = []): Promise<T> {
      return Object.values((await db.query<Record<string,T>>(sql, params)).rows[0])[0];
    }
    await asUser();
    const wid = await scalar("select public.create_workspace('Orchestration tests')");
    await db.exec("reset role");
    await db.query("insert into public.workspace_members values($1,$2,'member')", [wid,member]);
    await asUser();
    type Proposal = { mid: string; rid: string; ids: string[] };
    async function createPlan(workspace = wid): Promise<Proposal> {
      const mid = await scalar("select public.create_mission($1,'Review mission','Approve supervised proposals only','business')", [workspace]);
      const claim = await scalar<{runId: string}>("select public.begin_chief_plan($1,$2,'fixture','gemini')", [mid,hash]);
      await asUser("", "service_role");
      await db.query("select public.finish_chief_plan($1,$2,$3::jsonb,null)", [claim.runId,hash,JSON.stringify(plan)]);
      await asUser();
      const ids = (await db.query<{id: string}>("select id from public.tasks where mission_id=$1 order by proposal_position", [mid])).rows.map((r) => r.id);
      return { mid, rid: claim.runId, ids };
    }
    const existing = await createPlan();
    await db.exec("reset role; begin");
    await db.exec(readFileSync(`supabase/migrations/${migration}`, "utf8"));
    await db.exec("commit");
    await asUser();
    const review = (p: Proposal, ids = [p.ids[0]], decision = "approved", request = randomUUID(), confirmed: boolean | null = true) =>
      scalar("select public.review_task_plan($1,$2,$3::uuid[],$4,$5,$6)", [p.mid,p.rid,ids,decision,confirmed,request]);
    await t.test("populated M1.2 proposals and completed runs survive additive migration", async () => {
      assert.equal(await scalar<number>("select count(*)::int from public.tasks where mission_id=$1 and status='proposed' and review_id is null", [existing.mid]), 3);
      assert.equal(await scalar("select status from public.runs where id=$1", [existing.rid]), "completed");
    });
    await t.test("owner confirmation, nonempty approval and exact task selection are required", async () => {
      for (const confirmed of [false,null]) await assert.rejects(review(existing, [existing.ids[0]], "approved", randomUUID(), confirmed), /confirmation/);
      await assert.rejects(review(existing, []), /requires accepted tasks/);
      await assert.rejects(review(existing, [existing.ids[0]], "rejected"), /rejection accepts none/);
      await assert.rejects(review(existing, [existing.ids[0],existing.ids[0]]), /Invalid task selection/);
      await assert.rejects(review(existing, [randomUUID()]), /outside this plan/);
      await assert.rejects(review(existing, [existing.ids[0]], "running"), /Invalid review request/);
      assert.equal(await scalar<number>("select count(*)::int from public.task_plan_reviews"), 0);
    });
    await t.test("member, outsider, missing identity and anon cannot approve", async () => {
      for (const id of [member,outsider,""]) {
        await asUser(id); await assert.rejects(review(existing), /owner authorization/);
      }
      await asUser("", "anon");
      await assert.rejects(review(existing), /permission denied/);
      await asUser();
    });
    let reviewId: string;
    const requestId = randomUUID();
    await t.test("owner atomically approves selected tasks and audits retained rejections", async () => {
      reviewId = await review(existing, [existing.ids[0],existing.ids[2]], "approved", requestId);
      const rows = (await db.query<{id: string; status: string; agent_id: string | null; definition_key: string | null; plan_run_id: string; review_id: string}>(`select t.id,t.status,t.agent_id,a.definition_key,t.plan_run_id,t.review_id from public.tasks t left join public.agents a on a.id=t.agent_id where t.mission_id=$1 order by t.proposal_position`, [existing.mid])).rows;
      assert.deepEqual(rows.map((r) => r.status), ["approved","rejected","approved"]);
      assert.deepEqual(rows.map((r) => r.definition_key), ["researcher",null,"chief-of-staff"]);
      assert.ok(rows.every((r) => r.review_id === reviewId && r.plan_run_id === existing.rid));
      assert.equal(rows[1].agent_id, null);
      assert.equal(await scalar("select decided_by from public.task_plan_reviews where id=$1", [reviewId]), owner);
      assert.ok(await scalar("select decided_at from public.task_plan_reviews where id=$1", [reviewId]));
      assert.equal(await scalar<number>("select jsonb_array_length(decision_snapshot) from public.task_plan_reviews where id=$1", [reviewId]), 3);
      assert.equal(await scalar("select status from public.missions where id=$1", [existing.mid]), "approved");
      assert.equal(await scalar("select scope from public.approvals where mission_id=$1", [existing.mid]), "chief_of_staff_plan");
      assert.equal(await scalar<number>("select count(*)::int from public.agents where workspace_id=$1 and enabled", [wid]), 0);
      assert.equal(await scalar<number>("select count(*)::int from public.activity_events where mission_id=$1 and (event like 'task.%' or event='plan.review.approved') and actor_id=$2", [existing.mid,owner]), 4);
    });
    await t.test("identical submission is idempotent; changed content/new requests cannot reassign", async () => {
      assert.equal(await review(existing, [existing.ids[2],existing.ids[0]], "approved", requestId), reviewId!);
      await assert.rejects(review(existing, [existing.ids[1]], "approved", requestId), /already reviewed/);
      await assert.rejects(review(existing), /already reviewed/);
      assert.equal(await scalar<number>("select count(*)::int from public.task_plan_reviews where mission_id=$1", [existing.mid]), 1);
      assert.equal(await scalar<number>("select count(*)::int from public.activity_events where mission_id=$1 and event like 'plan.review.%'", [existing.mid]), 1);
      const other = await createPlan();
      await assert.rejects(review(other, [other.ids[0]], "approved", requestId), /request already used/);
    });
    await t.test("RLS and direct grants prevent cross-workspace reads, audit forgery and reassignment", async () => {
      await asUser(member);
      assert.equal(await scalar<number>("select count(*)::int from public.task_plan_reviews where id=$1", [reviewId!]), 1);
      await assert.rejects(review(existing, [existing.ids[0],existing.ids[2]], "approved", requestId), /owner authorization/);
      for (const table of ["task_plan_reviews","tasks"])
        await assert.rejects(db.exec(`delete from public.${table}`), /permission denied/);
      await assert.rejects(db.query("update public.tasks set agent_id=null where id=$1", [existing.ids[0]]), /permission denied/);
      await asUser(outsider);
      assert.equal(await scalar<number>("select count(*)::int from public.task_plan_reviews where id=$1", [reviewId!]), 0);
      assert.equal(await scalar<number>("select count(*)::int from public.tasks where mission_id=$1", [existing.mid]), 0);
      await asUser();
      assert.equal(await scalar<boolean>("select has_function_privilege('anon','public.review_task_plan(uuid,uuid,uuid[],text,boolean,uuid)','execute')"), false);
      assert.equal(await scalar<boolean>("select has_function_privilege('anon','private.review_task_plan(uuid,uuid,uuid[],text,boolean,uuid)','execute')"), false);
      assert.equal(await scalar<boolean>("select has_function_privilege('authenticated','public.finish_chief_plan(uuid,text,jsonb,text)','execute')"), false);
    });
    await t.test("run and task references cannot be reused across missions/workspaces", async () => {
      const p = await createPlan();
      const otherWid = await scalar("select public.create_workspace('Other scoped workspace')");
      const other = await createPlan(otherWid);
      await assert.rejects(review(p, [other.ids[0]]), /outside this plan/);
      await assert.rejects(review({ ...p, rid: other.rid }), /Completed planning run/);
      assert.equal(await scalar<number>("select count(*)::int from public.task_plan_reviews where mission_id=$1", [p.mid]), 0);
    });
    await t.test("rejecting a plan retains every task with no assignments or execution", async () => {
      const p = await createPlan();
      await review(p, [], "rejected");
      assert.equal(await scalar<number>("select count(*)::int from public.tasks where mission_id=$1 and status='rejected' and agent_id is null", [p.mid]), 3);
      assert.equal(await scalar("select status from public.missions where id=$1", [p.mid]), "cancelled");
      await assert.rejects(review(p), /already reviewed/);
    });
    await t.test("assignments require a known agent in this workspace; corrupted suggestions cannot pass", async () => {
      const otherWid = await scalar("select public.create_workspace('Missing workspace agent')");
      const p = await createPlan(otherWid);
      await db.exec("reset role");
      await db.query("delete from public.agents where workspace_id=$1 and definition_key='researcher'", [otherWid]);
      await asUser(); await assert.rejects(review(p), /Known workspace agent/);
      await db.exec("reset role");
      await db.query("update public.tasks set suggested_agent_role='developer' where id=$1", [p.ids[0]]);
      await asUser(); await assert.rejects(review(p), /task set mismatch/);
      assert.equal(await scalar<number>("select count(*)::int from public.task_plan_reviews where mission_id=$1", [p.mid]), 0);
    });
    await t.test("late audit failure rolls back review, assignments, task decisions and mission status", async () => {
      const p = await createPlan();
      const before = await scalar<number>("select count(*)::int from public.activity_events where mission_id=$1", [p.mid]);
      await db.exec("reset role; alter table public.activity_events add constraint offline_review_failure check (event not like 'plan.review.%') not valid");
      try {
        await asUser(); await assert.rejects(review(p), /offline_review_failure/);
        assert.equal(await scalar<number>("select count(*)::int from public.task_plan_reviews where mission_id=$1", [p.mid]), 0);
        assert.equal(await scalar<number>("select count(*)::int from public.tasks where mission_id=$1 and status='proposed' and review_id is null and agent_id is null", [p.mid]), 3);
        assert.equal(await scalar("select status from public.missions where id=$1", [p.mid]), "awaiting_approval");
        assert.equal(await scalar<number>("select count(*)::int from public.activity_events where mission_id=$1", [p.mid]), before);
      } finally { await db.exec("reset role; alter table public.activity_events drop constraint offline_review_failure"); await asUser(); }
    });
    await t.test("concurrent competing requests produce exactly one terminal review", async () => {
      const p = await createPlan();
      const results = await Promise.allSettled([review(p),review(p, [], "rejected")]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      assert.equal(await scalar<number>("select count(*)::int from public.task_plan_reviews where mission_id=$1", [p.mid]), 1);
      assert.equal(await scalar<number>("select count(*)::int from public.activity_events where mission_id=$1 and event like 'plan.review.%'", [p.mid]), 1);
    });
    await t.test("concurrent identical requests return the same review without duplicate audit", async () => {
      const p = await createPlan(); const request = randomUUID();
      const results = await Promise.all([review(p, [p.ids[0]], "approved", request),review(p, [p.ids[0]], "approved", request)]);
      assert.equal(results[0],results[1]);
      assert.equal(await scalar<number>("select count(*)::int from public.activity_events where mission_id=$1 and event like 'plan.review.%'", [p.mid]), 1);
    });
    await t.test("reviewed tasks cannot become running/completed; mock lifecycle stays separate", async () => {
      await db.exec("reset role");
      for (const status of ["running","completed"])
        await assert.rejects(db.query("update public.tasks set status=$1 where id=$2", [status,existing.ids[0]]), /proposal_is_non_executable/);
      await asUser(); await assert.rejects(db.query("select public.transition_mission($1,'start')", [existing.mid]), /cannot use mock/);
      const mid = await scalar("select public.create_mission($1,'Mock mission','Preserve the existing mock lifecycle','personal')", [wid]);
      await assert.rejects(review({ mid,rid:existing.rid,ids:existing.ids }), /not awaiting review/);
      for (const action of ["submit","approve","start","complete"])
        await db.query("select public.transition_mission($1,$2)", [mid,action]);
      assert.equal(await scalar("select status from public.missions where id=$1", [mid]), "completed");
    });
  } finally { await db.close(); }
});
