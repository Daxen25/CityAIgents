import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runGeminiDiagnostic } from "../scripts/lib/gemini-diagnostics";

const env = { GEMINI_API_KEY: "fixture-private-key", GEMINI_MODEL: "gemini-3.5-flash", SUPABASE_URL: "https://private.invalid", SUPABASE_SERVICE_ROLE_KEY: "private-database-key" };
const generation = ["--generate", "--acknowledge-api-charges"];
const body = { modelVersion: "gemini-3.5-flash-001", candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"status":"ok"}' }] } }] };
const metadata = { name: "models/gemini-3.5-flash", version: "001", supportedGenerationMethods: ["generateContent", "countTokens"], inputTokenLimit: 1048576, outputTokenLimit: 65536 };
function fixture(response: () => Response = () => Response.json(metadata)) {
  const calls: Array<{ url: string; options: RequestInit | undefined }> = [];
  const transport: typeof fetch = async (url, options) => { calls.push({ url: String(url), options }); return response(); };
  return { calls, transport };
}
function noSecrets(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [env.GEMINI_API_KEY, env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_URL, "private-provider-body", "synthetic-connectivity-check", "private prompt"]) assert.ok(!text.includes(secret), secret);
}

test("default and help are zero-network; flags, missing credentials and malformed models fail before transport", async () => {
  const f = fixture();
  assert.equal((await runGeminiDiagnostic([], env, f)).exitCode, 0);
  assert.equal((await runGeminiDiagnostic(["--help"], {}, f)).exitCode, 0);
  for (const args of [["--generate"], ["--metadata", "--generate"], ["--acknowledge-api-charges"], ["--metadata", "--metadata"], ["--endpoint=https://private.invalid"], ["--prompt", "private prompt"], [env.GEMINI_API_KEY]]) {
    const result = await runGeminiDiagnostic(args, env, f); assert.equal(result.exitCode, 1); noSecrets(result);
  }
  for (const overrides of [{ GEMINI_API_KEY: "" }, { GEMINI_API_KEY: "bad\nkey" }, { GEMINI_MODEL: "" }, { GEMINI_MODEL: "models/gemini-flash-latest" }, { GEMINI_MODEL: "../private" }, { GEMINI_MODEL: "gemini-" + "x".repeat(100) }]) {
    const result = await runGeminiDiagnostic(["--metadata"], { ...env, ...overrides }, f); assert.equal(result.exitCode, 1); noSecrets(result);
  }
  assert.equal(f.calls.length, 0);
});

test("metadata check is one header-authenticated non-redirecting bounded model GET, never generation", async () => {
  const f = fixture(() => Response.json({ ...metadata, description: "private prompt", error: "private-provider-body", extra: env.GEMINI_API_KEY }));
  const result = await runGeminiDiagnostic(["--metadata"], env, f);
  assert.equal(result.exitCode, 0); assert.equal(f.calls.length, 1);
  const { url, options } = f.calls[0];
  assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash"); assert.equal(options?.method, "GET");
  assert.equal(options?.redirect, "error"); assert.ok(options?.signal); assert.equal(new Headers(options?.headers).get("x-goog-api-key"), env.GEMINI_API_KEY);
  assert.equal(options?.body, undefined); assert.ok(!url.includes(env.GEMINI_API_KEY));
  assert.equal(result.result.generationRequests, 0); assert.equal(result.result.visibility.status, "verified");
  assert.equal(result.result.generateContent.status, "verified"); assert.equal(result.result.structuredOutput.status, "documented");
  assert.equal(result.result.resolvedModel, undefined); assert.equal(result.result.metadataModel, env.GEMINI_MODEL);
  assert.equal(result.result.outputTokenLimit, metadata.outputTokenLimit); assert.equal(result.result.quota.status, "unknown");
  assert.equal(result.result.freeTier.status, "unknown"); assert.equal(result.result.pricing.status, "unknown"); noSecrets(result);
});

test("metadata unsupported/malformed models are not treated as successful generation or structured-output verification", async () => {
  for (const value of [{ ...metadata, supportedGenerationMethods: ["embedContent"] }, {}, { ...metadata, name: "private prompt" }, { ...metadata, supportedGenerationMethods: null }]) {
    const f = fixture(() => Response.json(value)); const result = await runGeminiDiagnostic(["--metadata"], env, f);
    assert.equal(result.exitCode, 1); assert.equal(f.calls.length, 1); assert.equal(result.result.generationRequests, 0);
    assert.notEqual(result.result.structuredOutput.status, "verified"); noSecrets(result);
  }
  const f = fixture(); const local = await runGeminiDiagnostic([], { ...env, GEMINI_MODEL: "gemini-future-unverified" }, f);
  assert.equal(local.exitCode, 0); assert.equal(local.result.structuredOutput.status, "unknown"); assert.equal(local.result.visibility.status, "unknown");
});

