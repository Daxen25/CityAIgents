import assert from "node:assert/strict";
const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw new Error("Smoke tests are restricted to a local mock server");
const jar = new Map();
async function request(path, options = {}) {
  const response = await fetch(new URL(path, base), {
    ...options,
    redirect: "manual",
    headers: {
      ...options.headers,
      Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      Origin: base,
    },
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0];
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return response;
}
function forms(html) {
  return [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map(
    (m) => m[1],
  );
}
function fields(form) {
  const body = new URLSearchParams();
  for (const m of form.matchAll(/<input\b[^>]*>/g)) {
    const name = m[0].match(/name="([^"]+)"/)?.[1],
      value = m[0].match(/value="([^"]*)"/)?.[1] ?? "";
    if (name) body.set(name, value);
  }
  return body;
}
async function submit(path, form, extra = {}) {
  assert.ok(form, "Expected form exists");
  const body = new FormData();
  for (const [k, v] of fields(form)) body.set(k, v);
  for (const [k, v] of Object.entries(extra)) body.set(k, v);
  const response = await request(path, { method: "POST", body });
  assert.equal(
    response.status,
    303,
    `Action failed with HTTP ${response.status}: ${(await response.text()).slice(0, 250)}`,
  );
  return response.headers.get("location");
}
assert.equal((await request("/dashboard")).status, 307);
jar.set("city-local", "forged.session.signature");
assert.equal((await request("/dashboard/agents")).status, 307);
jar.clear();
let html = await (await request("/login")).text();
assert.match(html, /Local simulation/);
await submit("/login", forms(html)[0]);
html = await (await request("/dashboard")).text();
assert.match(html, /LOCAL MOCK/);
const title = `M0 smoke ${Date.now()}`;
const createForm = forms(html).find((f) => f.includes('name="objective"'));
const denied = await submit("/dashboard", createForm, {
  workspaceId: "33333333-3333-4333-8333-333333333333",
  title,
  objective: "Explicit smoke test only",
  kind: "personal",
});
assert.match(denied, /error=/);
await submit("/dashboard", createForm, {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  title,
  objective: "Explicit smoke test only; no real work or external actions.",
  kind: "personal",
});
for (const [action, status] of [
  ["submit", "awaiting approval"],
  ["approve", "approved"],
  ["start", "running"],
  ["complete", "completed"],
]) {
  html = await (await request("/dashboard")).text();
  const article = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)]
    .map((m) => m[1])
    .find((x) => x.includes(title));
  assert.ok(article);
  const form = forms(article).find((f) => f.includes(`value="${action}"`));
  await submit("/dashboard", form);
  const after = await (await request("/dashboard")).text();
  const updated = [...after.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)]
    .map((m) => m[1])
    .find((x) => x.includes(title));
  assert.ok(updated.includes(status));
}
assert.match(
  await (await request("/dashboard/activity")).text(),
  /mock.complete/,
);
assert.match(
  await (await request("/dashboard/agents")).text(),
  /Chief of Staff/,
);
html = await (await request("/dashboard")).text();
await submit(
  "/dashboard",
  forms(html).find((f) => f.includes("Sign out")),
);
assert.equal((await request("/dashboard")).status, 307);
console.log(
  "PASS: unauthenticated protection, forged session rejection, mock login, workspace denial, mission creation, approval + run lifecycle, activity, agents, logout",
);
