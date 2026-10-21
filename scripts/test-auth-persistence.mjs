// Integration fixture: real Next.js routes + Supabase SDK over loopback HTTP.
// Uses synthetic credentials and in-memory service data, NEVER the hosted project.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const planningTest = process.argv.includes("--planning");
const persistenceFailure = process.argv.includes("--persistence-failure");
const provider = process.argv.includes("--openai") ? "openai" : "gemini";
const planningModel = provider === "gemini" ? "gemini-flash-latest" : "gpt-4.1-mini";
const root = fileURLToPath(new URL("../", import.meta.url));
const uid = "11111111-1111-4111-8111-111111111111",
  wid = "22222222-2222-4222-8222-222222222222",
  mid = "33333333-3333-4333-8333-333333333333";
const user = {
  id: uid,
  aud: "authenticated",
  role: "authenticated",
  email: "fixture@example.test",
  email_confirmed_at: "2026-01-01T00:00:00Z",
  app_metadata: {},
  user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
};
const state = {
  workspaces: [],
  missions: [],
  approvals: [],
  workspace_members: [],
  activity_events: [],
};
const calls = [];
const planningMid = "55555555-5555-4555-8555-555555555555";
const planningRid = "66666666-6666-4666-8666-666666666666";
const offlinePlan = { summary: "Offline fixture plan", tasks: [{ title: "Review fixture evidence", suggested_agent_role: "researcher", expected_deliverable: "Human-reviewed fixture report" }], risks: ["Fixture evidence only"] };
let providerCalls = 0;
let planningHash;
if (planningTest) { state.artifacts = []; state.runs = []; }
let refreshes = 0,
  logouts = 0,
  serial = 0,
  activeToken = "";
const jwt = () =>
  `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: uid, role: "authenticated", aud: "authenticated", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, jti: String(++serial) })).toString("base64url")}.fixture-signature`;
