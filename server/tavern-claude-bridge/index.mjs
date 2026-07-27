import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PLUGIN_ID = 'tavern-claude-bridge';
const DEFAULT_PORT = 5199;
const HOST = '127.0.0.1';

let bridgeServer = null;
let queryFn = null;
let current = null; // 正在跑的那一則；新請求進來會請它讓位
let totalCostUsd = 0;
let requestCount = 0;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// 讓前一則停下來。26-07-25 改：原本「同時只准一個、後來的回 429」，
// 在 RP 場景是錯的——玩家按重新生成/停止時，想要的是「換一則」不是「排隊」，
// 而酒館超時斷線後舊的還在跑，重試就一直吃 429（Mini 26-07-25 實際踩到）。
// interrupt() 官方註明只在串流輸入模式可用（我們是單次字串輸入），所以兩段式：
// 先試 interrupt、退而求其次 return()，都失敗就靠 aborted 旗標讓迴圈自己收。
async function releaseCurrent(reason) {
  const prev = current;
  if (!prev) return;
  current = null;
  prev.aborted = true;
  try { await prev.q?.interrupt?.(); } catch {}
  try { await prev.q?.return?.(); } catch {}
  console.log(`[${PLUGIN_ID}] 前一則讓位（${reason}）`);
}

// 'auto'＝完全不送 effort，交給 SDK 的 adaptive 自己決定。
// 酒館對這個選項的原生說明就是「選擇 Auto 不會傳送推理耗費等級」，照它的語義做；
// 預設也改回 auto——26-07-24 硬寫 medium 那版沒得選，Mini 只能吃我們替她決定的檔位。
const VALID_EFFORTS = ['auto', 'low', 'medium', 'high', 'max'];
let configEffort = 'auto';

function effortOption() {
  return configEffort === 'auto' ? {} : { outputConfig: { effort: configEffort } };
}

// SDK 原生思考摘要（26-07-27 加開關，霽野裁定預設關）。
// 病理（霽野讀 jsonl 實證）：思考只有 SDK thinking block 一條通道，開著的時候，
// 預設要求的中文思考鏈**有時搶到、有時被模型原生英文腦蓋掉**，而正文的 `<thinking>`
// 只剩空標籤——預設設計的位置被架空，這才是中英不穩的真因，不是「兩股並跑」。
// 關掉＝把思考鏈趕回 prompt 管得住的正文層，酒館照樣解析得到、使用者照樣看得見。
// 順帶解掉「該輪只生 thinking block、沒生 text block → 回空字串」的空回覆。
// 預設關的理由：現役使用者 100% 用帶思考鏈的預設，這股對他們是冗餘＋燒 token；
// 素卡使用者想要原生摘要再自己打開。
let configThinking = false;
let warnedNoSystemPrompt = false;   // 「有 system 卻沒系統提示」的提醒每次啟動只講一次

// 26-07-27 退修（霽野實彈驗收 FAIL）：**不送參數 ≠ 關閉**。
// SDK 型別文件寫明 `{ type: 'adaptive' }` 是「支援的模型的預設值」——省略 thinking
// 只是「不主動要求」，模型端照樣自己開、照樣產 thinking block，reasoning_content 照回。
// 要關就得明確送 `{ type: 'disabled' }`。這才是把思考鏈趕回正文層的正解。
// 誠實邊界（Grok MED-4，26-07-27）：Always-on 思考的模型仍可能在模型端 think，
// 本層只保證**不回酒館**，不保證那份 token 完全不燒。
// ⚠️ 隱式依賴：Messages API 的模型能力矩陣其實會拒某些組合（fable 拒 disabled／
// haiku 拒 adaptive），我們沒踩到是因為 Agent SDK 那層有容錯（霽野 26-07-27 兩發實彈驗過）。
// **SDK 升級後要重跑 fable+disabled／haiku+adaptive 兩發實彈**，那層容錯不是我們的合約。
function thinkingOption() {
  return configThinking
    ? { thinking: { type: 'adaptive', display: 'summarized' } }
    : { thinking: { type: 'disabled' } };
}

