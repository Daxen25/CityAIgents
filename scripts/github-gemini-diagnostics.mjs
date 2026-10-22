/** GitHub-only adapter: fixed npm commands, no direct provider or database requests. */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function dispatchEnvironment(env, read = readFileSync) {
  const event = JSON.parse(read(env.GITHUB_EVENT_PATH, 'utf8'));
  const inputs = event?.inputs;
  return { ...env, DIAGNOSTIC_OPERATION: inputs?.operation, GEMINI_MODEL: inputs?.GEMINI_MODEL,
    ACKNOWLEDGE_API_CHARGES: typeof inputs?.acknowledge_api_charges === 'boolean' ? String(inputs.acknowledge_api_charges) : inputs?.acknowledge_api_charges };
}
export function validateInputs(env) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REPOSITORY !== 'Daxen25/CityAIgents' ||
      env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_RUN_ATTEMPT !== '1') throw new Error('untrusted_dispatch_context');
  if (!['validate', 'metadata', 'generate'].includes(env.DIAGNOSTIC_OPERATION)) throw new Error('invalid_operation');
  if (typeof env.GEMINI_MODEL !== 'string' || env.GEMINI_MODEL.length > 100 || !/^gemini-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(env.GEMINI_MODEL)) throw new Error('invalid_model');
  if (!['true', 'false'].includes(env.ACKNOWLEDGE_API_CHARGES)) throw new Error('invalid_acknowledgment');
  if ((env.DIAGNOSTIC_OPERATION === 'generate') !== (env.ACKNOWLEDGE_API_CHARGES === 'true')) throw new Error('invalid_acknowledgment');
  return { operation: env.DIAGNOSTIC_OPERATION, model: env.GEMINI_MODEL };
}
export function commandFor(operation) {
  if (operation === 'validate') return ['run', '--silent', 'diagnose:gemini'];
  if (operation === 'metadata') return ['run', '--silent', 'diagnose:gemini', '--', '--metadata'];
  if (operation === 'generate') return ['run', '--silent', 'diagnose:gemini', '--', '--generate', '--acknowledge-api-charges'];
  throw new Error('invalid_operation');
}
const failures = new Set(['invalid_arguments', 'charge_acknowledgment_required', 'missing_or_invalid_credentials', 'invalid_model_configuration',
  'invalid_metadata', 'generate_content_unsupported', 'timeout', 'provider_error', 'invalid_output', 'transport_or_metadata_error', 'diagnostic_unavailable',
  'invalid_request_or_schema', 'authentication', 'permission_denied', 'model_or_endpoint_unavailable', 'quota_or_rate_limit', 'server_error', 'http_error']);
const evidenceValues = new Set(['official_model_documentation_not_project_verified', 'visible_in_model_metadata', 'supported_in_metadata', 'unsupported_in_metadata',
  'reachable_for_this_generation', 'succeeded_for_this_request', 'synthetic_schema_only', 'not_visible_or_unavailable', 'quota_or_rate_limit_response_observed']);
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const failed = (operation, failureClass) => ({ operation, outcome: 'failed', failureClass });

