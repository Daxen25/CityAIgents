/** Standalone operator CLI. No dotenv, Supabase, mission reads or application mutations. */
import { z } from "zod";
import { generateGeminiStructured } from "../../apps/web/lib/planning-providers";
import { diagnosticError, PlanningFailure, GeminiHttpFailure } from "../../apps/web/lib/planning-diagnostics";

const origin = "https://generativelanguage.googleapis.com/v1beta/models/";
const timeoutMs = 10_000;
const candidate = "gemini-3.6-flash";
const schema = z.strictObject({ status: z.enum(["ok"]) });
const metadataSchema = z.object({
  name: z.string().max(150),
  supportedGenerationMethods: z.array(z.string().max(100)).max(100),
  version: z.string().max(100).optional(),
  inputTokenLimit: z.number().int().nonnegative().safe().optional(),
  outputTokenLimit: z.number().int().nonnegative().safe().optional(),
});
type Evidence = { status: "unknown" } | { status: "verified" | "documented"; value: string };
type Operation = "local" | "metadata" | "generation" | "help";
export type DiagnosticResult = {
  operation: Operation; outcome: "valid" | "succeeded" | "failed" | "help";
  networkRequests: number; generationRequests: number; httpStatus: number | null; elapsedMs: number;
  failureClass?: string; timeoutSource?: string; transportPhase?: string;
  requestedModel?: string; resolvedModel?: string; metadataModel?: string; metadataVersion?: string;
  inputTokenLimit?: number; outputTokenLimit?: number;
  visibility: Evidence; generateContent: Evidence; structuredOutput: Evidence; quota: Evidence; freeTier: Evidence; pricing: Evidence;
  usage?: string[];
};
export async function runGeminiDiagnostic(
  args: readonly string[], env: Readonly<Record<string, string | undefined>>,
  dependencies: { transport?: typeof fetch; now?: () => number } = {},
): Promise<{ exitCode: number; result: DiagnosticResult }> {
  const now = dependencies.now ?? (() => performance.now());
  const began = now();
  const result: DiagnosticResult = {
    operation: "local", outcome: "failed", networkRequests: 0, generationRequests: 0, httpStatus: null, elapsedMs: 0,
    visibility: { status: "unknown" }, generateContent: { status: "unknown" }, structuredOutput: { status: "unknown" },
    quota: { status: "unknown" }, freeTier: { status: "unknown" }, pricing: { status: "unknown" },
  };
  const done = (exitCode: number) => {
    result.elapsedMs = Math.max(0, Math.round(now() - began));
    return { exitCode, result };
  };
  // Flags are an allowlist; never echo unknown arguments, which may contain secrets.
  if (args.length === 1 && args[0] === "--help") {
    result.operation = "help"; result.outcome = "help";
    result.usage = ["npm run diagnose:gemini (local validation; zero network)", "npm run diagnose:gemini -- --metadata (one model GET; no generation)", "npm run diagnose:gemini -- --generate --acknowledge-api-charges (one synthetic request; may incur charges)", "Supply GEMINI_API_KEY and GEMINI_MODEL in the process environment; no env files are loaded."];
    return done(0);
  }
  if (new Set(args).size !== args.length || args.some(a => !["--metadata", "--generate", "--acknowledge-api-charges"].includes(a)) ||
      (args.includes("--metadata") && args.includes("--generate")) ||
      (args.includes("--acknowledge-api-charges") && !args.includes("--generate"))) {
    result.failureClass = "invalid_arguments"; return done(1);
  }
  result.operation = args.includes("--generate") ? "generation" : args.includes("--metadata") ? "metadata" : "local";
  if (result.operation === "generation" && !args.includes("--acknowledge-api-charges")) {
    result.failureClass = "charge_acknowledgment_required"; return done(1);
  }
  const apiKey = env.GEMINI_API_KEY?.trim();
  const model = env.GEMINI_MODEL?.trim();
  if (!apiKey || /[\r\n\u0000]/.test(apiKey)) { result.failureClass = "missing_or_invalid_credentials"; return done(1); }
  if (!model || model.length > 100 || !/^gemini-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model) || model.includes(apiKey)) {
    result.failureClass = "invalid_model_configuration"; return done(1);
  }
  result.requestedModel = model;
  if (model === candidate) result.structuredOutput = { status: "documented", value: "official_model_documentation_not_project_verified" };
  if (result.operation === "local") { result.outcome = "valid"; return done(0); }
  const transport = dependencies.transport ?? fetch;
  const safeModel = (value: string | undefined) => value && value.length <= 100 && /^gemini-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes(apiKey) ? value : undefined;
  const tracked: typeof fetch = async (url, options) => {
    result.networkRequests++;
    if (result.operation === "generation") result.generationRequests++;
    const response = await transport(url, options);
    result.httpStatus = response.status;
    return response;
  };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    if (result.operation === "metadata") {
      const response = await tracked(`${origin}${encodeURIComponent(model)}`, {
        method: "GET", headers: { "x-goog-api-key": apiKey }, redirect: "error", signal,
      });
      if (!response.ok) {
        // Same HTTP classification as application transport, without reading an error body.
        throw new GeminiHttpFailure(response.status);
      }
      const parsed = metadataSchema.safeParse(await response.json());
      if (!parsed.success || !safeModel(parsed.data.name.replace(/^models\//, ""))) {
        result.failureClass = "invalid_metadata"; return done(1);
      }
      result.metadataModel = safeModel(parsed.data.name.replace(/^models\//, ""));
      const version = parsed.data.version;
      result.metadataVersion = version && /^[A-Za-z0-9._-]{1,100}$/.test(version) && !version.includes(apiKey) ? version : undefined;
      result.inputTokenLimit = parsed.data.inputTokenLimit;
      result.outputTokenLimit = parsed.data.outputTokenLimit;
      result.visibility = { status: "verified", value: "visible_in_model_metadata" };
      const supports = parsed.data.supportedGenerationMethods.includes("generateContent");
      result.generateContent = { status: "verified", value: supports ? "supported_in_metadata" : "unsupported_in_metadata" };
      // Metadata name/version are not proof of an alias's generated modelVersion.
      if (!supports) { result.failureClass = "generate_content_unsupported"; return done(1); }
    } else {
      await generateGeminiStructured({ apiKey, model }, { diagnostic: "synthetic-connectivity-check" },
        "Return only the JSON object with status equal to ok. This is a synthetic diagnostic; use no tools or external information.", schema, tracked,
        { timeoutMs, maxOutputTokens: 256, diagnoseTransport: true, onModelVersion: value => { result.resolvedModel = safeModel(value); } });
      result.visibility = { status: "verified", value: "reachable_for_this_generation" };
      result.generateContent = { status: "verified", value: "succeeded_for_this_request" };
      result.structuredOutput = { status: "verified", value: "synthetic_schema_only" };
    }
    result.outcome = "succeeded"; return done(0);
  } catch (error) {
    const details = diagnosticError(error);
    result.failureClass = details.failureClass ?? (error instanceof PlanningFailure ? error.code :
      signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) ? "timeout" : "transport_or_metadata_error");
    result.timeoutSource = details.timeoutSource ?? (signal.aborted ? "application_deadline" : undefined);
    result.transportPhase = details.transportPhase;
    if (result.httpStatus === 404 && result.operation === "metadata") result.visibility = { status: "verified", value: "not_visible_or_unavailable" };
    if (result.httpStatus === 429) result.quota = { status: "verified", value: "quota_or_rate_limit_response_observed" };
    return done(1);
  }
}

