import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PLUGIN_ID = 'tavern-claude-bridge';
const DEFAULT_PORT = 5199;
const HOST = '127.0.0.1';

let bridgeServer = null;
let queryFn = null;
let busy = false;
let totalCostUsd = 0;
let requestCount = 0;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const MODELS = [
  { id: 'sonnet', object: 'model', owned_by: 'anthropic' },
  { id: 'opus', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-fable-5', object: 'model', owned_by: 'anthropic' },
  { id: 'haiku', object: 'model', owned_by: 'anthropic' },
];

function parseMessages(messages) {
  const systemParts = [];
  const chatHistory = [];

  for (const msg of messages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map(p => p.text || '').join('')
        : '';

    if (msg.role === 'system') {
      systemParts.push(content);
    } else {
      chatHistory.push({ role: msg.role, content });
    }
  }

  const systemPrompt = systemParts.join('\n\n') || undefined;

  let prompt;
  if (chatHistory.length === 0) {
    prompt = '(empty message)';
  } else if (chatHistory.length === 1) {
    prompt = chatHistory[0].content;
  } else {
    const lastMsg = chatHistory[chatHistory.length - 1];
    const history = chatHistory.slice(0, -1);
    const historyText = history.map(m => {
      const tag = m.role === 'user' ? 'user' : 'reply';
      return `<${tag}>\n${m.content}\n</${tag}>`;
    }).join('\n');

    prompt = `<history>\n${historyText}\n</history>\n\n${lastMsg.content}`;
  }

  return { systemPrompt, prompt };
}

function makeChunk(id, model, delta, finishReason) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason || null,
    }],
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    function finish(fn, val) { if (!settled) { settled = true; fn(val); } }
    req.on('data', c => {
      if (settled) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      bytes += buf.length;
      if (bytes > MAX_BODY_BYTES) {
        finish(reject, new Error('oversized'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(resolve, null));
  });
}

function humanError(err) {
  const msg = err.message || String(err);
  if (/not.?authenticated|login|log.?in/i.test(msg)) {
    return 'Claude Code 尚未登入。請在終端機執行 claude login 完成訂閱登入後重啟 SillyTavern。';
  }
  if (/rate.?limit|too.?many|quota|exceeded/i.test(msg)) {
    return '額度已達上限或請求太頻繁。稍後再試，或到 claude.ai Settings → Usage 查看額度。';
  }
  if (/overloaded|capacity/i.test(msg)) {
    return 'Claude 伺服器忙碌中，稍後再試。';
  }
  if (/ENOENT|not.?found|command.?not/i.test(msg)) {
    return '找不到 Claude Code CLI。請確認已安裝 Claude Code（npm install -g @anthropic-ai/claude-code）並完成登入。';
  }
  return msg;
}

async function handleChatCompletions(req, res) {
  if (!queryFn) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: 'SDK 未載入。請在 plugins/tavern-claude-bridge/ 執行 npm install 後重啟。',
        type: 'server_error',
      },
    }));
    return;
  }

  if (busy) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: '正在處理其他請求，一次只能一個。稍後再試。',
        type: 'rate_limit',
      },
    }));
    return;
  }

  busy = true;
  try {
    let body;
    try {
      body = await readBody(req);
    } catch {
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Request body too large (max 4MB)', type: 'invalid_request' } }), () => req.destroy());
      } else {
        req.destroy();
      }
      return;
    }
    if (body === null) return;

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request' } }));
      }
      return;
    }

    const { messages, model: requestModel, stream } = parsed;

    if (!Array.isArray(messages)) {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'messages must be an array', type: 'invalid_request' } }));
      }
      return;
    }

    const modelId = requestModel || 'sonnet';
    const { systemPrompt, prompt } = parseMessages(messages);
    const completionId = `chatcmpl-${randomUUID().slice(0, 8)}`;

    if (stream === false) {
      try {
        let fullText = '';
        let costUsd = 0;
        const q = queryFn({
          prompt,
          options: {
            systemPrompt,
            tools: [],
            maxTurns: 1,
            model: modelId,
            permissionMode: 'dontAsk',
            persistSession: false,
            settingSources: [],
          },
        });

        for await (const msg of q) {
          if (msg.type === 'assistant') {
            fullText += msg.message?.content
              ?.filter(b => b.type === 'text')
              .map(b => b.text)
              .join('') || '';
          } else if (msg.type === 'result') {
            costUsd = Number(msg.cost_usd) || 0;
          }
        }

        let usage;
        try { usage = await q.usage_EXPERIMENTAL(); } catch {}

        requestCount++;
        totalCostUsd += costUsd;
        console.log(`[${PLUGIN_ID}][${requestCount}] model=${modelId} cost=$${costUsd.toFixed(4)} total=$${totalCostUsd.toFixed(4)}${usage ? ` in=${usage.input_tokens} out=${usage.output_tokens}` : ''}`);

        const responseBody = {
          id: completionId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: fullText },
            finish_reason: 'stop',
          }],
        };
        if (usage) {
          responseBody.usage = {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
          };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseBody));
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: humanError(err), type: 'server_error' } }));
        }
      }
      return;
    }

    // 串流模式（預設）
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const roleChunk = makeChunk(completionId, modelId, { role: 'assistant', content: '' }, null);
    res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

    let aborted = false;
    const q = queryFn({
      prompt,
      options: {
        systemPrompt,
        tools: [],
        maxTurns: 1,
        model: modelId,
        permissionMode: 'dontAsk',
        persistSession: false,
        includePartialMessages: true,
        settingSources: [],
      },
    });

    res.on('close', () => {
      if (!aborted) {
        aborted = true;
        q.return?.();
        console.log(`[${PLUGIN_ID}] Client disconnected, aborting generation.`);
      }
    });

    try {
      let costUsd = 0;
      for await (const msg of q) {
        if (aborted) break;
        if (msg.type === 'stream_event') {
          const event = msg.event;
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const textChunk = makeChunk(completionId, modelId, { content: event.delta.text }, null);
            if (!aborted) res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
          }
        } else if (msg.type === 'result') {
          costUsd = Number(msg.cost_usd) || 0;
        }
      }

      let usage;
      try { usage = await q.usage_EXPERIMENTAL(); } catch {}

      requestCount++;
      totalCostUsd += costUsd;
      console.log(`[${PLUGIN_ID}][${requestCount}] model=${modelId} cost=$${costUsd.toFixed(4)} total=$${totalCostUsd.toFixed(4)}${usage ? ` in=${usage.input_tokens} out=${usage.output_tokens}` : ''}${aborted ? ' (aborted)' : ''}`);

      if (!aborted) {
        const stopChunk = makeChunk(completionId, modelId, {}, 'stop');
        res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch (err) {
      if (!aborted) {
        const errChunk = makeChunk(completionId, modelId, { content: `\n\n[${humanError(err)}]` }, 'stop');
        res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: humanError(err), type: 'server_error' } }));
    }
  } finally {
    busy = false;
  }
}

