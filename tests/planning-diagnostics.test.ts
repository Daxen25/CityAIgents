import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanningRpcError, diagnosticError, logPlanningDiagnostic, type PlanningDiagnostic } from "../apps/web/lib/planning-diagnostics";
import { executePlanning, planningConfig, PlanningFailure, type PlanningDependencies } from "../apps/web/lib/planning-engine";

const id = "11111111-1111-4111-8111-111111111111";
const privateText = "sensitive-private-plan-key-and-prompt";
function fixture() {
  const events: PlanningDiagnostic[] = [];
  let providerCalls = 0;
  let finalizerCalls = 0;
  const deps: PlanningDependencies = {
    config: () => planningConfig({ AGENT_CITY_MODE: "supabase", AGENT_CITY_AI_PLANNING_ENABLED: "true", GEMINI_API_KEY: "fixture", SUPABASE_SERVICE_ROLE_KEY: "fixture" }),
    authenticate: async () => {}, capability: () => ({ hash: "b".repeat(64) }),
    claim: async () => ({ runId: id, title: privateText, objective: privateText }),
    generate: async () => { providerCalls++; return { summary: privateText, tasks: [{ title: privateText, suggested_agent_role: "researcher", expected_deliverable: privateText }], risks: [] }; },
    finish: async () => { finalizerCalls++; }, diagnostic: (event) => { events.push(event); },
  };
  return { deps, events, calls: () => ({ providerCalls, finalizerCalls }) };
}

test("RPC error preserves only SQLSTATE/PostgREST code and HTTP status, not raw content", () => {
  for (const code of ["23514", "42501", "22P05", "P0001", "PGRST202", "PGRST301"]) {
    const error = new PlanningRpcError({ code, message: privateText, details: privateText, hint: privateText, token_hash: privateText }, 400);
    assert.deepEqual(diagnosticError(error), { code, httpStatus: 400 });
    assert.ok(!JSON.stringify(error).includes(privateText));
    assert.ok(!error.message.includes(privateText));
  }
  for (const code of [privateText, "23514\nprivate", null, {}, "ECONNRESET"])
    assert.equal(new PlanningRpcError({ code }, 0).code, undefined);
});

test("diagnostic logging whitelists fields and strips adversarial values", () => {
  const lines: string[] = [];
  logPlanningDiagnostic({ stage: "finalize_plan", outcome: "failed", provider: "gemini", runId: id, elapsedMs: 45_200.8, code: "23514", httpStatus: 400, plan: privateText, token_hash: privateText, error: { message: privateText } } as PlanningDiagnostic, (line) => lines.push(line));
  const result = JSON.parse(lines[0].slice("agent_city.planning ".length));
  assert.deepEqual(result, { stage: "finalize_plan", outcome: "failed", provider: "gemini", runId: id, elapsedMs: 45201, code: "23514", httpStatus: 400 });
  assert.ok(!lines[0].includes(privateText));
  lines.length = 0;
  logPlanningDiagnostic({ stage: privateText, outcome: privateText, provider: privateText, runId: privateText, elapsedMs: Infinity, code: privateText, httpStatus: 999 } as unknown as PlanningDiagnostic, (line) => lines.push(line));
  assert.ok(!lines[0].includes(privateText));
  assert.deepEqual(JSON.parse(lines[0].slice("agent_city.planning ".length)), { stage: "unknown", outcome: "unknown" });
});

test("validated generation and failed persistence are distinct, correlated and do not retry", async () => {
  const { deps, events, calls } = fixture();
  deps.finish = async () => { throw new PlanningRpcError({ code: "23514", message: privateText }, 400); };
  await assert.rejects(executePlanning(id, true, deps), /Plan persistence could not be confirmed/);
  assert.deepEqual(events.map((e) => [e.stage,e.outcome]), [["claim","started"],["claim","succeeded"],["generation","started"],["generation","succeeded"],["finalize_plan","started"],["finalize_plan","failed"]]);
  assert.equal(events.at(-1)?.code, "23514");
  assert.equal(events.at(-1)?.httpStatus, 400);
  assert.equal(events.at(-1)?.runId, id);
  assert.equal(events.at(-1)?.provider, "gemini");
  assert.ok(events.every((e) => e.elapsedMs >= 0));
  assert.ok(!JSON.stringify(events).includes(privateText));
  assert.equal(calls().providerCalls, 1);
});

test("provider failure does not log generation success; failure-finalizer has its own stage", async () => {
  const { deps, events } = fixture();
  deps.generate = async () => { throw new PlanningFailure("provider_error"); };
  deps.finish = async () => { throw new PlanningRpcError({ code: "PGRST202", message: privateText }, 404); };
  await assert.rejects(executePlanning(id, true, deps), /Planning interrupted/);
  assert.ok(!events.some((e) => e.stage === "generation" && e.outcome === "succeeded"));
  assert.equal(events.at(-1)?.stage, "finalize_failure");
  assert.equal(events.at(-1)?.code, "PGRST202");
});

test("claim authorization failure is diagnosed before any provider call", async () => {
  const { deps, events, calls } = fixture();
  deps.claim = async () => { throw new PlanningRpcError({ code: "42501" }, 403); };
  await assert.rejects(executePlanning(id, true, deps));
  assert.deepEqual(events.map((e) => [e.stage,e.outcome]), [["claim","started"],["claim","failed"]]);
  assert.equal(events.at(-1)?.code, "42501");
  assert.deepEqual(calls(), { providerCalls: 0, finalizerCalls: 0 });
});

test("diagnostic sink failures do not interrupt successful persistence or trigger retries", async () => {
  const { deps, calls } = fixture();
  deps.diagnostic = () => { throw new Error("sink failed"); };
  await executePlanning(id, true, deps);
  assert.deepEqual(calls(), { providerCalls: 1, finalizerCalls: 1 });
  assert.doesNotThrow(() => logPlanningDiagnostic({ stage: "generation", outcome: "succeeded", elapsedMs: 1 }, () => { throw new Error("sink failed"); }));
});
