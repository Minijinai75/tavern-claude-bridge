// 本機取證：真橋 → 真 SDK/CLI → 127.0.0.1 假上游。沒有可用的遠端憑證。
// node test/probes/sdk-wire-probe.mjs <SDK package directory> <output directory> [default|disable-attachments|snapshot-off|safe-mode]
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const [sdkArg, outputArg, mode = 'default'] = process.argv.slice(2);
if (!sdkArg || !outputArg) throw new Error('需要 SDK 目錄與輸出目錄');
if (!['default', 'disable-attachments', 'snapshot-off', 'safe-mode', 'compat'].includes(mode)) throw new Error('未知測試模式');
const routed = sdkArg === 'route';
const sdkDir = path.resolve(routed ? 'node_modules/@anthropic-ai/claude-agent-sdk' : sdkArg);
const output = path.resolve(outputArg);
const account = {
  accountUuid: '11111111-1111-4111-8111-111111111111',
  emailAddress: 'wire-probe@example.invalid',
  organizationUuid: '22222222-2222-4222-8222-222222222222',
  organizationRole: 'admin', workspaceRole: 'workspace_admin',
  billingType: 'stripe_subscription', displayName: 'Wire Probe',
};
await fs.mkdir(output, { recursive: true });
const configDir = path.join(output, 'config');
// 各版本使用同一 cwd，避免把環境路徑差異誤認成 SDK 差異。
const cwd = path.resolve('node_modules/.sdk-wire-lab/empty-cwd');
await fs.mkdir(configDir, { recursive: true });
await fs.mkdir(cwd, { recursive: true });
await fs.writeFile(path.join(configDir, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true, oauthAccount: account,
}));
await fs.writeFile(path.join(configDir, '.credentials.json'), JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-NOT-A-REAL-TOKEN-local-wire-probe',
    refreshToken: 'NOT-A-REAL-REFRESH-TOKEN', expiresAt: Date.now() + 86400000,
    scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
    subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
  },
}));

// 白名單環境：不繼承任何 API key、OAuth token、provider、外部代理、Node preload。
const safeEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS)$/i.test(key)) safeEnv[key] = value;
}
Object.assign(safeEnv, {
  CLAUDE_CONFIG_DIR: configDir,
  CLAUDE_CODE_TMPDIR: path.join(output, 'tmp'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  TCB_NO_SDK_CHECK: '1',
  // 捕捉器若失效，任何需要代理的外連也只能撞本機關閉的埠。
  HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
  ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost',
  CLAUDE_CODE_MAX_RETRIES: '0',
});
if (mode === 'disable-attachments') safeEnv.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1';
// Bridge lockdownOptions() 複製 process.env；在 import 前也先換成白名單。
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, safeEnv);

const captures = [];
let currentCase = {};
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const n = captures.length + 1;
  // 完整 body 留本機；不記 Authorization 等 header。
  await fs.writeFile(path.join(output, `request-${n}.body.txt`), raw);
  let body;
  try { body = JSON.parse(raw); } catch { body = raw; }
  captures.push({ method: req.method, url: req.url, body, raw });
  if (!req.url.startsWith('/v1/messages')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }
  if (currentCase.error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'WIRE_PROBE_ERROR_400' } }));
    return;
  }
  const usage = mode === 'compat'
    ? { input_tokens: 17, output_tokens: 9, cache_creation_input_tokens: 100, cache_read_input_tokens: 200,
        cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 } }
    : { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const content = [
    ...(mode === 'compat' ? [{ type: 'thinking', thinking: '這是本機假的思考摘要', signature: 'wire-probe-signature' }] : []),
    { type: 'text', text: '好' },
  ];
  const message = {
    id: 'msg_local_wire_probe', type: 'message', role: 'assistant',
    model: body.model, content,
    stop_reason: 'end_turn', stop_sequence: null,
    usage,
  };
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(message));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    ...content.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index, delta: block.type === 'thinking' ? { type: 'thinking_delta', thinking: block.thinking } : { type: 'text_delta', text: block.text } },
      ...(block.type === 'thinking' ? [{ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } }] : []),
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
    { type: 'message_stop' },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;

