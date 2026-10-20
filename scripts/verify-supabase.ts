/** Read-only: GET requests only, no sign-in, refresh, RPC, DDL or migration application. */
import { existsSync, readdirSync } from "node:fs";
import { resolveSupabaseConfig } from "../apps/web/lib/config";
async function main() {
  if (existsSync("apps/web/.env.local"))
    process.loadEnvFile("apps/web/.env.local");
  console.log(
    "Local migrations:",
    readdirSync("supabase/migrations")
      .filter((n) => n.endsWith(".sql"))
      .sort()
      .join(", "),
  );
  console.log(
    "Remote migration history: UNKNOWN (requires read-only SQL access; see supabase/inspect.sql)",
  );
  try {
    const { url, key } = resolveSupabaseConfig(process.env);
    console.log("Project origin:", url);
    const token = process.env.SUPABASE_VERIFY_ACCESS_TOKEN;
    const headers: Record<string, string> = { apikey: key };
    if (token) headers.Authorization = `Bearer ${token}`;
    let failed = false;
    async function get(path: string) {
      const response = await fetch(`${url}${path}`, {
        headers,
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      return response;
    }
    const settings = await get("/auth/v1/settings");
    console.log(
      `Auth endpoint / API key: HTTP ${settings.status}${settings.ok ? " (reachable)" : " (not verified)"}`,
    );
    if (!settings.ok) failed = true;
    const user = await get("/auth/v1/user");
    if (token) {
      console.log(
        `Existing user session: HTTP ${user.status}${user.ok ? " (server-verified)" : " (not verified)"}`,
      );
      if (!user.ok) failed = true;
    } else {
      console.log(
        `Unauthenticated user check: HTTP ${user.status}; signed-in authentication UNVERIFIED (no existing access token supplied)`,
      );
      if (user.status !== 401 && user.status !== 403) failed = true;
    }
    const database = await get("/rest/v1/workspaces?select=id&limit=0");
    if (database.ok && token)
      console.log(
        "Database SELECT: reachable with authenticated session (zero rows requested)",
      );
    else {
      console.log(
        `Database SELECT: HTTP ${database.status}; ${token ? "not verified" : "authenticated access UNVERIFIED"}`,
      );
      if (token || ![401, 403].includes(database.status)) failed = true;
    }
    if (!token) failed = true;
    if (failed) process.exitCode = 2;
  } catch {
    console.error(
      "Verification blocked: configure the publishable key, matching project URL and allowed network access. No credential or response body was logged.",
    );
    process.exitCode = 2;
  }
}
void main();
