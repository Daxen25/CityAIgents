// Framework-independent implementation; only planning.ts binds credentials and sessions.
import { z } from "zod";
import { planSchema, type Plan } from "@agent-city/core";

import { generatePlan, PlanningFailure } from "./planning-providers";
import { diagnosticError, type PlanningDiagnostic, type PlanningStage } from "./planning-diagnostics";
export { generatePlan, generateOpenAIPlan, generateGeminiPlan, PlanningFailure } from "./planning-providers";
export type AIProvider = "gemini" | "openai";
export type PlanningConfig = { provider: AIProvider; model: string; apiKey: string; serviceKey: string };
export function planningProvider(env: Record<string, string | undefined>): AIProvider {
  const provider = env.AGENT_CITY_AI_PROVIDER?.trim() ?? "gemini";
  if (provider !== "gemini" && provider !== "openai") throw new Error("Invalid AI provider configuration");
  return provider;
}
export function planningConfig(env: Record<string, string | undefined>): PlanningConfig {
  if (env.AGENT_CITY_MODE !== "supabase" || env.AGENT_CITY_AI_PLANNING_ENABLED !== "true")
    throw new Error("AI planning is disabled");
  const provider = planningProvider(env);
  const apiKey = (provider === "gemini" ? env.GEMINI_API_KEY : env.OPENAI_API_KEY)?.trim();
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const model = (provider === "gemini" ? env.GEMINI_MODEL?.trim() : env.OPENAI_MODEL?.trim()) ||
    (provider === "gemini" ? "gemini-flash-latest" : "gpt-4.1-mini");
  if (!apiKey || !serviceKey || model.length > 100 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model))
    throw new Error("AI planning server configuration is incomplete");
  return { provider, apiKey, serviceKey, model };
}

export type PlanningDependencies = {
  config(): PlanningConfig;
  authenticate(): Promise<void>;
  claim(id: string, hash: string, model: string, provider: AIProvider): Promise<{ runId: string; title: string; objective: string }>;
  capability(): { hash: string };
  generate(config: PlanningConfig, mission: { title: string; objective: string }): Promise<Plan>;
  finish(runId: string, hash: string, plan: Plan | null, error: string | null): Promise<void>;
  diagnostic?(event: PlanningDiagnostic): void;
};
export async function executePlanning(id: string, consent: boolean, deps: PlanningDependencies) {
  z.uuid().parse(id);
  if (consent !== true) throw new Error("Explicit owner authorization is required for one model call");
  const config = deps.config(); // Disabled/mock mode fails before any database or provider work.
  await deps.authenticate();
  const start = performance.now();
  let runId: string | undefined;
  function report(stage: PlanningStage, outcome: PlanningDiagnostic["outcome"], error?: unknown) {
    try {
      deps.diagnostic?.({ stage, outcome, provider: config.provider, runId, elapsedMs: performance.now() - start, ...diagnosticError(error) });
    } catch { /* diagnostics must not affect planning */ }
  }
  const { hash } = deps.capability();
  report("claim", "started");
  let claimed: Awaited<ReturnType<PlanningDependencies["claim"]>>;
  try {
    claimed = await deps.claim(id, hash, config.model, config.provider); // DB atomically checks owner and attempt limit.
    runId = claimed.runId;
    report("claim", "succeeded");
  } catch (error) { report("claim", "failed", error); throw error; }
  let plan: Plan;
  report("generation", "started");
  try {
    plan = planSchema.parse(await deps.generate(config, { title: claimed.title, objective: claimed.objective }));
    report("generation", "succeeded"); // Evidence of a returned, locally validated plan, without logging content.
  } catch (error) {
    report("generation", "failed");
    const failure = error instanceof PlanningFailure ? error : new PlanningFailure("invalid_output");
    report("finalize_failure", "started");
    try { await deps.finish(claimed.runId, hash, null, failure.code); report("finalize_failure", "succeeded"); }
    catch (error) { report("finalize_failure", "failed", error); throw new Error("Planning interrupted. Wait two minutes, then recover the run before retrying."); }
    throw failure;
  }
  // A persistence failure is ambiguous: never retry the model or overwrite with failure.
  report("finalize_plan", "started");
  try { await deps.finish(claimed.runId, hash, plan, null); report("finalize_plan", "succeeded"); }
  catch (error) { report("finalize_plan", "failed", error); throw new Error("Plan persistence could not be confirmed. Refresh; recover only if still running after two minutes."); }
}
