import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const owner = "11111111-1111-4111-8111-111111111111",
  outsider = "33333333-3333-4333-8333-333333333333",
  member = "44444444-4444-4444-8444-444444444444";
test("Postgres migrations, workspace RLS, approval gate and atomic lifecycle", async (t) => {
  const db = new PGlite();
  await db.exec(
    `create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated; create schema storage; create table storage.buckets(id text primary key,name text,public boolean); create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text); alter table storage.objects enable row level security; grant usage on schema storage to authenticated; grant select on storage.objects to authenticated; create function storage.foldername(text) returns text[] language sql immutable as $$ select (string_to_array($1,'/'))[1:array_length(string_to_array($1,'/'),1)-1] $$;`,
  );
  // Model direct Supabase-style grants, which PUBLIC-only revocation cannot remove.
  await db.exec(
    "alter default privileges grant execute on functions to anon, authenticated",
  );
  for (const name of readdirSync("supabase/migrations").sort())
    await db.exec(readFileSync(`supabase/migrations/${name}`, "utf8"));
  await t.test(
    "explicit function ACLs deny anon even with direct default grants",
    async () => {
      const result = await db.query<{
        schema_name: string;
        function_name: string;
        anon_execute: boolean;
        authenticated_execute: boolean;
      }>(`
      select n.nspname as schema_name,p.proname as function_name,
        has_function_privilege('anon',p.oid,'execute') as anon_execute,
        has_function_privilege('authenticated',p.oid,'execute') as authenticated_execute
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','private')
        and p.proname in ('workspace_role','create_workspace','create_mission','transition_mission')
    `);
      assert.equal(result.rows.length, 7);
      for (const row of result.rows) {
        assert.equal(
          row.anon_execute,
          false,
          `${row.schema_name}.${row.function_name}`,
        );
        assert.equal(
          row.authenticated_execute,
          true,
          `${row.schema_name}.${row.function_name}`,
        );
      }
    },
  );
  await db.query("insert into auth.users values ($1),($2),($3)", [
    owner,
    outsider,
    member,
  ]);
  async function asUser(id: string) {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    await db.exec("set role authenticated");
  }
  async function scalar(sql: string, params: unknown[] = []) {
    const r = await db.query<Record<string, unknown>>(sql, params);
    return Object.values(r.rows[0])[0];
  }
  await asUser(owner);
  const wid = (await scalar(
    "select public.create_workspace('Test workspace')",
  )) as string;
  const mid = (await scalar(
    "select public.create_mission($1,'Test mission','A complete test objective','business')",
    [wid],
  )) as string;
  await t.test("templates and disabled workspace agents seeded", async () => {
    assert.equal(
      await scalar("select count(*)::int from public.agent_definitions"),
      3,
    );
    assert.equal(
      await scalar(
        "select count(*)::int from public.agents where enabled=false",
      ),
      3,
    );
  });
  await t.test(
    "direct status, membership and audit forgery denied",
    async () => {
      await assert.rejects(
        db.query("update public.missions set status='completed' where id=$1", [
          mid,
        ]),
        /permission denied/,
      );
      await assert.rejects(
        db.query("insert into public.workspace_members values($1,$2,'owner')", [
          wid,
          outsider,
        ]),
        /permission denied/,
      );
      await assert.rejects(
        db.query(
          "insert into public.activity_events(workspace_id,mission_id,actor_id,event) values($1,$2,$3,'fake')",
          [wid, mid, owner],
        ),
        /permission denied/,
      );
    },
  );
  await t.test("outsider cannot read or mutate another workspace", async () => {
    await asUser(outsider);
    for (const table of [
      "workspaces",
      "workspace_members",
      "agents",
      "missions",
      "approvals",
      "runs",
      "tasks",
      "projects",
      "artifacts",
      "activity_events",
    ])
      assert.equal(
        await scalar(`select count(*)::int from public.${table}`),
        0,
        table,
      );
    await assert.rejects(
      db.query(
        "select public.create_mission($1,'Intrusion','An unauthorized objective','personal')",
        [wid],
      ),
      /access denied/,
    );
    await assert.rejects(
      db.query("select public.transition_mission($1,'submit')", [mid]),
      /access denied/,
    );
  });
  await asUser(owner);
  await t.test("start before approval denied", async () => {
    await assert.rejects(
      db.query("select public.transition_mission($1,'start')", [mid]),
      /Invalid transition/,
    );
    assert.equal(
      await scalar("select public.transition_mission($1,'submit')", [mid]),
      "awaiting_approval",
    );
    await assert.rejects(
      db.query("select public.transition_mission($1,'start')", [mid]),
      /Invalid transition/,
    );
  });
  await db.exec("reset role");
  await db.query(
    "insert into public.workspace_members values($1,$2,'member')",
    [wid, member],
  );
  await t.test("member reads but cannot approve or reject", async () => {
    await asUser(member);
    assert.equal(await scalar("select count(*)::int from public.missions"), 1);
    for (const a of ["approve", "reject"])
      await assert.rejects(
        db.query("select public.transition_mission($1,$2)", [mid, a]),
        /Only workspace owners/,
      );
  });
  await asUser(owner);
  await t.test(
    "approved lifecycle produces one labeled mock run and artifact",
    async () => {
      for (const [a, s] of [
        ["approve", "approved"],
        ["start", "running"],
        ["complete", "completed"],
      ])
        assert.equal(
          await scalar("select public.transition_mission($1,$2)", [mid, a]),
          s,
        );
      assert.equal(
        await scalar(
          "select count(*)::int from public.runs where status='completed' and adapter='mock'",
        ),
        1,
      );
      assert.equal(
        await scalar("select content->>'adapter' from public.artifacts"),
        "mock",
      );
      assert.equal(
        await scalar("select count(*)::int from public.activity_events"),
        5,
      );
      await assert.rejects(
        db.query("select public.transition_mission($1,'start')", [mid]),
        /Invalid transition/,
      );
    },
  );
  await t.test(
    "approval independently required even if mission state is corrupted",
    async () => {
      const other = await scalar(
        "select public.create_mission($1,'Forged state','Internal corruption test','personal')",
        [wid],
      );
      await db.exec("reset role");
      await db.query(
        "update public.missions set status='approved' where id=$1",
        [other],
      );
      await asUser(owner);
      await assert.rejects(
        db.query("select public.transition_mission($1,'start')", [other]),
        /Approved permission required/,
      );
    },
  );
  await t.test("cross-workspace foreign keys rejected", async () => {
    await asUser(outsider);
    const otherWid = await scalar(
      "select public.create_workspace('Other workspace')",
    );
    await db.exec("reset role");
    await assert.rejects(
      db.query(
        "insert into public.tasks(workspace_id,mission_id,title) values($1,$2,'Cross tenant')",
        [otherWid, mid],
      ),
      /foreign key/,
    );
  });
  await t.test(
    "private storage workspace reads only, no client uploads",
    async () => {
      await db.exec("reset role");
      await db.query(
        "insert into storage.objects(bucket_id,name) values('artifacts',$1)",
        [`${wid}/test.json`],
      );
      await asUser(owner);
      assert.equal(
        await scalar("select count(*)::int from storage.objects"),
        1,
      );
      await assert.rejects(
        db.query(
          "insert into storage.objects(bucket_id,name) values('artifacts','fake')",
        ),
        /permission denied/,
      );
      await asUser(outsider);
      assert.equal(
        await scalar("select count(*)::int from storage.objects"),
        0,
      );
    },
  );
  await t.test("anonymous access and RPC execution denied", async () => {
    await db.exec(
      "reset role; select set_config('request.jwt.claim.sub','',false); set role anon",
    );
    await assert.rejects(
      db.query("select * from public.missions"),
      /permission denied/,
    );
    await assert.rejects(
      db.query("select public.create_workspace('Anonymous')"),
      /permission denied/,
    );
  });
  await db.close();
});
