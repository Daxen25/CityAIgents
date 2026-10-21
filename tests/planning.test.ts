import { test } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { planSchema, type Plan } from "@agent-city/core";
import { executePlanning, generatePlan, planningConfig, PlanningFailure, type PlanningDependencies } from "../apps/web/lib/planning-engine";

const id = "11111111-1111-4111-8111-111111111111";
const plan: Plan = { summary: "Review a safe plan", tasks: [{ title: "Research", suggested_agent_role: "researcher", expected_deliverable: "Evidence for human review" }], risks: ["Unverified evidence"] };
const env = { AGENT_CITY_MODE: "supabase", AGENT_CITY_AI_PLANNING_ENABLED: "true", OPENAI_API_KEY: "offline-fixture", SUPABASE_SERVICE_ROLE_KEY: "offline-fixture" };
function dependencies() {
  const calls: string[] = [];
  const deps: PlanningDependencies = {
    config: () => planningConfig(env),
    authenticate: async () => { calls.push("auth"); },
    capability: () => ({ hash: "a".repeat(64) }),
    claim: async () => { calls.push("claim"); return { runId: id, title: "Mission", objective: "Mission objective" }; },
    generate: async () => { calls.push("model"); return plan; },
    finish: async (_id, _hash, result, error) => { calls.push(error || "persist"); assert.deepEqual(result, error ? null : plan); },
  };
  return { deps, calls };
}

test("planning is opt-in, Supabase-only, configured, and defaults to gpt-4.1-mini", () => {
  assert.equal(planningConfig(env).model, "gpt-4.1-mini");
  assert.equal(planningConfig({ ...env, OPENAI_MODEL: "gpt-4.1" }).model, "gpt-4.1");
  for (const override of [{ AGENT_CITY_MODE: "mock" }, { AGENT_CITY_AI_PLANNING_ENABLED: undefined }, { AGENT_CITY_AI_PLANNING_ENABLED: "1" }, { OPENAI_API_KEY: "" }, { SUPABASE_SERVICE_ROLE_KEY: "" }])
    assert.throws(() => planningConfig({ ...env, ...override }));
});

test("structured plan bounds and unknown keys are enforced", () => {
  assert.deepEqual(planSchema.parse(plan), plan);
  for (const bad of [
    { ...plan, summary: " " }, { ...plan, summary: "a".repeat(2001) },
    { ...plan, tasks: [] }, { ...plan, tasks: Array(13).fill(plan.tasks[0]) },
    { ...plan, risks: Array(11).fill("risk") }, { ...plan, risks: [""] },
    { ...plan, risks: ["a".repeat(501)] }, { ...plan, execute: true },
    { ...plan, tasks: [{ ...plan.tasks[0], title: "a".repeat(201) }] },
    { ...plan, tasks: [{ ...plan.tasks[0], suggested_agent_role: "shell" }] },
    { ...plan, tasks: [{ ...plan.tasks[0], expected_deliverable: "" }] },
    { ...plan, tasks: [{ ...plan.tasks[0], tool: "execute" }] },
  ]) assert.equal(planSchema.safeParse(bad).success, false);
});

test("explicit consent, session, and claim authorization all precede model invocation", async () => {
  for (const stage of ["consent", "disabled", "auth", "claim"]) {
    const { deps, calls } = dependencies();
    if (stage === "disabled") deps.config = () => planningConfig({ ...env, AGENT_CITY_MODE: "mock" });
    if (stage === "auth") deps.authenticate = async () => { throw new Error("Unauthenticated"); };
    if (stage === "claim") deps.claim = async () => { throw new Error("Owner or duplicate denial"); };
    await assert.rejects(executePlanning(id, stage !== "consent", deps));
    assert.ok(!calls.includes("model"));
    assert.ok(!calls.includes("persist"));
  }
  const { deps, calls } = dependencies();
  await executePlanning(id, true, deps);
  assert.deepEqual(calls, ["auth", "claim", "model", "persist"]);
});

test("provider failures are sanitized and never fall back to mock or retry", async () => {
  for (const code of ["timeout", "provider_error", "invalid_output"] as const) {
    const { deps, calls } = dependencies();
    deps.generate = async () => { calls.push("model"); throw new PlanningFailure(code); };
    await assert.rejects(executePlanning(id, true, deps), new RegExp(code));
    assert.deepEqual(calls, ["auth", "claim", "model", code]);
  }
});

test("invalid generated JSON is not persisted as a successful plan", async () => {
  const { deps, calls } = dependencies();
  deps.generate = async () => ({ ...plan, tasks: [] });
  await assert.rejects(executePlanning(id, true, deps), /invalid_output/);
  assert.deepEqual(calls, ["auth", "claim", "invalid_output"]);
});

test("ambiguous persistence failure never re-invokes provider or writes failure over success", async () => {
  const { deps, calls } = dependencies();
  deps.finish = async () => { calls.push("finish"); throw new Error("secret transport detail"); };
  await assert.rejects(executePlanning(id, true, deps), /persistence could not be confirmed/);
  assert.deepEqual(calls, ["auth", "claim", "model", "finish"]);
});

test("failure-recording outage reports recoverable interruption", async () => {
  const { deps } = dependencies();
  deps.generate = async () => { throw new PlanningFailure("timeout"); };
  deps.finish = async () => { throw new Error("offline"); };
  await assert.rejects(executePlanning(id, true, deps), /recover the run/);
});

test("official SDK transport uses structured JSON, no tools, bounded tokens and only mission data", async () => {
  let requests = 0;
  const client = new OpenAI({ apiKey: "fixture-only", maxRetries: 0, fetch: async (url, options) => {
    requests++;
    assert.equal(String(url), "https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(String(options?.body));
    assert.equal(body.model, "gpt-4.1-mini");
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.max_completion_tokens, 6000);
    assert.equal(body.tools, undefined);
    assert.deepEqual(JSON.parse(body.messages[1].content), { title: "Mission", objective: "untrusted objective" });
    assert.ok(options?.signal);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(plan), refusal: null } }] });
  } });
  assert.deepEqual(await generatePlan({ apiKey: "fixture", model: "gpt-4.1-mini" }, { title: "Mission", objective: "untrusted objective" }, client), plan);
  assert.equal(requests, 1);
});

test("SDK refusal, truncation, malformed output and provider errors are rejected", async () => {
  for (const response of [
    { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(plan), refusal: "denied" } }] },
    { choices: [{ finish_reason: "length", message: { content: "{}" } }] },
    { choices: [{ finish_reason: "stop", message: { content: "not json" } }] },
    { choices: [] },
  ]) {
    const client = new OpenAI({ apiKey: "fixture", maxRetries: 0, fetch: async () => Response.json(response) });
    await assert.rejects(generatePlan({ apiKey: "fixture", model: "fixture" }, { title: "t", objective: "o" }, client), /invalid_output/);
  }
  for (const timeout of [false, true]) {
    let calls = 0;
    const client = new OpenAI({ apiKey: "fixture", maxRetries: 0, fetch: async () => {
      calls++;
      if (timeout) throw new DOMException("secret timeout data", "AbortError");
      return Response.json({ error: { message: "secret provider data" } }, { status: 500 });
    } });
    await assert.rejects(generatePlan({ apiKey: "fixture", model: "fixture" }, { title: "t", objective: "o" }, client), timeout ? /timeout/ : /provider_error/);
    assert.equal(calls, 1);
  }
});
