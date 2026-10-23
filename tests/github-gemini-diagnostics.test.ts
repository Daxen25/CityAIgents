import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dispatchEnvironment, validateInputs, commandFor, sanitizeResult, runRemoteDiagnostic } from '../scripts/github-gemini-diagnostics.mjs';
import { runGeminiDiagnostic } from '../scripts/lib/gemini-diagnostics';
const secret = 'fixture-private-key';
const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'Daxen25/CityAIgents', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ATTEMPT: '1', DIAGNOSTIC_OPERATION: 'validate', GEMINI_MODEL: 'gemini-3.6-flash', ACKNOWLEDGE_API_CHARGES: 'false', GEMINI_API_KEY: secret, GITHUB_STEP_SUMMARY: '/fixture-summary' };
const model = { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] };
const generated = { modelVersion: 'gemini-3.6-flash-001', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"status":"ok"}' }] } }] };
function assertSafe(logs: string) {
  for (const value of [secret, 'private prompt', 'raw-provider-response', '::error::malicious']) assert.ok(!logs.includes(value), value);
}
function basic(operation = 'local') {
  return { operation, outcome: operation === 'local' ? 'valid' : 'succeeded', networkRequests: operation === 'local' ? 0 : 1, generationRequests: operation === 'generation' ? 1 : 0, elapsedMs: 10, httpStatus: operation === 'local' ? null : 200 };
}

test('only first manual main dispatch in the canonical repository is trusted', () => {
  assert.equal(validateInputs(env).operation, 'validate');
  for (const overrides of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/pull/10/merge' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REPOSITORY: 'fork/CityAIgents' }, { GITHUB_RUN_ATTEMPT: '2' }]) {
    let spawns = 0; const logs: string[] = [];
    assert.equal(runRemoteDiagnostic({ ...env, ...overrides }, { spawn: () => { spawns++; }, write: (s: string) => logs.push(s) }), 1);
    assert.equal(spawns, 0); assertSafe(logs.join(''));
  }
});

test('operation, model and separate generation acknowledgment are strict and injection-safe', () => {
  for (const overrides of [{ DIAGNOSTIC_OPERATION: 'metadata; echo private prompt' }, { DIAGNOSTIC_OPERATION: '' }, { GEMINI_MODEL: 'gemini-foo; echo private prompt' }, { GEMINI_MODEL: '$(echo private prompt)' }, { GEMINI_MODEL: 'gemini-foo\nprivate prompt' }, { GEMINI_MODEL: 'models/gemini-3.6-flash' }, { GEMINI_MODEL: '' }, { GEMINI_MODEL: 'gemini-' + 'x'.repeat(100) }, { ACKNOWLEDGE_API_CHARGES: 'yes' }, { ACKNOWLEDGE_API_CHARGES: '' }, { ACKNOWLEDGE_API_CHARGES: 'true' }, { DIAGNOSTIC_OPERATION: 'generate', ACKNOWLEDGE_API_CHARGES: 'false' }]) {
    let spawns = 0; const logs: string[] = [];
    assert.equal(runRemoteDiagnostic({ ...env, ...overrides }, { spawn: () => { spawns++; }, write: (s: string) => logs.push(s) }), 1);
    assert.equal(spawns, 0); assertSafe(logs.join(''));
  }
  assert.deepEqual(commandFor('validate'), ['run', '--silent', 'diagnose:gemini']);
  assert.deepEqual(commandFor('metadata'), ['run', '--silent', 'diagnose:gemini', '--', '--metadata']);
  assert.deepEqual(commandFor('generate'), ['run', '--silent', 'diagnose:gemini', '--', '--generate', '--acknowledge-api-charges']);
  assert.throws(() => commandFor('other'));
});

test('inputs are read from the dispatch payload, not interpolated into a shell or echoed env', () => {
  const dispatched = dispatchEnvironment(env, () => JSON.stringify({ inputs: { operation: 'generate', GEMINI_MODEL: 'gemini-configurable-model', acknowledge_api_charges: true, GITHUB_REF: 'refs/heads/evil' } }));
  assert.deepEqual(validateInputs(dispatched), { operation: 'generate', model: 'gemini-configurable-model' });
  assert.equal(dispatched.GITHUB_REF, 'refs/heads/main');
  assert.throws(() => validateInputs(dispatchEnvironment(env, () => '{"inputs":{}}')));
  assert.throws(() => dispatchEnvironment(env, () => 'private prompt'));
});