test("explicit generation makes exactly one small synthetic structured request without metadata, tools, retry or database work", async () => {
  const f = fixture(() => Response.json(body)); const result = await runGeminiDiagnostic(generation, env, f);
  assert.equal(result.exitCode, 0); assert.equal(f.calls.length, 1); assert.equal(result.result.generationRequests, 1);
  const call = f.calls[0]; assert.match(call.url, /\/gemini-3\.5-flash:generateContent$/); assert.equal(call.options?.method, "POST"); assert.equal(call.options?.redirect, "error");
  assert.equal(new Headers(call.options?.headers).get("x-goog-api-key"), env.GEMINI_API_KEY); assert.ok(call.options?.signal);
  const request = JSON.parse(String(call.options?.body));
  assert.deepEqual(JSON.parse(request.contents[0].parts[0].text), { diagnostic: "synthetic-connectivity-check" });
  assert.equal(request.generationConfig.maxOutputTokens, 256); assert.equal(request.generationConfig.candidateCount, 1);
  assert.equal(request.generationConfig.responseMimeType, "application/json"); assert.deepEqual(request.generationConfig.responseJsonSchema.properties.status.enum, ["ok"]);
  assert.equal(request.tools, undefined); assert.ok(!String(call.options?.body).includes(env.SUPABASE_SERVICE_ROLE_KEY));
  assert.equal(result.result.resolvedModel, body.modelVersion); assert.deepEqual(result.result.structuredOutput, { status: "verified", value: "synthetic_schema_only" }); noSecrets(result);
});

test("HTTP 400/401/403/404/429/503 remain sanitized and never retry or switch provider in either operation", async () => {
  for (const args of [["--metadata"], generation]) {
    for (const [status, classification] of [[400, "invalid_request_or_schema"], [401, "authentication"], [403, "permission_denied"], [404, "model_or_endpoint_unavailable"], [429, "quota_or_rate_limit"], [503, "server_error"]] as const) {
      const f = fixture(() => {
        const response = new Response("private-provider-body " + env.GEMINI_API_KEY, { status });
        response.json = async () => { assert.fail("Must not read raw provider error bodies"); };
        return response;
      });
      const result = await runGeminiDiagnostic(args, env, f);
      assert.equal(result.exitCode, 1); assert.equal(result.result.httpStatus, status); assert.equal(result.result.failureClass, classification);
      assert.equal(f.calls.length, 1); assert.equal(result.result.networkRequests, 1); noSecrets(result);
      if (status === 429) assert.equal(result.result.quota.status, "verified");
    }
  }
});

test("timeout, abort and transport failures do not leak causes, retry or claim provider availability", async () => {
  for (const args of [["--metadata"], generation]) {
    for (const error of [new DOMException("private-provider-body", "TimeoutError"), new DOMException("private-provider-body", "AbortError"), new TypeError(env.GEMINI_API_KEY)]) {
      let calls = 0;
      const result = await runGeminiDiagnostic(args, env, { transport: async () => { calls++; throw error; } });
      assert.equal(result.exitCode, 1); assert.equal(calls, 1); assert.equal(result.result.visibility.status, "unknown"); noSecrets(result);
    }
  }
});

test("the 10-second deadline covers metadata headers/body and generation, without real waits", async (t) => {
  for (const args of [["--metadata"], generation]) {
    const controller = new AbortController(); controller.abort(new DOMException("private-provider-body", "TimeoutError"));
    const timer = t.mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, 10_000); return controller.signal; });
    let calls = 0;
    const result = await runGeminiDiagnostic(args, env, { transport: async (_url, options) => { calls++; assert.ok(options?.signal?.aborted); throw options.signal.reason; } });
    assert.equal(result.result.failureClass, "timeout"); assert.equal(result.result.timeoutSource, "application_deadline"); assert.equal(calls, 1); noSecrets(result); timer.mock.restore();
  }
  const controller = new AbortController(); const timer = t.mock.method(AbortSignal, "timeout", () => controller.signal);
  const f = fixture(() => { const response = Response.json(metadata); response.json = async () => { controller.abort(); throw new DOMException("private-provider-body", "AbortError"); }; return response; });
  const result = await runGeminiDiagnostic(["--metadata"], env, f); assert.equal(result.result.failureClass, "timeout"); assert.equal(result.result.httpStatus, 200); timer.mock.restore();
});

test("malformed/truncated/refused/tool/invalid synthetic output is not compatibility proof", async () => {
  for (const value of [{}, { ...body, candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"status":"ok"}' }] } }] },
    { ...body, candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"status":"wrong"}' }] } }] },
    { ...body, candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: "private prompt" } }] } }] },
    { promptFeedback: { blockReason: "SAFETY" } }]) {
    const f = fixture(() => Response.json(value)); const result = await runGeminiDiagnostic(generation, env, f);
    assert.equal(result.exitCode, 1); assert.equal(result.result.failureClass, "invalid_output"); assert.notEqual(result.result.structuredOutput.status, "verified"); assert.equal(f.calls.length, 1); noSecrets(result);
  }
  const f = fixture(() => Response.json({ ...body, modelVersion: env.GEMINI_API_KEY })); const result = await runGeminiDiagnostic(generation, env, f); assert.equal(result.result.resolvedModel, undefined); noSecrets(result);
});

test("real CLI default/help succeeds with network blocked and never loads application env files", () => {
  for (const args of [[], ["--help"]]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--import", "./tests/fixtures/gemini-diagnostics-no-network.mjs", "scripts/gemini-diagnostics.mts", ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, ""); const result = JSON.parse(child.stdout); assert.equal(result.networkRequests, 0); assert.equal(result.generationRequests, 0); noSecrets(result);
  }
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/gemini-diagnostics.mts"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(child.status, 1); assert.equal(JSON.parse(child.stdout).failureClass, "missing_or_invalid_credentials");
});
