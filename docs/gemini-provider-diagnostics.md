# Gemini provider diagnostics

`main` includes M1.4.1 (merge `c354fcf`, implementation `3a9629f`). This change adds
standalone tooling only. Planning/Researcher authorization, schema, limits, retries,
finalizers, migrations and production configuration are unchanged. No migration is needed.

The supplied Researcher and Chief of Staff evidence shows HTTP 503 responses with
successful failure persistence. Previous ~45-second planning failures align with the
application deadline. None establishes the underlying cause: model routing/availability,
provider load, network latency and model-side reasoning remain hypotheses. There is no
verified application defect warranting a model, schema, thinking or timeout change.

## Commands

Run from the repository root with Node 24 and installed dependencies. Supply
`GEMINI_API_KEY` through your local secret manager/process environment and set
`GEMINI_MODEL` explicitly. Do not put keys in command arguments, shell history, screenshots
or source files. The CLI does not load `.env` files, missions or Supabase configuration.

```sh
# Local process only; this does not change Vercel configuration.
export GEMINI_MODEL=gemini-3.5-flash
npm run diagnose:gemini
npm run diagnose:gemini -- --help
```

The default validates local configuration syntax and credential presence with **zero
network requests**. A valid result does not verify a model, API key or project access.
Unsupported argument combinations fail before network access. A syntactically plausible
but nonexistent model may pass local validation; its visibility remains unknown.

The following operations are **manual after delivery**, not implementation/test commands:

```sh
# Exactly one models.get HTTP request, no generation and no retries.
npm run diagnose:gemini -- --metadata
```

Metadata checks the configured model directly, avoiding listing/pagination and accidental
extra requests. It reports declared generateContent support and input/output token limits
when present. A metadata name/version does not prove the current target of a moving alias.

**Potential charges:** the next command authorizes exactly one potentially billed
synthetic generation request. It can consume quota even if it fails or times out. Review
current official model pricing and project billing before acknowledging. It creates no
Agent City run and consumes no task attempt; it also performs no preliminary metadata GET.

```sh
npm run diagnose:gemini -- --generate --acknowledge-api-charges
```

Generation uses the application's existing Gemini structured-output transport with fixed
synthetic input and a tiny `{status: "ok"}` schema. It never accepts custom prompts or
endpoints. The request has one candidate, a 256-token output ceiling and a 10-second
request/body deadline. Metadata also has a 10-second deadline. Keys travel only in the
`x-goog-api-key` header to a fixed HTTPS `v1beta` origin; redirects, automatic retries,
provider fallback and external tools are unavailable. The CLI ignores Researcher retry
flags: even HTTP 503 results in exactly one request per invocation.

Output is one allowlisted JSON object (npm adds its usual script banner). Exit code 0 means
local validation, metadata check or synthetic generation succeeded as indicated by
`operation`; exit code 1 means failure. Output includes HTTP status, elapsed milliseconds,
request counts, safe model identifiers, classification and evidence levels. No prompt,
generated content, credential, raw response/error/cause or database data is printed.

## Evidence and interpretation

Each of visibility, generateContent, structured output, quota, free tier and pricing is
reported separately with `verified`, `documented` or `unknown` evidence:

- Metadata success verifies visibility and the declared supported methods for that key
  at that instant; it does not verify structured output or current generation capacity.
- Synthetic success verifies only that tiny schema/request. It does not validate the full
  Chief of Staff/Researcher schemas, output quality, throughput or future availability.
  `resolvedModel` appears only when a successful generation returns a safe modelVersion.
- A documented candidate's JSON example is labeled documented even if project visibility
  is still unknown. Other model IDs are not assigned undocumented compatibility claims.
- 429 verifies only that a quota/rate-limit response was observed. Quota capacity, limits,
  free-tier eligibility and prices cannot be established by models.get or one generation.
  Free tier and pricing remain unknown; consult current project settings and official pages.
- 400: invalid request/schema; 401: authentication; 403: permission/access restrictions;
  404: model/endpoint unavailable; 429: quota/rate limit; 503: provider server error.
  These are HTTP-based categories, not explanations extracted from private error bodies.
- A timeout does not distinguish provider queue/generation from all network delays, nor
  guarantee server-side cancellation or zero billing. Application-deadline and transport
  categories/phase are shown where available. Invalid/truncated/safety-blocked output is
  not a successful compatibility check. Model-specific thinking may consume output budget;
  a 256-token/10-second diagnostic failure does not prove the larger application request
  would fail. No automatic thinking or token-budget adjustment is made.