function startBridge(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      req.on('error', () => {});
      res.on('error', () => {});

      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', busy, requestCount, totalCostUsd }));
          return;
        }

        if (req.method === 'GET' && req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: MODELS }));
          return;
        }

        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
          await handleChatCompletions(req, res);
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Not found', type: 'not_found' } }));
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Internal server error', type: 'server_error' } }));
        }
      }
    });

    server.on('clientError', (err, socket) => {
      if (socket.writable) socket.destroy();
    });

    server.listen(port, HOST, () => {
      console.log(`[${PLUGIN_ID}] Bridge running at http://${HOST}:${port}`);
      resolve(server);
    });

    server.on('error', reject);
  });
}

const info = {
  id: PLUGIN_ID,
  name: 'Claude Bridge',
  description: 'Bridges SillyTavern to Claude via official Agent SDK and local subscription auth.',
  version: '1.0.0',
};

async function init(router) {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    queryFn = sdk.query;
    console.log(`[${PLUGIN_ID}] SDK loaded.`);
  } catch (err) {
    console.error(`[${PLUGIN_ID}] SDK not found: ${err.message}`);
    console.error(`[${PLUGIN_ID}] Run "npm install" in plugins/${PLUGIN_ID}/ and restart.`);
  }

  try {
    bridgeServer = await startBridge(DEFAULT_PORT);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`[${PLUGIN_ID}] Port ${DEFAULT_PORT} is already in use. Bridge not started.`);
    } else {
      console.error(`[${PLUGIN_ID}] Bridge failed to start: ${err.message}`);
    }
  }

  router.get('/status', (_req, res) => {
    res.json({
      ok: true,
      plugin: PLUGIN_ID,
      version: info.version,
      bridge: bridgeServer
        ? { running: true, host: HOST, port: DEFAULT_PORT, busy, requestCount, totalCostUsd, models: MODELS.map(m => m.id) }
        : { running: false },
      sdkAvailable: Boolean(queryFn),
    });
  });

  console.log(`[${PLUGIN_ID}] Plugin initialized.`);
}

async function exit() {
  if (bridgeServer) {
    bridgeServer.close();
    bridgeServer = null;
    console.log(`[${PLUGIN_ID}] Bridge stopped.`);
  }
}

export { info, init, exit };
