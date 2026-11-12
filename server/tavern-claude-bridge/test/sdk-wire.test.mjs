import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeWire } from './probes/wire-normalize.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let capture;
let importLog;
before(async () => {
  // 探針在 import SDK 前清掉繼承憑證，僅使用假 OAuth + loopback 上游。
  const output = path.join(root, 'node_modules/.sdk-wire-lab/tests', `${Date.now()}-${process.pid}`);
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--no-warnings', '--loader', './test/probes/sdk-import-observer.mjs',
    'test/probes/sdk-wire-probe.mjs',
    'route', output,
  ], { cwd: root, timeout: 60000, windowsHide: true });
  assert.match(stdout, /本機假回應/);
  importLog = stdout;
  capture = JSON.parse(await fs.readFile(path.join(output, 'capture.json'), 'utf8'));
});

test('the next SDK is first imported only after both old-model requests complete', () => {
  assert.equal(importLog.split('TCB_TEST_NEXT_SDK_IMPORT').length - 1, 1);
  assert.ok(importLog.indexOf('TCB_TEST_NEXT_SDK_IMPORT') > importLog.indexOf('"model":"claude-fable-5-1"'));
});

for (const model of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5-2']) {
  test(`real bridge and installed SDK preserve the ${model} role card through loopback`, () => {
    const run = capture.runs.find(r => r.model === model);
    const requests = run.requests.filter(r => r.url.startsWith('/v1/messages'));
    assert.equal(requests.length, 1);
    const body = requests[0].body;
    assert.equal(body.model, model);
    assert.ok(body.system.some(block => block.text === run.input.messages[0].content));
    assert.ok(body.messages.some(m => m.content.some(block => block.text === run.input.messages[1].content)));
    assert.deepEqual(body.tools, []);
    assert.equal(JSON.parse(run.result.body).choices[0].message.content, '好');
    // 這兩格驗接線，不宣稱提示乾淨；污染判定要看完整 capture。
  });
}

for (const model of ['claude-opus-5-5', 'claude-fable-5-1']) {
  test(`${model} wire bytes match the pre-change bridge and SDK 0.3.280`, async () => {
    const run = capture.runs.find(r => r.model === model);
    const request = run.requests.find(r => r.url.startsWith('/v1/messages'));
    const before = await fs.readFile(path.join(root, `test/fixtures/${model}.0.3.280.body.txt`), 'utf8');
    assert.equal(normalizeWire(request.raw), before);
  });
}

test('Fable 5.2 really runs CLI 2.1.322 with minimal non-git environment and restored limits', () => {
  const request = capture.runs.find(r => r.model === 'claude-fable-5-2').requests.find(r => r.url.startsWith('/v1/messages'));
  assert.match(request.body.system[0].text, /cc_version=2\.1\.322/);
  const env = request.body.messages.flatMap(m => m.content).find(b => b.text?.startsWith('# Environment'))?.text;
  assert.ok(env);
  assert.match(env, /Is a git repository: false/);
  assert.doesNotMatch(env, /git worktree|git stash|bridge-fable52/);
  assert.match(env, /sdk-next-cwd/);
  assert.equal(request.body.max_tokens, 32000);
  assert.equal(request.body.output_config.effort, 'high');
  assert.deepEqual(request.body.thinking, { type: 'adaptive', display: 'omitted' });
});