## Model candidate and official evidence

Recommend **`gemini-3.5-flash` as a documented non-preview, explicitly versioned candidate
requiring project-specific verification**, not an automatic production replacement.
A versioned identifier is not necessarily an immutable snapshot. The CLI has no default
model; the candidate is referenced solely to label documented evidence.

Official sources reviewed on 2026-10-22:

- [Google model-list cookbook](https://github.com/google-gemini/cookbook/blob/main/quickstarts/Models.ipynb)
  lists the candidate; [Google's structured JSON cookbook](https://github.com/google-gemini/cookbook/blob/archive/generate-content-api/quickstarts/JSON_mode.ipynb)
  uses `gemini-3.5-flash` with JSON MIME type and a response schema.
- [Google SDK API selection](https://github.com/googleapis/js-genai#api-selection) documents
  beta endpoints by default; [official REST field mappings](https://github.com/googleapis/js-genai/blob/main/src/converters/_models_converters.ts)
  map supportedGenerationMethods and token-limit metadata. [Models API](https://ai.google.dev/api/models)
  documents the metadata resource. No API version mismatch is established here.
- [Google SDK types](https://github.com/googleapis/js-genai/blob/main/src/types.ts) document
  responseJsonSchema's subset and model-dependent thinking defaults/ranges. Both application
  requests use that field with JSON MIME type and retain local validation. No observed 400
  or other evidence here identifies an unsupported application parameter.
- [Current rate-limit documentation](https://ai.google.dev/gemini-api/docs/rate-limits)
  and [pricing](https://ai.google.dev/gemini-api/docs/pricing) must be checked for the chosen
  model and project/tier. No free-tier or pricing guarantee is made from cookbook examples.

`gemini-flash-latest` resolution remains unverified: no live API was called. A manual
metadata check may show an alias resource; only a returned generation modelVersion offers
request-specific resolved-model evidence. Failure to return it must remain unknown.

## Manual activation and rollback

1. Record current deployed commit, `GEMINI_MODEL` and execution/retry flag values securely.
   Confirm existing M1.4.1 schema and effective Vercel runtime (dashboard requests 60 seconds;
   planning uses 45 seconds, Researcher shares 30 seconds including optional 503 retry).
   No new migration, database reconciliation or data changes are required by this branch.
2. Before changing production, run local validation and then explicit metadata for the
   chosen candidate/key. Stop on visibility/auth/method failures. Check official pricing,
   tier and project quotas independently; metadata is not that verification.
3. If authorized after cost review, run exactly one synthetic command locally. Inspect
   operation, status, evidence, request count, elapsed time and resolved model if returned.
   On 503, 429 or timeout, do not script retries, switch models automatically or change
   task counters. Investigate the corresponding access/quota/provider/network evidence.
4. Only if justified, manually update server-side `GEMINI_MODEL` in Vercel. It affects BOTH
   Chief of Staff and Researcher. Keep all authorization flags and execution limits intact.
   Check `AGENT_CITY_RESEARCHER_503_RETRY_ENABLED`; leave false unless separately approved
   with its cost/runtime budget. The CLI never changes it or inherits its retry policy.
5. Redeploy manually after review. Verify the effective runtime, server-only credentials
   and absence of credentials in client assets/logs. This delivery performs no deployment.
6. Use one small, existing, owner-approved eligible Researcher task with an available
   attempt. Fresh owner authorization is mandatory and consumes an Agent City attempt,
   unlike the CLI. Confirm one authorization/run, bounded provider requests, atomic
   generated artifact, pending human review, provenance, and explicit accept/reject audit.
   Any planning acceptance test needs its own explicit owner authorization; never create
   missions automatically or reuse/reset exhausted attempts for testing.
7. If unsuccessful, disable new execution/retry if needed, restore the recorded model and
   redeploy the previous known-good configuration/application manually. Refresh ambiguous
   persistence outcomes and recover only expired runs through existing owner RPCs. Retain
   historical attempts, approvals and artifacts; no database rollback or reset is needed.

All development metadata/generation tests mock HTTP, including CLI subprocesses with
network blocked. Real project access, alias resolution, provider latency, billing and
hosted acceptance remain unverified until the operator performs these manual steps.