const bridge = await import('../../index.mjs');
const sdk = await import(pathToFileURL(path.join(sdkDir, 'sdk.mjs')).href);
const pkg = JSON.parse(await fs.readFile(path.join(sdkDir, 'package.json'), 'utf8'));
let currentModel;
const aborters = [];
bridge._setQueryFn(routed ? sdk.query : ({ prompt, options }) => {
  const abortController = new AbortController();
  aborters.push(abortController);
  return sdk.query({ prompt, options: {
    ...options, cwd, abortController,
    ...(mode === 'snapshot-off' ? { systemPrompt: { type: 'custom', prompt: options.systemPrompt, snapshot: false } } : {}),
    ...(mode === 'safe-mode' ? { extraArgs: { 'safe-mode': null } } : {}),
    debugFile: path.join(output, `${currentModel}.debug.log`),
  } });
});
const server = http.createServer((req, res) => bridge.handleChatCompletions(req, res));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const summary = {
  sdkVersion: routed ? 'routed (0.3.280 / 0.3.322)' : pkg.version, cliVersion: pkg.claudeCodeVersion, mode,
  auth: 'isolated synthetic subscription profile; fake OAuth tokens only',
  bridgePort: server.address().port, upstreamPort: upstream.address().port,
  runs: [],
};
try {
  const cases = mode === 'compat'
    ? [
        { stream: false, thinking: false, effort: 'auto' },
        { stream: false, thinking: true, effort: 'low' },
        { stream: true, thinking: false, effort: 'medium' },
        { stream: true, thinking: true, effort: 'max' },
        { stream: false, error: true },
        { stream: true, error: true },
      ].map(c => ({ model: 'claude-fable-5-2', ...c }))
    : ['claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5-2'].map(model => ({ model }));
  for (const scenario of cases) {
    currentCase = scenario;
    const { model, stream = false, thinking = false, effort = 'auto' } = scenario;
    bridge.applyConfig({ thinking, effort });
    currentModel = model;
    const start = captures.length;
    const input = { model, stream, messages: [
      { role: 'system', content: '你是虛構角色小舟，在湖邊經營茶屋。保持角色，只用繁體中文簡短回答。' },
      { role: 'user', content: '請只回一個字：好' },
    ] };
    let result;
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input), signal: AbortSignal.timeout(45000),
      });
      result = { status: response.status, body: await response.text() };
    } catch (error) {
      result = { error: String(error) };
      for (const controller of aborters) controller.abort();
    }
    summary.runs.push({ model, scenario, input, result, cache: bridge.cacheSummary(), requests: captures.slice(start) });
    await fs.writeFile(path.join(output, 'capture.json'), JSON.stringify(summary, null, 2));
    const modelRequests = captures.slice(start).filter(r => r.url.startsWith('/v1/messages'));
    // CLI 會對 400 另試拿掉 beta／思考參數；錯誤案例只打本機，保留每次 body 供查驗。
    if (scenario.error) assert.ok(modelRequests.length >= 1);
    else assert.equal(modelRequests.length, 1, '每個模型必須剛好收到一發本機 messages 請求');
    if (!scenario.error) {
      assert.equal(result.status, 200, '橋必須成功讀取假上游回應');
      if (stream) assert.match(result.body, /"content":"好"/);
      else assert.equal(JSON.parse(result.body).choices[0].message.content, '好');
    }
    assert.equal(modelRequests[0].body.model, model, 'SDK 不得偷偷換模型');
    console.log(JSON.stringify({ sdk: summary.sdkVersion, model, scenario, captureCount: modelRequests.length, reply: '本機假回應' }));
  }
} finally {
  for (const controller of aborters) controller.abort();
  server.closeAllConnections(); server.close();
  upstream.closeAllConnections(); upstream.close();
  await bridge.exit();
}