const MODELS = [
  { id: 'claude-opus-5[1m]', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-opus-5', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-opus-4-6[1m]', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-opus-4-6', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-opus-4-8[1m]', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-fable-5', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-sonnet-5', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-sonnet-4-6', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-haiku-4-5', object: 'model', owned_by: 'anthropic' },
];

// 酒館「傳送內嵌媒體」送的是 OpenAI 格式的 data URL，Claude 要的是 base64 三件組。
// 只吃 data URL——外部網址一律不下載（bridge 不該替使用者去打別人的伺服器）。
function toImageBlock(part) {
  const url = part && part.image_url && part.image_url.url;
  if (typeof url !== 'string') return null;
  const m = url.match(/^data:([^;,]+);base64,(.+)$/);
  if (!m) return null;
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

// 空回覆時印出黑盒子，並回一句使用者看得懂的話取代空字串（26-07-27 綾案）。
// 空字串在酒館裡跟「當機」長得一模一樣——沉浸感讓一步，換使用者知道發生什麼事。
function emptyReplyNotice(reqNo, blockTypes, diag) {
  const parts = [`blocks=[${blockTypes.length ? blockTypes.join(',') : '無'}]`];
  for (const k of ['stop_reason', 'subtype', 'num_turns', 'is_error']) {
    if (diag[k] !== undefined) parts.push(`${k}=${diag[k]}`);
  }
  console.warn(`[${PLUGIN_ID}][${reqNo}] ⚠️ 空回覆 — ${parts.join(' ')}`);
  return '（這一則模型沒有產出任何文字。診斷資訊已印在 SillyTavern 的終端機視窗，'
    + '找 “空回覆” 那一行。可以先按重新生成試一次。）';
}

function renderTurn(m) {
  const tag = m.role === 'user' ? 'user' : (m.role === 'system' ? 'system' : 'reply');
  return `<${tag}>\n${m.content}\n</${tag}>`;
}

// 位置語義（26-07-27 大修，霽野裁定①）：
// 舊版把所有 role=system 不分位置一律搬進系統提示的最前面。酒館的注入是**帶位置的**——
// 世界書 depth、作者註記、post-history 指令都靠位置生效，全部搬到最前面等於改寫了酒館的語義。
// 實案：綾（外部使用者）94 則 system 有 93 則穿插在對話中間、最後一則也是 system，
// 症狀＝不照格式輸出；Mini 側同病輕度（她 5 條 depth 注入裡的「導演指令 depth=1」被搬位，
// 病徵是模型在思考裡手工重建該判定，霽野讀 jsonl 抓到現場）。
//
// 核心規則：**header 區才是系統提示；對話開始之後的每一則 system 都留在它原本的位置。**
// bridge 是橋，不是編輯。「header 到哪裡為止」的判準見下方兩段式說明。
//
// ── header 到哪裡為止：兩段式判準（26-07-27 第三版，綾兩份驗收報告逼出來的）──
//
// 判準一（嚴格，預設走這條）：開頭連續的 system，空白佔位訊息跳過不算數。
//   涵蓋絕大多數預設。正常對話 `system…, user(第一句), assistant(回應)…` 完全正確。
//
// 判準二（救援，只在判準一拼不出系統提示卻確實有 system 訊息時啟用）：
//   第一則 assistant 之前全歸 header。
//   為什麼需要它：綾的預設把 `[PERSONA·STORYTELLER]` 和 `---` **指定為 user 角色**
//   排在最前面（有實質內容，判準一在 index 0 就結束），結果 94 則 system 全落進
//   對話流、系統提示是空的。她的 header 區長達 41 則且完全沒有 assistant——
//   「角色說過話才代表對話開始了」在這種形狀下是可靠訊號。
//
// 為什麼不無條件用判準二：一般對話的第一則 assistant 前面那個 user 是**玩家的第一句話**，
//   無條件套用會把它吃進系統提示（實測打掉 7 組既有案例）。兩者無法用結構分辨，
//   所以只在判準一確實失敗時才啟用救援，不拿正常情況去賭。
//
// 判準二的失效情形（綾自己指出）：整份沒有 assistant 時會吃掉玩家那句 → 退到
//   「最後一則 user 之前」保住它。
function strictHeaderEnd(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'system') continue;
    const c = typeof m.content === 'string' ? m.content : '';
    const isBlank = c.trim() === '' && !(Array.isArray(m.content) && m.content.some(p => p?.type === 'image_url'));
    if (isBlank) continue;      // 空白佔位不算對話開始
    return i;
  }
  return messages.length;
}

