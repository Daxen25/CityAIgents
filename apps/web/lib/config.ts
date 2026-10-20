export function mode(): "mock" | "supabase" {
  const value = process.env.AGENT_CITY_MODE;
  if (value !== "mock" && value !== "supabase")
    throw new Error(
      "Set AGENT_CITY_MODE=mock for local development or supabase for real authentication",
    );
  if (
    value === "mock" &&
    process.env.NODE_ENV === "production" &&
    process.env.AGENT_CITY_ALLOW_LOCAL_MOCK !== "true"
  )
    throw new Error(
      "Mock production build requires explicit local-only AGENT_CITY_ALLOW_LOCAL_MOCK=true",
    );
  return value;
}
// Shared by the server clients and read-only verification script. Never log key values.
export function resolveSupabaseConfig(env: Record<string, string | undefined>) {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key)
    throw new Error(
      "SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be configured",
    );
  const parsed = new URL(url);
  const local = ["127.0.0.1", "localhost"].includes(parsed.hostname);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/" ||
    (!local && parsed.protocol !== "https:") ||
    (local && !["http:", "https:"].includes(parsed.protocol))
  )
    throw new Error(
      "Supabase URL must be an HTTPS project origin (HTTP allowed only for loopback)",
    );
  const ref = env.SUPABASE_PROJECT_REF;
  if (ref && !local && parsed.hostname !== `${ref}.supabase.co`)
    throw new Error("Supabase URL does not match SUPABASE_PROJECT_REF");
  let publicKey =
    key.startsWith("sb_publishable_") && key.length > "sb_publishable_".length;
  if (!publicKey && key.split(".").length === 3) {
    try {
      const claims = JSON.parse(
        Buffer.from(key.split(".")[1], "base64url").toString("utf8"),
      );
      // This is a configuration guard only, not JWT signature verification.
      publicKey =
        claims.role === "anon" && (!ref || !claims.ref || claims.ref === ref);
    } catch {
      publicKey = false;
    }
  }
  if (!publicKey)
    throw new Error(
      "Use a Supabase publishable or legacy anon key; privileged or invalid keys are rejected",
    );
  return { url: parsed.origin, key };
}
export function supabaseConfig() {
  return resolveSupabaseConfig(process.env);
}