export function sanitizeResult(stdout, operation, secret = '') {
  const expected = operation === 'validate' ? 'local' : operation === 'generate' ? 'generation' : 'metadata';
  const fallback = failed(expected, 'invalid_diagnostic_result');
  let input;
  try { input = JSON.parse(stdout); } catch { return fallback; }
  if (!input || input.operation !== expected || !['failed', operation === 'validate' ? 'valid' : 'succeeded'].includes(input.outcome) ||
      !integer(input.networkRequests, 0, operation === 'validate' ? 0 : 1) ||
      !integer(input.generationRequests, 0, operation === 'generate' ? 1 : 0) || input.generationRequests > input.networkRequests ||
      (input.outcome === 'succeeded' && (input.networkRequests !== 1 || input.generationRequests !== (operation === 'generate' ? 1 : 0)))) return fallback;
  const safe = { operation: expected, outcome: input.outcome, networkRequests: input.networkRequests, generationRequests: input.generationRequests };
  if (input.httpStatus === null || integer(input.httpStatus, 100, 599)) safe.httpStatus = input.httpStatus;
  if (integer(input.elapsedMs, 0, 300_000)) safe.elapsedMs = input.elapsedMs;
  if (failures.has(input.failureClass)) safe.failureClass = input.failureClass;
  if (['application_deadline', 'transport_timeout', 'transport_error'].includes(input.timeoutSource)) safe.timeoutSource = input.timeoutSource;
  if (['response_headers', 'response_body'].includes(input.transportPhase)) safe.transportPhase = input.transportPhase;
  for (const key of ['requestedModel', 'resolvedModel', 'metadataModel', 'metadataVersion']) {
    const value = input[key];
    const pattern = key === 'metadataVersion' ? /^[A-Za-z0-9._-]{1,100}$/ : /^gemini-[A-Za-z0-9][A-Za-z0-9._-]{0,92}$/;
    if (typeof value === 'string' && pattern.test(value) && (!secret || !value.includes(secret))) safe[key] = value;
  }
  for (const key of ['inputTokenLimit', 'outputTokenLimit']) if (integer(input[key], 0, Number.MAX_SAFE_INTEGER)) safe[key] = input[key];
  for (const key of ['visibility', 'generateContent', 'structuredOutput', 'quota', 'freeTier', 'pricing']) {
    const evidence = input[key];
    safe[key] = evidence && ['verified', 'documented'].includes(evidence.status) && evidenceValues.has(evidence.value)
      ? { status: evidence.status, value: evidence.value } : { status: 'unknown' };
  }
  return safe;
}

export function runRemoteDiagnostic(env, dependencies = {}) {
  const write = dependencies.write ?? (text => process.stdout.write(text));
  const append = dependencies.append ?? appendFileSync;
  let inputs;
  try { inputs = validateInputs(env); } catch {
    write(JSON.stringify(failed('validation', 'invalid_inputs_or_context')) + '\n');
    return 1;
  }
  let result; let exitCode = 1;
  try {
    const child = (dependencies.spawn ?? spawnSync)('npm', commandFor(inputs.operation), {
      env: { ...env, GEMINI_MODEL: inputs.model }, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024, shell: false,
    });
    // Never forward npm stdout/stderr or exception objects, even on startup failures.
    if (child.error || child.status === null) result = failed(inputs.operation, child.error?.code === 'ETIMEDOUT' ? 'runner_timeout' : 'runner_unavailable');
    else {
      result = sanitizeResult(child.stdout, inputs.operation, env.GEMINI_API_KEY?.trim());
      exitCode = child.status === 0 && result.outcome !== 'failed' ? 0 : 1;
      if (child.status !== 0 && result.outcome !== 'failed') result = failed(inputs.operation, 'diagnostic_process_failed');
    }
  } catch { result = failed(inputs.operation, 'runner_unavailable'); }
  const serialized = JSON.stringify(result);
  write(serialized + '\n');
  if (env.GITHUB_STEP_SUMMARY) {
    try { append(env.GITHUB_STEP_SUMMARY, '## Gemini diagnostic\n\n```json\n' + JSON.stringify(result, null, 2) + '\n```\n'); }
    catch { write(JSON.stringify(failed(inputs.operation, 'summary_unavailable')) + '\n'); return 1; }
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = dispatchEnvironment(process.env);
    if (process.argv.length === 3 && process.argv[2] === '--validate-inputs') {
      validateInputs(env); process.stdout.write('{"inputValidation":"passed"}\n');
    } else if (process.argv.length === 2) process.exitCode = runRemoteDiagnostic(env);
    else throw new Error('invalid_arguments');
  } catch {
    process.stdout.write('{"inputValidation":"failed"}\n');
    if (process.env.GITHUB_STEP_SUMMARY) {
      try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Gemini diagnostic\n\nInput validation failed; no diagnostic request was made.\n'); } catch { /* no raw errors */ }
    }
    process.exitCode = 1;
  }
}