function rescueHeaderEnd(messages) {
  const firstAssistant = messages.findIndex(m => m && m.role === 'assistant');
  if (firstAssistant >= 0) return firstAssistant;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') return i;   // 保住當前訊息
  }
  return messages.length;
}

function parseMessages(messages) {
  const strict = parseWithHeaderEnd(messages, strictHeaderEnd(messages));
  if (strict.systemPrompt || !messages.some(m => m && m.role === 'system')) return strict;
  // 判準一失敗且確實有 system → 啟用救援
  return parseWithHeaderEnd(messages, rescueHeaderEnd(messages));
}

function parseWithHeaderEnd(messages, headerEnd) {
  const systemParts = [];   // header 區：角色卡、預設前段（含被標成 user 的指令區塊）
  const flow = [];          // 對話流：原序不動，含 depth 注入與 post-history
  let headerDone = false;

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    if (!msg) continue;     // 陣列含 null 不炸（澄衡 26-07-21 低危同族）
    if (idx >= headerEnd) headerDone = true;

    let content = '';
    const images = [];

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (p && p.type === 'image_url') {
          const block = toImageBlock(p);
          if (block) images.push(block);
        } else {
          content += (p && p.text) || '';
        }
      }
    } else if (msg.content != null) {
      // 非 string 非 array（number／object／boolean）——舊版靜默清成空字串送出去，
      // 使用者只會看到模型答非所問，完全無跡可循（Grok MED-1）。轉字串並留聲音。
      content = String(msg.content);
      console.warn(`[${PLUGIN_ID}] 非預期的 content 型別（${typeof msg.content}），已轉字串處理`);
    }

    // header 區：不管 role 是 system 還是 user 都併進系統提示——
    // 那些是指令不是對話，酒館把它們標成 user 只是格式選擇（綾的預設實況）。
    if (!headerDone) {
      systemParts.push(content);
      continue;
    }

    flow.push({ role: msg.role, content, images });
  }

  // 空段落要濾掉再 join——否則兩則空 system 會拼出 "\n\n"，那是 truthy，
  // 等於送一個「看起來有、其實空白」的系統提示出去（Grok MED-2）。
  const systemPrompt = systemParts.filter(s => s.trim() !== '').join('\n\n') || undefined;

  // 當前訊息取「最後一則 **user**」，不是「最後一則」——depth=0 的注入會排在玩家發言之後，
  // 舊版直接把它當成玩家現在說的話送出去（綾案：最後一則是 MVU 規則）。
  let curIdx = -1;
  for (let i = flow.length - 1; i >= 0; i--) {
    if (flow[i].role === 'user') { curIdx = i; break; }
  }

  let prompt;
  let images = [];

  if (flow.length === 0) {
    prompt = '(empty message)';
  } else if (curIdx === -1) {
    // 沒有任何 user（例如只有角色開場白）——整段照原序給，不硬挑一則當「當前」
    prompt = flow.map(renderTurn).join('\n');
  } else {
    const before = flow.slice(0, curIdx);
    const cur = flow[curIdx];
    const after = flow.slice(curIdx + 1);   // post-history：位置就是它的效力

    // 只帶最後一則 user 的圖：RP 用法是「丟一張圖→角色對它反應」，
    // 整段歷史的圖全帶會讓長對話的 token 成本爆掉（26-07-25 Mini 拍板取捨）。
    images = cur.images || [];

    const parts = [];
    if (before.length) parts.push(`<history>\n${before.map(renderTurn).join('\n')}\n</history>`);
    parts.push(cur.content);
    if (after.length) parts.push(after.map(renderTurn).join('\n'));
    prompt = parts.join('\n\n');
  }

  return { systemPrompt, prompt, images };
}

