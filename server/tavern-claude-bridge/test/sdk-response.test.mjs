import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
let runs;
let importLog;
before(async () => {
  const output = path.join(root, 'node_modules/.sdk-wire-lab/compat', `${Date.now()}-${process.pid}`);
  const { stdout } = await promisify(execFile)(process.execPath, ['--no-warnings', '--loader', './test/probes/sdk-import-observer.mjs', 'test/probes/sdk-wire-probe.mjs', 'route', output, 'compat'], {
    cwd: root, timeout: 90000, windowsHide: true,
  });
  importLog = stdout;
  ({ runs } = JSON.parse(await fs.readFile(path.join(output, 'capture.json'), 'utf8')));
});

test('six Fable 5.2 requests share one lazy SDK import', () => {
  assert.equal(importLog.split('TCB_TEST_NEXT_SDK_IMPORT').length - 1, 1);
});

for (const stream of [false, true]) {
  for (const thinking of [false, true]) {
    test(`new SDK preserves text, reasoning visibility, usage and cache (stream=${stream}, thinking=${thinking})`, () => {
      const run = runs.find(r => !r.scenario.error && r.scenario.stream === stream && r.scenario.thinking === thinking);
      const wire = run.requests.find(r => r.url.startsWith('/v1/messages')).body;
      assert.match(wire.system[0].text, /cc_version=2\.1\.322/);
      assert.deepEqual(wire.thinking, { type: 'adaptive', display: thinking ? 'summarized' : 'omitted' });
      assert.equal(wire.output_config.effort, run.scenario.effort === 'auto' ? 'high' : run.scenario.effort);
      assert.deepEqual(wire.context_management, { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] });
      const prior = runs[runs.indexOf(run) - 1]?.cache;
      assert.equal(run.cache.input - (prior?.input || 0), 17);
      assert.equal(run.cache.output - (prior?.output || 0), 9);
      assert.equal(run.cache.cacheRead - (prior?.cacheRead || 0), 200);
      assert.equal(run.cache.cacheWrite - (prior?.cacheWrite || 0), 100);
      assert.equal(run.cache.cacheTimer.ttlSec, 3600);
      if (stream) {
        const chunks = run.result.body.split('\n').filter(s => s.startsWith('data: {')).map(s => JSON.parse(s.slice(6)));
        assert.equal(chunks.map(c => c.choices[0].delta.content || '').join(''), '好');
        assert.equal(chunks.map(c => c.choices[0].delta.reasoning_content || '').join(''), thinking ? '這是本機假的思考摘要' : '');
        assert.match(run.result.body, /data: \[DONE\]/);
      } else {
        const body = JSON.parse(run.result.body);
        assert.equal(body.choices[0].message.reasoning_content, thinking ? '這是本機假的思考摘要' : undefined);
        assert.equal(body.usage.prompt_tokens, 17);
        assert.equal(body.usage.completion_tokens, 9);
        assert.equal(body.usage.prompt_tokens_details.cached_tokens, 200);
        assert.equal(body.usage.cache['usage.cache_creation_input_tokens'], 100);
      }
    });
  }
  test(`new SDK upstream error text reaches the client (stream=${stream})`, () => {
    const run = runs.find(r => r.scenario.error && r.scenario.stream === stream);
    assert.match(run.result.body, /WIRE_PROBE_ERROR_400/);
    if (stream) assert.match(run.result.body, /data: \[DONE\]/);
  });
}