test('all operations invoke existing npm CLI once with secret only in child env; summaries contain only sanitized output', async () => {
  for (const operation of ['validate', 'metadata', 'generate']) {
    let providerRequests = 0;
    const args = commandFor(operation).slice(4);
    const cli = await runGeminiDiagnostic(args, env, { transport: async () => { providerRequests++; return Response.json(operation === 'generate' ? generated : model); } });
    const current = { ...env, DIAGNOSTIC_OPERATION: operation, ACKNOWLEDGE_API_CHARGES: operation === 'generate' ? 'true' : 'false' };
    let spawns = 0; const logs: string[] = []; const summaries: string[] = [];
    const status = runRemoteDiagnostic(current, { spawn: (command: string, actual: string[], options: any) => {
      spawns++; assert.equal(command, 'npm'); assert.deepEqual(actual, commandFor(operation)); assert.equal(options.shell, false); assert.equal(options.timeout, 30000);
      assert.equal(options.env.GEMINI_API_KEY, secret); assert.equal(options.env.GEMINI_MODEL, env.GEMINI_MODEL); assert.ok(!actual.join(' ').includes(secret));
      return { status: cli.exitCode, stdout: JSON.stringify({ ...cli.result, prompt: 'private prompt', response: 'raw-provider-response' }), stderr: secret };
    }, write: (s: string) => logs.push(s), append: (path: string, s: string) => { assert.equal(path, env.GITHUB_STEP_SUMMARY); summaries.push(s); } });
    assert.equal(status, 0); assert.equal(spawns, 1); assert.equal(providerRequests, operation === 'validate' ? 0 : 1);
    const result = JSON.parse(logs[0]); assert.equal(result.operation, operation === 'validate' ? 'local' : operation === 'generate' ? 'generation' : 'metadata');
    assert.equal(summaries.length, 1); assertSafe(logs.join('') + summaries.join(''));
  }
});

test('untrusted/raw process output and errors cannot reach logs or summary', () => {
  for (const stdout of [secret, '::error::malicious', '{not json ' + secret, JSON.stringify({ ...basic(), networkRequests: 2 }), JSON.stringify({ ...basic('generation'), generationRequests: 2 })]) {
    const result = sanitizeResult(stdout, 'validate', secret); assert.equal(result.failureClass, 'invalid_diagnostic_result'); assertSafe(JSON.stringify(result));
  }
  const result = sanitizeResult(JSON.stringify({ ...basic(), requestedModel: 'gemini-' + secret, metadataVersion: secret, failureClass: secret, timeoutSource: 'private prompt', visibility: { status: 'verified', value: 'raw-provider-response' }, raw: secret }), 'validate', secret);
  assert.equal(result.requestedModel, undefined); assert.deepEqual(result.visibility, { status: 'unknown' }); assertSafe(JSON.stringify(result));
  for (const child of [{ status: null, error: { code: 'ETIMEDOUT', message: secret }, stderr: secret }, { status: null, error: new Error(secret) }, { status: 1, stdout: secret, stderr: secret }]) {
    const logs: string[] = []; const summaries: string[] = [];
    assert.equal(runRemoteDiagnostic(env, { spawn: () => child, write: (s: string) => logs.push(s), append: (_p: string, s: string) => summaries.push(s) }), 1);
    assertSafe(logs.join('') + summaries.join(''));
  }
});

test('provider failure remains visible and never retries; runner/summary failures stay sanitized', async () => {
  const current = { ...env, DIAGNOSTIC_OPERATION: 'metadata' }; let requests = 0;
  const cli = await runGeminiDiagnostic(['--metadata'], env, { transport: async () => { requests++; return new Response('raw-provider-response', { status: 503 }); } });
  const logs: string[] = []; let spawns = 0;
  assert.equal(runRemoteDiagnostic(current, { spawn: () => { spawns++; return { status: 1, stdout: JSON.stringify(cli.result), stderr: secret }; }, write: (s: string) => logs.push(s), append: () => {} }), 1);
  assert.equal(spawns, 1); assert.equal(requests, 1); assert.equal(JSON.parse(logs[0]).httpStatus, 503); assert.equal(JSON.parse(logs[0]).failureClass, 'server_error'); assertSafe(logs.join(''));
  logs.length = 0;
  assert.equal(runRemoteDiagnostic(env, { spawn: () => { throw new Error(secret); }, write: (s: string) => logs.push(s), append: () => {} }), 1); assertSafe(logs.join(''));
  logs.length = 0;
  assert.equal(runRemoteDiagnostic(env, { spawn: () => ({ status: 0, stdout: JSON.stringify(basic()) }), write: (s: string) => logs.push(s), append: () => { throw new Error(secret); } }), 1); assertSafe(logs.join(''));
});

test('real preflight command needs no key/dependencies/provider requests and rejects raw bad inputs safely', () => {
  const directory = mkdtempSync(join(tmpdir(), 'github-gemini-'));
  try {
    const eventPath = join(directory, 'event.json');
    const summaryPath = join(directory, 'summary.md');
    for (const valid of [true, false]) {
      writeFileSync(eventPath, JSON.stringify({ inputs: { operation: valid ? 'metadata' : secret, GEMINI_MODEL: env.GEMINI_MODEL, acknowledge_api_charges: false } }));
      const child = spawnSync(process.execPath, ['--import', './tests/fixtures/gemini-diagnostics-no-network.mjs', 'scripts/github-gemini-diagnostics.mjs', '--validate-inputs'], { encoding: 'utf8', env: { ...env, GEMINI_API_KEY: '', GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: summaryPath } });
      assert.equal(child.status, valid ? 0 : 1); assert.equal(child.stderr, ''); assertSafe(child.stdout); assert.equal(JSON.parse(child.stdout).inputValidation, valid ? 'passed' : 'failed');
      if (!valid) { const summary = readFileSync(summaryPath, 'utf8'); assert.match(summary, /no diagnostic request was made/); assertSafe(summary); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