// 有圖片時 prompt 不能只是字串——包成串流輸入的單則使用者訊息。
// 附帶好處：官方註明 interrupt() 只在串流輸入模式可用，走這條讓位才停得乾淨。
function makeImagePrompt(text, images) {
  return (async function* () {
    yield {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'text', text: text || '(empty message)' }, ...images],
      },
    };
  })();
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

  // 新的一則進來＝玩家要這一則，前一則直接讓位（不再回 429 把人擋在門外）
  await releaseCurrent('新請求進來');

  const ticket = { q: null, aborted: false };
  current = ticket;

  // 酒館斷線（超時、按停止、關頁面）→ 立刻放手，別讓下一則卡在門口
  let finished = false;
  res.on('close', () => {
    if (finished || ticket.aborted) return;
    ticket.aborted = true;
    Promise.resolve()
      .then(() => ticket.q?.interrupt?.())
      .catch(() => {})
      .then(() => ticket.q?.return?.())
      .catch(() => {});
    console.log(`[${PLUGIN_ID}] 酒館端斷線，停止生成。`);
  });

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

    const modelId = requestModel || 'claude-opus-4-6[1m]';
    const { systemPrompt, prompt, images } = parseMessages(messages);
    // 請求形狀進 log：sys=0字/0則 一眼看出「角色卡沒送到」——酒館端把 system 拆掉時
    // （提示詞後處理選半嚴格/嚴格會把首則以外的 system 改成 user）症狀是模型跳出角色拒答，
    // 沒有這行就只能靠臨時插碼才診斷得出來（26-07-27 實案）。長度而已，不印內容。
    const sysCount = messages.filter(m => m && m.role === 'system').length;
    const shape = `sys=${systemPrompt ? systemPrompt.length : 0}字/${sysCount}則 msgs=${messages.length}`;

    // 有 system 訊息卻拼不出系統提示＝對話開頭就是使用者訊息，所有 system 都屬對話流。
    // 這是規則的正確行為（位置語義優先），但它讓「角色卡沒進系統提示」變成靜默狀態，
    // 所以出一次聲（每次啟動只講一次，不洗版）——綾 26-07-27 驗收建議 (c)。
    if (!systemPrompt && sysCount > 0 && !warnedNoSystemPrompt) {
      warnedNoSystemPrompt = true;
      console.warn(`[${PLUGIN_ID}] 注意：本次請求有 ${sysCount} 則系統訊息，但系統提示是空的——你的對話開頭是使用者訊息，所以每一則 system 都留在對話流的原位（位置語義優先）。角色扮演若不穩定，可從預設的訊息結構查起。此訊息每次啟動只出現一次。`);
    }
    const completionId = `chatcmpl-${randomUUID().slice(0, 8)}`;
    // 有圖 → 串流輸入模式（SDK 才收得到 image block）；沒圖 → 維持原本的字串 prompt
    const hasImages = images.length > 0;
    const buildPrompt = () => (hasImages ? makeImagePrompt(prompt, images) : prompt);

    if (stream === false) {
      try {
        let fullText = '';
        let thinkingText = '';
        let costUsd = 0;
        const blockTypes = [];   // 這輪模型產出的 block 型別序列（空回覆診斷用）
        const diag = {};         // result 的 subtype/num_turns/is_error 與 stop_reason
        const q = queryFn({
          prompt: buildPrompt(),
          options: {
            systemPrompt,
            tools: [],
            maxTurns: 1,
            model: modelId,
            permissionMode: 'dontAsk',
            persistSession: false,
            settingSources: [],
            ...thinkingOption(),
            ...effortOption(),
          },
        });
        ticket.q = q;

        for await (const msg of q) {
          if (ticket.aborted) break;
          if (msg.type === 'assistant') {
            for (const block of msg.message?.content || []) {
              blockTypes.push(block.type);   // 空回覆時唯一的線索：這輪到底產出了什麼
              if (block.type === 'text') fullText += block.text || '';
              // 第二層防禦（26-07-27 退修）：就算模型端仍產 thinking block，關閉時也不收
              else if (configThinking && block.type === 'thinking') thinkingText += block.thinking || '';
            }
            if (msg.message?.stop_reason) diag.stop_reason = msg.message.stop_reason;
          } else if (msg.type === 'result') {
            costUsd = Number(msg.cost_usd) || 0;
            diag.subtype = msg.subtype;
            diag.num_turns = msg.num_turns;
            diag.is_error = msg.is_error;
            break; // 串流輸入模式不會自己收尾（SDK 等下一則輸入），拿到 result 就走
          }
        }

        let usage;
        try { usage = await q.usage_EXPERIMENTAL(); } catch {}

        requestCount++;
        totalCostUsd += costUsd;
        console.log(`[${PLUGIN_ID}][${requestCount}] model=${modelId} effort=${configEffort} ${shape}${hasImages ? ` img=${images.length}` : ''} cost=$${costUsd.toFixed(4)} total=$${totalCostUsd.toFixed(4)}${usage ? ` in=${usage.input_tokens} out=${usage.output_tokens}` : ' usage=n/a'}`);

        // 空回覆的黑盒子（26-07-27 綾案）：bridge 原本只記請求不記回應，
        // 模型吐出一片空白時完全沒有線索，使用者只看得到「送出去、回來是空的」。
        // 這一行是分辨「模型拒答／產出非 text block／SDK 提前收尾」的唯一依據。
        if (!fullText.trim() && !ticket.aborted) {
          fullText = emptyReplyNotice(requestCount, blockTypes, diag);
        }

        const responseBody = {
          id: completionId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: fullText, ...(thinkingText && { reasoning_content: thinkingText }) },
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

    const q = queryFn({
      prompt: buildPrompt(),
      options: {
        systemPrompt,
        tools: [],
        maxTurns: 1,
        model: modelId,
        permissionMode: 'dontAsk',
        persistSession: false,
        includePartialMessages: true,
        settingSources: [],
        ...thinkingOption(),
        ...effortOption(),
      },
    });
    ticket.q = q;
    // 斷線／讓位的處理統一在函式開頭那個 res.on('close') 與 releaseCurrent()，這裡不再另掛

    try {
      let costUsd = 0;
      let sentText = false;    // 這輪有沒有真的送出過文字（空回覆診斷用）
      const blockTypes = [];
      const diag = {};
      for await (const msg of q) {
        if (ticket.aborted) break;
        if (msg.type === 'stream_event') {
          const event = msg.event;
          if (event.type === 'content_block_start' && event.content_block?.type) {
            blockTypes.push(event.content_block.type);
          }
          if (event.type === 'message_delta' && event.delta?.stop_reason) {
            diag.stop_reason = event.delta.stop_reason;
          }
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            if (event.delta.text) sentText = true;
            const textChunk = makeChunk(completionId, modelId, { content: event.delta.text }, null);
            if (!ticket.aborted) res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
            // 第二層防禦（26-07-27 退修）：關閉時不往酒館轉發，即使模型端仍產 thinking
          } else if (configThinking && event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && event.delta.thinking) {
            const thinkChunk = makeChunk(completionId, modelId, { reasoning_content: event.delta.thinking }, null);
            if (!ticket.aborted) res.write(`data: ${JSON.stringify(thinkChunk)}\n\n`);
          }
        } else if (msg.type === 'result') {
          costUsd = Number(msg.cost_usd) || 0;
          diag.subtype = msg.subtype;
          diag.num_turns = msg.num_turns;
          diag.is_error = msg.is_error;
          break; // 串流輸入模式不會自己收尾，拿到 result 就走
        }
      }

      let usage;
      try { usage = await q.usage_EXPERIMENTAL(); } catch {}

      requestCount++;
      totalCostUsd += costUsd;
      console.log(`[${PLUGIN_ID}][${requestCount}] model=${modelId} effort=${configEffort} ${shape}${hasImages ? ` img=${images.length}` : ''} cost=$${costUsd.toFixed(4)} total=$${totalCostUsd.toFixed(4)}${usage ? ` in=${usage.input_tokens} out=${usage.output_tokens}` : ' usage=n/a'}${ticket.aborted ? ' (讓位/斷線)' : ''}`);

      if (!ticket.aborted) {
        // 整輪一個字都沒送出＝空回覆。印黑盒子，並補一則通知取代空白畫面（26-07-27 綾案）
        if (!sentText) {
          const notice = makeChunk(completionId, modelId, { content: emptyReplyNotice(requestCount, blockTypes, diag) }, null);
          res.write(`data: ${JSON.stringify(notice)}\n\n`);
        }
        const stopChunk = makeChunk(completionId, modelId, {}, 'stop');
        res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch (err) {
      if (!ticket.aborted) {
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
    finished = true;
    if (current === ticket) current = null; // 已經讓位給新的一則就別誤清人家的位子
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
          res.end(JSON.stringify({ status: 'ok', busy: current !== null, effort: configEffort, requestCount, totalCostUsd }));
          return;
        }

        if (req.method === 'GET' && req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: MODELS }));
          return;
        }

        if (req.method === 'GET' && req.url === '/config') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ effort: configEffort, thinking: configThinking }));
          return;
        }

        if (req.method === 'POST' && req.url === '/config') {
          try {
            const raw = await readBody(req);
            if (raw) {
              const cfg = JSON.parse(raw);
              if (cfg.effort && VALID_EFFORTS.includes(cfg.effort)) {
                configEffort = cfg.effort;
              }
              if (typeof cfg.thinking === 'boolean') {
                configThinking = cfg.thinking;
              }
            }
          } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ effort: configEffort, thinking: configThinking }));
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
  version: '1.2.3',
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
        ? { running: true, host: HOST, port: DEFAULT_PORT, busy: current !== null, effort: configEffort, requestCount, totalCostUsd, models: MODELS.map(m => m.id) }
        : { running: false },
      sdkAvailable: Boolean(queryFn),
    });
  });

  // effort 設定走 ST 自己的 router（同源），不走 5199——瀏覽器 CORS 擋跨 port 直連
  router.get('/config', (_req, res) => {
    res.json({ effort: configEffort, thinking: configThinking });
  });

  router.post('/config', (req, res) => {
    const effort = req.body?.effort;
    if (effort && VALID_EFFORTS.includes(effort)) {
      configEffort = effort;
    }
    if (typeof req.body?.thinking === 'boolean') {
      configThinking = req.body.thinking;
    }
    res.json({ effort: configEffort, thinking: configThinking });
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

// parseMessages 與 thinkingOption 一併匯出供測試直接呼叫真函式
//（ST 只讀 info/init/exit，多兩個具名匯出對它無影響）。
// 位置語義與思考開關是這支橋最容易壞又最看不出來的兩處，測試必須測到本尊、不是抄一份副本。
export { info, init, exit, parseMessages, thinkingOption };
