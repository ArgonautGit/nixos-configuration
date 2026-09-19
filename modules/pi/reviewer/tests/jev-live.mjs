// Opt-in live evaluation. Sends ONLY synthetic fixtures + configured rules to
// OpenRouter, uses pi-managed auth, incurs API usage, and executes NO tools.
// Node >= 24; PI_PACKAGE_DIR must point to the installed pi package root.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.argv[2], '--live', 'Explicit --live required (uses OpenRouter credits)');
const configDir = process.argv[3];
assert.ok(configDir, 'Pass the Nix-built reviewer extension directory');
// Exercise the built artifact, not the checkout: missing packaged imports must fail.
const built = file => pathToFileURL(join(configDir, 'lib', file)).href;
const { runReviewer } = await import(built('reviewer.ts'));
const { createState } = await import(built('state.ts'));
const { DEFAULT_CONFIG } = await import(built('config.ts'));
const { JEV_MODELS } = await import(built('models.ts'));
const root = process.env.PI_PACKAGE_DIR;
assert.ok(root, 'Set PI_PACKAGE_DIR to the installed pi package root');
const { ModelRuntime } = await import(pathToFileURL(join(root, 'dist/core/model-runtime.js')).href);
const { ModelRegistry } = await import(pathToFileURL(join(root, 'dist/core/model-registry.js')).href);
const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal: AbortSignal.timeout(15_000) });
const modelRegistry = new ModelRegistry(runtime);
const config = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) };
const model = JEV_MODELS.find(m => `${m.provider}/${m.id}` === config.reviewerModel);
assert.ok(model, 'The built configuration must select a supported Jev model');
const rules = readFileSync(join(configDir, 'rules.md'), 'utf8');
const cases = JSON.parse(readFileSync(new URL('./behavior-cases.json', import.meta.url), 'utf8'));
let failures = 0;
for (const fixture of cases) {
  const entries = fixture.messages.map(([role, content]) => role === 'reviewerDecision'
    ? { type: 'custom', customType: 'reviewer-decision', data: content }
    : { type: 'message', message: { role, content } });
  const ctx = { cwd: '/etc/nixos', modelRegistry,
    sessionManager: { buildContextEntries: () => entries },
  };
  const start = Date.now();
  const verdict = await runReviewer(ctx, createState(), config, rules, model, fixture.tool, fixture.input);
  const pass = verdict.source === 'reviewer' && verdict.decision === fixture.expected;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${fixture.name}: ${verdict.decision} (expected ${fixture.expected}, ${Date.now() - start}ms) — ${verdict.reason}`);
  if (verdict.source === 'fail-closed') {
    // Stop on transport/schema failures rather than spending credits on the rest.
    console.error('Stopping: live API integration failed; remaining cases not run.');
    process.exitCode = 1;
    break;
  }
}
if (failures) process.exitCode = 1;
