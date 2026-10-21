import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "./auth";
import { supabase } from "./supabase";
import { mode, supabaseConfig } from "./config";
import { executePlanning, generatePlan, planningConfig } from "./planning-engine";

export function planningEnabled() {
  return mode() === "supabase" && process.env.AGENT_CITY_AI_PLANNING_ENABLED === "true";
}
function checked<T>(result: { data: T; error: unknown }): T {
  // Never send provider/Supabase internals, secrets or prompt contents to the browser.
  if (result.error) throw new Error("Planning operation denied or unavailable. Check mission state, ownership and remaining attempts.");
  return result.data;
}
export async function planMission(id: string, consent: boolean) {
  let finalizer: SupabaseClient;
  await executePlanning(id, consent, {
    config: () => {
      const config = planningConfig(process.env);
      finalizer = createClient(supabaseConfig().url, config.serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      return config;
    },
    authenticate: async () => { await requireUser(); },
    capability: () => ({ hash: createHash("sha256").update(randomBytes(32)).digest("hex") }),
    claim: async (mid, token_hash, selected_model, selected_provider) => checked(await (await supabase()).rpc("begin_chief_plan", { mid, token_hash, selected_model, selected_provider })),
    generate: generatePlan,
    finish: async (rid, token_hash, plan, error_code) => {
      checked(await finalizer.rpc("finish_chief_plan", { rid, token_hash, plan, error_code }));
    },
  });
}
export async function recoverPlan(id: string) {
  // Recovery remains available with the feature flag off; it never calls a model.
  if (mode() !== "supabase") throw new Error("AI recovery is unavailable in mock mode");
  await requireUser();
  checked(await (await supabase()).rpc("recover_chief_plan", { mid: id }));
}
export async function missionPlans(hasPlanningMissions = false) {
  if (!planningEnabled() && !hasPlanningMissions) return { artifacts: [], runs: [] };
  const db = await supabase();
  const [artifacts, runs] = await Promise.all([
    db.from("artifacts").select("id,mission_id,content").eq("kind", "chief_of_staff_plan"),
    // Never select the lease capability, key, or privileged client metadata into UI data.
    db.from("runs").select("id,mission_id,status,failure_code,expires_at").in("adapter", ["openai", "gemini"]),
  ]);
  return { artifacts: checked(artifacts) ?? [], runs: checked(runs) ?? [] };
}