function session() {
  activeToken = jwt();
  return {
    access_token: activeToken,
    refresh_token: "fixture-refresh-token",
    token_type: "bearer",
    expires_in: 3600,
    user,
  };
}
const fixture = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    let raw = "";
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ path: url.pathname, method: req.method, body });
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    if (url.pathname === "/auth/v1/token") {
      if (url.searchParams.get("grant_type") === "password") {
        if (
          body.email !== "fixture@example.test" ||
          body.password !== "fixture-password"
        )
          return send(400, {
            code: "invalid_credentials",
            msg: "Invalid login credentials",
          });
        return send(200, session());
      }
      assert.equal(url.searchParams.get("grant_type"), "refresh_token");
      assert.equal(body.refresh_token, "fixture-refresh-token");
      refreshes++;
      return send(200, session());
    }
    if (url.pathname === "/openai-fixture") {
      assert.ok(planningTest);
      assert.equal(provider, "openai");
      assert.equal(req.headers.authorization, "Bearer offline-openai-fixture");
      providerCalls++;
      assert.equal(body.model, "gpt-4.1-mini");
      assert.equal(body.response_format.type, "json_schema");
      assert.equal(body.tools, undefined);
      return send(200, { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(offlinePlan), refusal: null } }] });
    }
    if (url.pathname === "/gemini-fixture") {
      assert.ok(planningTest);
      assert.equal(provider, "gemini");
      assert.equal(req.headers["x-goog-api-key"], "offline-gemini-fixture");
      assert.equal(body.generationConfig.responseMimeType, "application/json");
      assert.equal(body.generationConfig.maxOutputTokens, 6000);
      assert.equal(body.tools, undefined);
      providerCalls++;
      return send(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(offlinePlan) }] } }] });
    }
    if (url.pathname === "/rest/v1/rpc/finish_chief_plan") {
      assert.ok(planningTest);
      assert.equal(req.headers.authorization, "Bearer sb_secret_m11_fixture");
      assert.deepEqual(body, { rid: planningRid, token_hash: planningHash, plan: offlinePlan, error_code: null });
      assert.ok(!Object.hasOwn(body, "actor_id"));
      if (persistenceFailure) return send(400, { code: "23514", message: "private-plan-sensitive-marker", details: planningHash, hint: "offline-gemini-fixture" });
      state.runs[0].status = "completed";
      state.missions.find((m) => m.id === planningMid).status = "awaiting_approval";
      state.artifacts.push({ id: "fixture-plan", mission_id: planningMid, kind: "chief_of_staff_plan", content: offlinePlan });
      return send(200, null);
    }
    if (req.headers.authorization !== `Bearer ${activeToken}` || !activeToken)
      return send(401, { code: "42501", message: "Authentication required" });
    if (url.pathname === "/auth/v1/user") return send(200, user);
    if (url.pathname === "/auth/v1/logout") {
      assert.equal(url.searchParams.get("scope"), "local");
      logouts++;
      activeToken = "";
      return send(204);
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const rpc = url.pathname.split("/").at(-1);
      if (rpc === "create_workspace") {
        assert.deepEqual(body, { workspace_name: "M0.4 fixture workspace" });
        state.workspaces.push({ id: wid, name: body.workspace_name });
        state.workspace_members.push({
          workspace_id: wid,
          user_id: uid,
          role: "owner",
        });
        return send(200, wid);
      }
      if (rpc === "create_mission") {
        assert.deepEqual(body, {
          wid,
          mission_title: "M0.4 fixture mission",
          mission_objective:
            "Verify transport and persistence with a local HTTP fixture only.",
          mission_kind: "personal",
        });
        state.missions.push({
          id: mid,
          workspace_id: wid,
          title: body.mission_title,
          objective: body.mission_objective,
          kind: body.mission_kind,
          status: "draft",
          created_by: uid,
          created_at: new Date().toISOString(),
        });
        return send(200, mid);
      }
      if (rpc === "begin_chief_plan") {
        assert.ok(planningTest);
        assert.deepEqual(Object.keys(body).sort(), ["mid", "selected_model", "selected_provider", "token_hash"]);
        assert.equal(body.mid, planningMid);
        assert.equal(body.selected_model, planningModel);
        assert.equal(body.selected_provider, provider);
        assert.match(body.token_hash, /^[a-f0-9]{64}$/);
        planningHash = body.token_hash;
        const m = state.missions.find((m) => m.id === planningMid);
        if (m.status !== "draft") return send(400, { message: "Mission not eligible for planning" });
        m.status = "running";
        m.execution_mode = "chief_of_staff";
        state.runs.push({ id: planningRid, mission_id: planningMid, status: "running", failure_code: null, expires_at: new Date(Date.now()+120000).toISOString() });
        return send(200, { runId: planningRid, title: m.title, objective: m.objective });
      }
      if (rpc === "recover_chief_plan") {
        assert.equal(body.mid, planningMid);
        if (Date.parse(state.runs[0].expires_at) > Date.now()) return send(400, { code: "P0001", message: "Planning lease has not expired" });
        state.runs[0].status = "failed";
        state.runs[0].failure_code = "interrupted";
        state.missions.find((m) => m.id === planningMid).status = "failed";
        return send(200, null);
      }
      assert.equal(rpc, "transition_mission");
      assert.equal(body.mid, mid);
      const statuses = {
        submit: "awaiting_approval",
        approve: "approved",
        start: "running",
        complete: "completed",
      };
      assert.ok(statuses[body.requested_action]);
      state.missions[0].status = statuses[body.requested_action];
      if (body.requested_action === "submit")
        state.approvals.push({
          id: "44444444-4444-4444-8444-444444444444",
          workspace_id: wid,
          mission_id: mid,
          status: "pending",
          decided_by: null,
        });
      if (body.requested_action === "approve")
        Object.assign(state.approvals[0], {
          status: "approved",
          decided_by: uid,
        });
      state.activity_events.push({
        id: String(calls.length),
        workspace_id: wid,
        mission_id: mid,
        actor_id: uid,
        event: `mock.${body.requested_action}`,
        created_at: new Date().toISOString(),
      });
      return send(200, state.missions[0].status);
    }
    assert.equal(req.method, "GET");
    const table = url.pathname.split("/").at(-1);
    if (table === "agent_definitions")
      return send(200, [
        {
          key: "chief-of-staff",
          version: 7,
          name: "Persisted fixture Chief",
          description:
            "Definition read from the isolated service, not a static template.",
        },
      ]);
    assert.ok(Object.hasOwn(state, table), "Unexpected table " + table);
    return send(200, state[table]);
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Fixture contract assertion failed" }));
  }
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const supabaseURL = `http://127.0.0.1:${fixture.address().port}`;
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((r) => reservation.close(r));
const base = `http://127.0.0.1:${port}`;
const jar = new Map();
const app = spawn(
  process.execPath,
  [
    ...(planningTest ? ["--import", root + "tests/fixtures/openai-offline.mjs"] : []),
    root + "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: root + "apps/web",
    env: {
      ...process.env,
      AGENT_CITY_MODE: "supabase",
      AGENT_CITY_AI_PLANNING_ENABLED: planningTest ? "true" : "false",
      AGENT_CITY_AI_PROVIDER: provider,
      GEMINI_API_KEY: "offline-gemini-fixture",
      GEMINI_MODEL: "gemini-flash-latest",
      OPENAI_API_KEY: "offline-openai-fixture",
      OPENAI_MODEL: "gpt-4.1-mini",
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_m11_fixture",
      AGENT_CITY_TEST_OPENAI_URL: supabaseURL,
      SUPABASE_URL: supabaseURL,
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_m04_fixture_only",
      SUPABASE_PROJECT_REF: "fixture",
      SUPABASE_VERIFY_ACCESS_TOKEN: "",
      NODE_USE_ENV_PROXY: "0",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
app.stdout.on("data", (b) => {
  logs = (logs + b).slice(-30000);
});
app.stderr.on("data", (b) => {
  logs = (logs + b).slice(-30000);
});
async function request(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    redirect: "manual",
    headers: {
      Origin: base,
      Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      ...options.headers,
    },
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0],
      i = pair.indexOf("="),
      name = pair.slice(0, i),
      value = pair.slice(i + 1);
    if (!value || /max-age=0/i.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
  return response;
}
const forms = (html) =>
  [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]);
async function submit(path, form, extra = {}) {
  assert.ok(form, "Expected form");
  const body = new FormData();
  for (const match of form.matchAll(/<input\b[^>]*>/g)) {
    const name = match[0].match(/name="([^"]+)"/)?.[1];
    if (name) body.set(name, match[0].match(/value="([^"]*)"/)?.[1] ?? "");
  }
  for (const [k, v] of Object.entries(extra)) body.set(k, v);
  const response = await request(path, { method: "POST", body });
  assert.equal(response.status, 303, "Server action redirect");
  return response.headers.get("location");
}
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (app.exitCode !== null)
      throw new Error("Next.js fixture exited: " + logs);
    try {
      const r = await fetch(base + "/login", {
        signal: AbortSignal.timeout(1000),
      });
      if (r.status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await delay(200);
  }
  assert.ok(ready, "Fixture app readiness");
  for (const route of [
    "/dashboard",
    "/dashboard/agents",
    "/dashboard/activity",
  ])
    assert.equal((await request(route)).status, 307);
  let html = await (await request("/login")).text();
  assert.match(html, /name="password"/);
  assert.doesNotMatch(html, /Enter local workspace/);
  const invalid = await submit("/login", forms(html)[0], {
    email: "fixture@example.test",
    password: "wrong-fixture-password",
  });
  assert.match(invalid, /Unable/);
  assert.equal((await request("/dashboard")).status, 307);
  await submit("/login", forms(html)[0], {
    email: "fixture@example.test",
    password: "fixture-password",
  });
  html = await (await request("/dashboard")).text();
  assert.match(html, /SUPABASE/);
  assert.match(html, /Create your first workspace/);
  const definitions = await (await request("/dashboard/agents")).text();
  assert.match(definitions, /Persisted fixture Chief/);
  assert.match(definitions, /V<!-- -->7|V7/);
  console.log(
    "PASS (local HTTP fixture): password login, failed login, real-mode routes, database-backed agent definitions",
  );
  await submit(
    "/dashboard",
    forms(html).find((f) => f.includes('name="name"')),
    { name: "M0.4 fixture workspace" },
  );
  html = await (await request("/dashboard")).text();
  assert.match(html, /M0.4 fixture workspace/);
  await submit(
    "/dashboard",
    forms(html).find((f) => f.includes('name="objective"')),
    {
      workspaceId: wid,
      title: "M0.4 fixture mission",
      objective:
        "Verify transport and persistence with a local HTTP fixture only.",
      kind: "personal",
    },
  );
  for (const action of ["submit", "approve", "start", "complete"]) {
    html = await (await request("/dashboard")).text();
    await submit(
      "/dashboard",
      forms(html).find((f) => f.includes(`value="${action}"`)),
    );
  }
  html = await (await request("/dashboard")).text();
  assert.match(html, /M0.4 fixture mission/);
  assert.match(html, /completed/);
  assert.match(
    await (await request("/dashboard/activity")).text(),
    /mock.complete/,
  );
  assert.deepEqual(
    calls
      .filter((c) => c.path.startsWith("/rest/v1/rpc/"))
      .map((c) => c.path.split("/").at(-1)),
    [
      "create_workspace",
      "create_mission",
      "transition_mission",
      "transition_mission",
      "transition_mission",
      "transition_mission",
    ],
  );
  console.log(
    "PASS (local HTTP fixture): exact RPC routes/payloads, persisted dashboard reads, approved mock lifecycle and activity",
  );
  if (planningTest) {
    state.missions.push({ id: planningMid, workspace_id: wid, title: "M1.1 offline planning mission", objective: "Prepare proposals without executing any work.", kind: "business", status: "draft", execution_mode: "mock", created_by: uid, created_at: new Date().toISOString() });
    html = await (await request("/dashboard")).text();
    const planForm = forms(html).find((f) => f.includes('name="authorize"'));
    assert.ok(planForm);
    const before = calls.filter((c) => c.path.endsWith("begin_chief_plan")).length;
    const denied = await submit("/dashboard", planForm, { authorize: "" });
    assert.match(denied, /error=/);
    assert.equal(calls.filter((c) => c.path.endsWith("begin_chief_plan")).length, before);
    assert.equal(providerCalls, 0);
    const savedJar = new Map(jar);
    jar.clear();
    const unauthenticated = await submit("/dashboard", planForm, { authorize: "yes" });
    assert.match(unauthenticated, /login/);
    for (const [k,v] of savedJar) jar.set(k,v);
    assert.equal(providerCalls, 0);
    const planningResult = await submit("/dashboard", planForm, { authorize: "yes" });
    assert.equal(providerCalls, 1);
    if (persistenceFailure) {
      assert.match(decodeURIComponent(planningResult), /Plan persistence could not be confirmed/);
      assert.equal(state.runs[0].status, "running");
      assert.equal(state.artifacts.length, 0);
      const events = logs.split("\n").filter((line) => line.startsWith("agent_city.planning ")).map((line) => JSON.parse(line.slice("agent_city.planning ".length)));
      assert.ok(events.some((e) => e.stage === "generation" && e.outcome === "succeeded" && e.runId === planningRid));
      assert.ok(events.some((e) => e.stage === "finalize_plan" && e.outcome === "failed" && e.code === "23514" && e.httpStatus === 400 && e.runId === planningRid));
      const diagnosticText = JSON.stringify(events);
      assert.doesNotMatch(diagnosticText, /private-plan-sensitive-marker|Offline fixture plan|offline-gemini-fixture|sb_secret_m11_fixture/);
      assert.ok(!diagnosticText.includes(planningHash));
      html = await (await request("/dashboard")).text();
      assert.doesNotMatch(html, /Offline fixture plan|private-plan-sensitive-marker/);
      const recoverForm = forms(html).find((f) => f.includes("Recover interrupted plan"));
      assert.match(await submit("/dashboard", recoverForm), /error=/); // Active lease cannot be recovered.
      state.runs[0].expires_at = new Date(Date.now()-1000).toISOString();
      assert.equal(await submit("/dashboard", recoverForm), "/dashboard");
      assert.equal(state.runs[0].status, "failed");
      assert.equal(providerCalls, 1);
      assert.equal(calls.filter((c) => c.path.endsWith("finish_chief_plan")).length, 1);
      html = await (await request("/dashboard")).text();
      assert.ok(forms(html).some((f) => f.includes('name="authorize"'))); // Fresh consent required; no automatic retry.
      console.log("PASS (offline persistence failure): exact production message, sanitized SQLSTATE/stage, no artifact/retry, lease expiry and owner recovery");
    } else {
      assert.equal(planningResult, "/dashboard");
      assert.equal(providerCalls, 1);
      html = await (await request("/dashboard")).text();
      assert.match(html, /Offline fixture plan/);
      assert.match(html, /Review fixture evidence/);
      assert.match(html, /Human-reviewed fixture report/);
      assert.match(html, /human review required/);
      assert.match(html, /not executable/);
      assert.doesNotMatch(html, /offline-openai-fixture|offline-gemini-fixture|sb_secret_m11_fixture/);
      assert.doesNotMatch(html, new RegExp(planningHash));
      const duplicate = await submit("/dashboard", planForm, { authorize: "yes" });
      assert.match(duplicate, /error=/);
      assert.equal(providerCalls, 1);
      assert.equal(state.artifacts.length, 1);
      console.log(`PASS (offline planning HTTP, ${provider}): consent/session, provider transport, finalizer payload, UI proposals, no secret exposure, duplicate rejection`);
    }
  }
  const cookieName = [...jar.keys()].find((k) => k.endsWith("-auth-token"));
  assert.ok(cookieName, "SSR session cookie");
  const current = jar.get(cookieName);
  assert.ok(current.startsWith("base64-"));
  const stored = JSON.parse(
    Buffer.from(current.slice(7), "base64url").toString("utf8"),
  );
  stored.expires_at = Math.floor(Date.now() / 1000) - 60;
  jar.set(
    cookieName,
    "base64-" + Buffer.from(JSON.stringify(stored)).toString("base64url"),
  );
  const before = refreshes;
  const refreshed = await request("/dashboard");
  assert.equal(refreshed.status, 200);
  assert.equal(refreshes, before + 1);
  assert.notEqual(jar.get(cookieName), current);
  assert.match(refreshed.headers.get("cache-control") ?? "", /no-store/);
  assert.match(await refreshed.text(), /M0.4 fixture mission/);
  console.log(
    "PASS (local HTTP fixture): expired session refresh, updated browser cookies and request propagation, no-store response",
  );
  html = await (await request("/dashboard")).text();
  await submit(
    "/dashboard",
    forms(html).find((f) => f.includes("Sign out")),
  );
  assert.equal(logouts, 1);
  assert.equal((await request("/dashboard")).status, 307);
  assert.ok(
    ![...jar.keys()].some((k) => k.endsWith("-auth-token")),
    "Session cookie removed",
  );
  html = await (await request("/login")).text();
  await submit("/login", forms(html)[0], {
    email: "fixture@example.test",
    password: "fixture-password",
  });
  html = await (await request("/dashboard")).text();
  assert.match(html, /M0.4 fixture mission/);
  assert.match(html, /completed/);
  assert.ok(
    !calls.some((c) => c.path.includes("signup") || c.path.includes("/admin/")),
  );
  console.log(
    "PASS (local HTTP fixture): logout removes session; fresh login reads retained service data; no Auth-user administration",
  );
} catch (error) {
  console.error(
    "Local HTTP integration failure:",
    error instanceof Error ? error.message : "unknown",
  );
  process.exitCode = 1;
} finally {
  try {
    process.kill(-app.pid, "SIGTERM");
  } catch {}
  await Promise.race([
    once(app, "exit"),
    delay(5000).then(() => {
      try {
        process.kill(-app.pid, "SIGKILL");
      } catch {}
    }),
  ]);
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
}
