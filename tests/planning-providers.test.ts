import { test } from "node:test";
import assert from "node:assert/strict";
import { planningConfig, generateGeminiPlan, generatePlan, executePlanning, type PlanningDependencies } from "../apps/web/lib/planning-engine";
import type { Plan } from "@agent-city/core";

const plan: Plan = { summary: "Review proposals", tasks: [{ title: "Research", suggested_agent_role: "researcher", expected_deliverable: "Evidence" }], risks: [] };
const mission = { title: "Planning", objective: "Untrusted mission objective" };
const env = { AGENT_CITY_MODE: "supabase", AGENT_CITY_AI_PLANNING_ENABLED: "true", GEMINI_API_KEY: "gemini-fixture", OPENAI_API_KEY: "openai-fixture", SUPABASE_SERVICE_ROLE_KEY: "service-fixture" };
const response = () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(plan) }] } }] });

test("Gemini is the default only when explicitly enabled; provider-specific key and model selection", () => {
  assert.deepEqual(planningConfig(env), { provider: "gemini", model: "gemini-flash-latest", apiKey: "gemini-fixture", serviceKey: "service-fixture" });
  assert.equal(planningConfig({ ...env, GEMINI_MODEL: "gemini-3.5-flash", OPENAI_MODEL: "ignored" }).model, "gemini-3.5-flash");
  const openai = planningConfig({ ...env, AGENT_CITY_AI_PROVIDER: "openai" });
  assert.equal(openai.provider, "openai"); assert.equal(openai.model, "gpt-4.1-mini"); assert.equal(openai.apiKey, "openai-fixture");
  assert.equal(planningConfig({ ...env, AGENT_CITY_AI_PROVIDER: "openai", OPENAI_MODEL: "gpt-4.1", GEMINI_MODEL: "ignored" }).model, "gpt-4.1");
  for (const change of [
    { GEMINI_API_KEY: "" }, { AGENT_CITY_AI_PROVIDER: "openai", OPENAI_API_KEY: "" },
    { AGENT_CITY_AI_PROVIDER: "invalid" }, { AGENT_CITY_AI_PROVIDER: "" },
    { GEMINI_MODEL: "../bad/model" }, { GEMINI_MODEL: "a".repeat(101) },
    { AGENT_CITY_AI_PLANNING_ENABLED: undefined }, { AGENT_CITY_AI_PLANNING_ENABLED: "false" },
    { AGENT_CITY_MODE: "mock" }, { SUPABASE_SERVICE_ROLE_KEY: "" },
  ]) assert.throws(() => planningConfig({ ...env, ...change }));
});

test("Gemini sends exactly one bounded structured request with header credential, no tools or redirects", async () => {
  let count = 0;
  const actual = await generateGeminiPlan(planningConfig(env), mission, async (url, options) => {
    count++;
    assert.equal(String(url), "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent");
    assert.ok(!String(url).includes("gemini-fixture"));
    assert.equal(options?.method, "POST"); assert.equal(options?.redirect, "error");
    assert.equal(new Headers(options?.headers).get("x-goog-api-key"), "gemini-fixture");
    assert.ok(options?.signal);
    const body = JSON.parse(String(options?.body));
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.equal(body.generationConfig.maxOutputTokens, 6000);
    assert.equal(body.generationConfig.candidateCount, 1);
    assert.equal(body.generationConfig.responseJsonSchema.additionalProperties, false);
    assert.equal(body.generationConfig.responseJsonSchema.properties.tasks.maxItems, 12);
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), mission);
    assert.equal(body.tools, undefined);
    return Response.json(response());
  });
  assert.equal(count, 1); assert.deepEqual(actual, plan);
});

test("Gemini accepts text output with thought signatures and excludes thought text", async () => {
  const body = response();
  const parts = [{ text: "internal reasoning", thought: true }, { text: JSON.stringify(plan), thoughtSignature: "fixture-signature" }];
  const result = await generateGeminiPlan(planningConfig(env), mission, async () => Response.json({ ...body, candidates: [{ finishReason: "STOP", content: { parts } }] }));
  assert.deepEqual(result, plan);
});

test("Gemini rate limits/quota/auth/provider failures are sanitized without retry or OpenAI fallback", async (t) => {
  const endpoints: string[] = [];
  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    endpoints.length = 0;
    const mock = t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      endpoints.push(String(url));
      return Response.json({ error: { message: "sensitive-provider-response", status: "RESOURCE_EXHAUSTED" } }, { status });
    });
    await assert.rejects(generatePlan(planningConfig(env), mission), (error: Error) => {
      assert.match(error.message, /provider_error/); assert.doesNotMatch(error.message, /sensitive|fixture/); return true;
    });
    assert.equal(endpoints.length, 1); assert.match(endpoints[0], /generativelanguage.googleapis.com/);
    mock.mock.restore();
  }
});

test("Gemini invalid JSON, schema violations, blocked/truncated/tool/missing responses are rejected", async () => {
  const invalid = [
    {}, { promptFeedback: { blockReason: "SAFETY" } },
    { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{}" }] } }] },
    { candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: "execute" } }] } }] },
    { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not json" }] } }] },
    { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ ...plan, tasks: [] }) }] } }] },
    { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ ...plan, execute: true }) }] } }] },
    { candidates: [...response().candidates, ...response().candidates] },
  ];
  for (const body of invalid)
    await assert.rejects(generateGeminiPlan(planningConfig(env), mission, async () => Response.json(body)), /invalid_output/);
  await assert.rejects(generateGeminiPlan(planningConfig(env), mission, async () => new Response("not JSON")), /invalid_output/);
});

test("Gemini timeouts/aborts and transport errors are sanitized", async () => {
  for (const name of ["AbortError", "TimeoutError", "TypeError"]) {
    let calls = 0;
    await assert.rejects(generateGeminiPlan(planningConfig(env), mission, async () => {
      calls++; throw new DOMException("sensitive-detail", name);
    }), name === "TypeError" ? /provider_error/ : /timeout/);
    assert.equal(calls, 1);
  }
});

test("disabled feature invokes neither provider and Gemini selection is passed to the claim", async () => {
  let calls = 0;
  const deps: PlanningDependencies = {
    config: () => planningConfig({ ...env, AGENT_CITY_AI_PLANNING_ENABLED: "false" }),
    authenticate: async () => {}, capability: () => ({ hash: "a".repeat(64) }),
    claim: async (_id, _hash, model, provider) => { assert.equal(provider, "gemini"); assert.equal(model, "gemini-flash-latest"); return { runId: "run", ...mission }; },
    generate: async () => { calls++; return plan; }, finish: async () => {},
  };
  const id = "11111111-1111-4111-8111-111111111111";
  await assert.rejects(executePlanning(id, true, deps), /disabled/); assert.equal(calls, 0);
  deps.config = () => planningConfig(env);
  await executePlanning(id, true, deps); assert.equal(calls, 1);
});

test("OpenAI dispatch stays explicit and uses its existing SDK without touching Gemini", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    calls++; assert.match(String(url), /^https:\/\/api.openai.com\//);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(plan) } }] });
  });
  assert.deepEqual(await generatePlan(planningConfig({ ...env, AGENT_CITY_AI_PROVIDER: "openai" }), mission), plan);
  assert.equal(calls, 1);
});
