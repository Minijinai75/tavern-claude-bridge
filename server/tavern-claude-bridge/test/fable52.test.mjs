import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  priceFor, minCacheTokensFor, cjkTokensPerChar, meetsCacheMinimum, cacheRoi,
} from '../cache-breakpoint.mjs';

test('Fable 5.2 uses official base prices and 1h cache rates, including suffixed IDs', () => {
  for (const id of ['claude-fable-5-2', 'claude-fable-5-2[1m]', 'claude-fable-5-2-20261109']) {
    assert.deepEqual(priceFor(id), { model: 'claude-fable-5-2', input: 8, output: 40, cacheWrite: 16, cacheRead: 0.2 });
  }
});

test('Fable 5.2 cache threshold is 512 tokens and admits a sufficiently long prefix', () => {
  for (const id of ['claude-fable-5-2', 'claude-fable-5-2[1m]']) {
    assert.equal(minCacheTokensFor(id), 512);
    assert.equal(meetsCacheMinimum('字'.repeat(568), id), false);
    assert.equal(meetsCacheMinimum('字'.repeat(569), id), true);
    assert.equal(cjkTokensPerChar(id), 1);
  }
});

test('Fable 5.2 ROI uses its own dollar amounts', () => {
  const roi = cacheRoi([{ cacheWrite: 1e6 }, { cacheRead: 1e6 }], { modelId: 'claude-fable-5-2' });
  assert.equal(roi.priceModel, 'claude-fable-5-2');
  assert.equal(roi.extraUsd, 8);
  assert.equal(roi.savedUsd, 7.8);
});

test('existing Fable and Opus prices and unknown-model handling stay unchanged', () => {
  assert.deepEqual(priceFor('claude-fable-5-1'), { model: 'claude-fable-5-1', input: 10, output: 50, cacheWrite: 20, cacheRead: 0.25 });
  assert.deepEqual(priceFor('claude-fable-5'), { model: 'claude-fable-5', input: 10, output: 50, cacheWrite: 20, cacheRead: 1 });
  assert.deepEqual(priceFor('claude-opus-4-6[1m]'), { model: 'claude-opus-4-6', input: 5, output: 25, cacheWrite: 10, cacheRead: 0.5 });
  assert.equal(priceFor('unknown-model'), null);
  assert.equal(minCacheTokensFor('unknown-model'), 4096);
});

test('the bridge advertises Fable 5.2 before the older Fable models', () => {
  // Evaluate the shipped data literal without initializing the SDK or binding port 5199.
  const source = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
  const literal = source.match(/const MODELS = (\[[\s\S]*?\n\]);/);
  assert.ok(literal);
  const ids = vm.runInNewContext(literal[1]).map(m => m.id);
  assert.ok(ids.indexOf('claude-fable-5-2') >= 0);
  assert.ok(ids.indexOf('claude-fable-5-2') < ids.indexOf('claude-fable-5-1'));
  assert.ok(ids.indexOf('claude-fable-5-1') < ids.indexOf('claude-fable-5'));
});
