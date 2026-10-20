import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSupabaseConfig } from "../apps/web/lib/config";
const ref = "atbksxlqgfxvetsgusek";
const env = {
  SUPABASE_URL: `https://${ref}.supabase.co`,
  SUPABASE_PROJECT_REF: ref,
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_fixture_only",
};
const jwt = (role: string, project = ref) =>
  `header.${Buffer.from(JSON.stringify({ role, ref: project })).toString("base64url")}.signature`;
test("hosted project and local development configuration", () => {
  assert.equal(resolveSupabaseConfig(env).url, env.SUPABASE_URL);
  assert.equal(
    resolveSupabaseConfig({
      ...env,
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_PUBLISHABLE_KEY: jwt("anon"),
    }).url,
    "http://127.0.0.1:54321",
  );
});
test("missing and privileged credentials fail closed without echoing values", () => {
  for (const key of [
    undefined,
    "",
    "sb_secret_do_not_log",
    jwt("service_role"),
    jwt("authenticated"),
  ]) {
    assert.throws(() =>
      resolveSupabaseConfig({ ...env, SUPABASE_PUBLISHABLE_KEY: key }),
    );
  }
  assert.throws(() =>
    resolveSupabaseConfig({ ...env, SUPABASE_URL: undefined }),
  );
});
test("legacy anon key accepted but another project's key rejected", () => {
  assert.ok(
    resolveSupabaseConfig({ ...env, SUPABASE_PUBLISHABLE_KEY: jwt("anon") }),
  );
  assert.throws(() =>
    resolveSupabaseConfig({
      ...env,
      SUPABASE_PUBLISHABLE_KEY: jwt("anon", "different-project"),
    }),
  );
});
test("mismatched, insecure and credential-bearing URLs rejected", () => {
  for (const url of [
    "http://example.com",
    "https://other.supabase.co",
    "https://user:password@atbksxlqgfxvetsgusek.supabase.co",
    "https://atbksxlqgfxvetsgusek.supabase.co/rest/v1",
  ]) {
    assert.throws(() => resolveSupabaseConfig({ ...env, SUPABASE_URL: url }));
  }
});
