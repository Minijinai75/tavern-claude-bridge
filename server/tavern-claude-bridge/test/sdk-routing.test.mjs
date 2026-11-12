import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as bridge from '../index.mjs';

test('only Fable 5.2 and its context/date suffixes need the next SDK', () => {
  assert.equal(typeof bridge.needsNewSdk, 'function');
  for (const model of ['claude-fable-5-2', 'claude-fable-5-2[1m]', 'claude-fable-5-2-20261109']) {
    assert.equal(bridge.needsNewSdk(model), true, model);
  }
  for (const model of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-fable-5-20', '', null]) {
    assert.equal(bridge.needsNewSdk(model), false, String(model));
  }
});

test('old-model query options retain their original values and property order', () => {
  bridge.applyConfig({ thinking: false, effort: 'auto' });
  for (const model of ['claude-opus-5-5', 'claude-fable-5-1']) {
    const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    for (const stream of [false, true]) {
      assert.equal(JSON.stringify(bridge.buildQueryOptions(model, '角色卡', { stream })), JSON.stringify({
        systemPrompt: '角色卡', tools: [], disallowedTools: ['WebSearch', 'WebFetch'], maxTurns: 1,
        permissionMode: 'dontAsk', settingSources: [], verbatimPrompts: true, strictMcpConfig: true, env,
        title: 'SillyTavern bridge', model, persistSession: true,
        ...(stream ? { includePartialMessages: true } : {}), thinking: { type: 'disabled' },
      }));
    }
  }
});

test('next SDK uses an empty cwd and keeps the old Fable output limit and effort', () => {
  bridge.applyConfig({ thinking: false, effort: 'auto' });
  const opts = bridge.buildQueryOptions('claude-fable-5-2', '角色卡');
  assert.match(opts.cwd || '', /sdk-next-cwd$/);
  assert.equal(opts.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '32000');
  assert.equal(opts.effort, 'high');
  assert.deepEqual(opts.thinking, { type: 'adaptive', display: 'omitted' });
  bridge.applyConfig({ thinking: true, effort: 'low' });
  const on = bridge.buildQueryOptions('claude-fable-5-2', '角色卡');
  assert.equal(on.effort, 'low');
  assert.deepEqual(on.thinking, { type: 'adaptive', display: 'summarized' });
  bridge.applyConfig({ thinking: false, effort: 'auto' });
});
