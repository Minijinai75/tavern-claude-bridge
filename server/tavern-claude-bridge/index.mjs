import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';   // createHash：前綴指紋用（26-08-02）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 拆塊斷點掃描器（26-08-02，CX-260802-03）：只做「斷點該落在哪一則」的計算，
// 不碰渲染也不貼標記——分工線在那支的檔頭註解。目前只被量測模式用到。
import { fingerprintTurns, decideBreakpoint, stickyBreakpoint, meetsCacheMinimum, estimateTokens, minCacheTokensFor, trackSystemPrompt } from './cache-breakpoint.mjs';

// ESM 沒有 __dirname，自己算（快取讀數落檔要用——見 appendCacheLog）
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 快取邊界標記（26-08-01 加）。
// SDK 的 systemPrompt 除了字串還吃陣列，中間放這個標記＝**標記之前的區塊可以
// 跨 session 快取，之後的不行**（型別註解原文：eligible for cross-session prompt caching）。
// 橋原本傳的是單一字串——沒有邊界，整份系統提示都被當動態的，一個字都不快取。
// ⚠️ 26-08-01 標的「實測 cacheRead=0 cacheWrite=0，連快取都沒建」**已作廢**：
// 那批實測的系統提示只有 161 tokens，低於 Opus 4.6 的 4096 最小可快取門檻，
// API 靜默不建快取也不報錯——量到的 0 是題目造成的，不是機制。見下方 26-08-02 重驗。
// 值是常數字串，SDK 沒匯出時退回內建值，不讓橋因此起不來。
let SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';
try {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  if (typeof sdk.SYSTEM_PROMPT_DYNAMIC_BOUNDARY === 'string') {
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY = sdk.SYSTEM_PROMPT_DYNAMIC_BOUNDARY;
  }
} catch {}

// 把系統提示切成「可快取的靜態前綴 + 邊界」。
// 為什麼整份都放在邊界之前：橋收到的 header 區是角色卡／預設前段那類東西，
// 同一個角色連續對話時逐字相同——那正是快取要吃的。真的變了（世界書觸發之類）
// 前綴本來就會失效，標了不會更糟。
// ⚠️ **預設關閉——但理由在 26-08-02 換過，別照舊註解理解**。
//
// 舊理由（作廢）：「三發實測 cacheRead/cacheWrite 全為 0，加了邊界跟沒加一樣」。
// 那三發的系統提示是 161 tokens，**低於 Opus 4.6 的 4096 最小可快取門檻**——
// 官方 prompt-caching 文件原文：太短的前綴「silently won't cache even with a marker
// — no error, just cache_creation_input_tokens: 0」。標記下在哪裡都不會有讀數。
// 所以那組實測**證明不了 boundary 無效，它根本沒進入可快取的條件**。
//
// 新理由：**它現在是「未測」，不是「無效」**。沒在有效條件下驗過的東西不放預設路徑，
// 這條規矩不變，換的是它為什麼還在關著。要研究就設 TCB_CACHE_BOUNDARY=1 打開，
// 並且**系統提示必須超過門檻**（4.6 是 4096；Opus 5 / Fable 5 只要 512）。
//
// ⚠️ persistSession：26-08-02 上午判「證偽」，同日下午**翻回來了，它真的是關鍵**。
//
// 上午的錯誤結論：實測 persistSession 全程維持 false，長前綴照樣建快取
// （cacheWrite=9059）、第二發照樣命中（cacheRead=8102）→ 判定「它從來不是阻礙」。
// 錯在哪：**那組實驗只驗了「快取建不建得起來」，沒驗「整包能讀回多少」。**
// 前綴只有一段 system，讀回 8102 就等於全中，看不出對話流那側的差別。
//
// 下午的翻案實測（test/spike-resume-cache_260802.mjs，同樣內容三組對照）：
//   persistSession:false ......... 讀  7,023  寫 4,978  $0.0541   ← 只吃到系統提示
//   persistSession:true .......... 讀 12,001  寫     0  $0.0066   ← 整包全中，省 88%
//   persistSession:true + resume . 讀 12,001  寫    46  $0.0068   ← 不需要 resume 就有了
//
// 也就是說「對話流進不了快取」不是 SDK 的設計，是 false 造成的。這與官方文件一致——
// Agent SDK 文件明說快取自動處理、prompt-caching 文件把 conversation 列為可快取的一層。
//
// 教訓（值得留給下一個人）：**在錯誤的量測條件下驗過一次，比沒驗過更危險**——
// 它會拿到一張看起來合格的免罪符，然後被寫進註解叫後人「不必再追」。
//
// 實驗腳本：上午 test/spike-cache-threshold_260802.mjs／下午 test/spike-resume-cache_260802.mjs
//
// 各模型的最小可快取前綴差很多，換模型要一起想這件事：
//   Opus 5 / Fable 5 = 512｜Opus 4.8 / Sonnet 5 = 1024｜Opus 4.7 = 2048｜Opus 4.6 = 4096
function systemPromptForSdk(systemPrompt) {
  if (!systemPrompt) return undefined;
  if (process.env.TCB_CACHE_BOUNDARY !== '1') return systemPrompt;
  return [systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY];
}

// 26-08-02 翻案後的預設：開。理由與取捨——
// ・省很大：同樣內容從讀 7,023／寫 4,978（$0.0541）變成讀 12,001／寫 0（$0.0066），省 88%
// ・零語義風險：這個開關不改任何送進模型的訊息內容，只影響 SDK 要不要保存 session
// ・代價是磁碟上會留 session 檔。評估後認為可接受：玩酒館的對話本來就會留在本機，
//   真的在意這件事的人不會用酒館——所以對外也預設開。
// ・不吃 resume：實測顯示光是 true 就整包命中，不需要橋去記 sessionId（那會引入跨請求狀態）
// 設 TCB_PERSIST_SESSION=0 可退回舊行為（每則一次性 session，不留檔但吃不到對話流快取）。
function persistSessionOption() {
  return process.env.TCB_PERSIST_SESSION !== '0';
}

const PLUGIN_ID = 'tavern-claude-bridge';
const DEFAULT_PORT = 5199;
const HOST = '127.0.0.1';

let bridgeServer = null;
let queryFn = null;
let current = null; // 正在跑的那一則；新請求進來會請它讓位
let totalCostUsd = 0;
let requestCount = 0;

// 快取效果累計（26-08-03）。橋重啟歸零——這是「本次啟動以來」，不是歷史總帳，
// 面板上要照這樣寫，不然使用者會以為數字被吃掉了。
//
// 為什麼記 token 不記美元：使用者玩的模型不一樣（Opus／Sonnet／Haiku 單價差十倍），
// 美元互相看不懂也沒得比；而且價格是會變的事實，寫死進碼就會過期。
// token 與倍數是 API 的計價**結構**（讀快取 0.1 倍、建快取 1h 是 2 倍），這個不隨價目表變。
const cacheTally = {
  requests: 0,        // 有拿到 usage 的請求數（拿不到的不灌水）
  splitApplied: 0,    // 其中真的拆了塊的發數
  input: 0,           // 未快取的輸入
  cacheRead: 0,       // 讀到快取的（只算 1/10 錢）
  cacheWrite: 0,      // 新建快取的（1h 算 2 倍錢）
  output: 0,
  costUsd: 0,         // SDK 給的真實成本累計（這格是實測，不是換算）
  // 最近兩發各自的花費（26-08-03 加，第一版被實際使用者回報看不懂）。
  // 累計倍數會被開頭的建立費拖很久，任何人剛裝上玩個三五則都只會看到「回本中」，
  // 而那正是最需要被說服的時刻。**單則對照才是人看得懂的那個數字**，而且第三則就成立。
  lastCostUsd: 0,
  prevCostUsd: 0,
  lastSkipReason: null,   // 最近一次「這發不拆」的理由（面板警告靠它把「沒生效」講成「為什麼」）
};

// 「沒有快取的話要付幾倍」——純比例換算，不需要任何價目表。
//   實際加權 ＝ 未快取×1 ＋ 讀快取×0.1 ＋ 建快取×2
//   反事實　 ＝ 三者全部按一般輸入×1（沒有快取機制的話，這些 token 一樣要送）
// 只算輸入側：輸出不受快取影響，混進去會把倍數稀釋成看不懂的數字。
// 參數只給測試用（預設就是真的累計器）——讓測試餵假數字進來驗**這支本尊**的算法，
// 不必為了可測而另寫一份複製品（複製品測過 ≠ 本體會動）。
function cacheSummary(t = cacheTally) {
  const actual = t.input + t.cacheRead * 0.1 + t.cacheWrite * 2;
  const noCache = t.input + t.cacheRead + t.cacheWrite;
  return {
    ...t,
    inputTotal: noCache,
    hitPct: noCache > 0 ? Math.round((t.cacheRead / noCache) * 100) : null,
    // 一發都還沒有、或全部沒快取時回 null，讓前端顯示「還沒有數據」而不是硬印 1.0 倍
    savedRatio: actual > 0 && t.requests > 0 ? Number((noCache / actual).toFixed(2)) : null,
    // 這一則跟上一則比省了幾成。**這是面板第一行要講的話**，其餘都是細節。
    // 可能是負的（快取重建那一則會比上一則貴），負的也照實回，讓前端換一套說法解釋原因——
    // 蓋掉它就變成報喜不報憂，使用者下次看到怪數字會不知道是正常的。
    savedPct: t.requests >= 2 && t.prevCostUsd > 0
      ? Math.round((1 - t.lastCostUsd / t.prevCostUsd) * 100)
      : null,
    // 拆塊開著卻幾乎沒生效時，**要在面板第一層講出來**（26-08-27，CX-260827-01 第三刀）。
    //
    // 為什麼加這一格：這次的 bug 之所以能活這麼久，不是因為它難查，是因為它**安靜**——
    // 面板照樣顯示「拆塊：開著」，唯一的線索是摺疊區裡一行「66 則裡有 4 則拆到塊」，
    // 三位外部使用者付了幾十倍的錢，沒有一個人看得出哪裡不對。修好這次的根因不等於
    // 下次不會再有別的原因讓它失效，所以要留一個**會自己叫的東西**。
    //
    // 三條不叫的情況：沒樣本、使用者自己關掉（那是他的選擇不是故障）、拆塊率健康。
    splitWarning: splitWarningOf(t),
    // 診斷要能被面板拿到，不能只活在終端機（26-08-27）。使用者玩完一則想貼診斷給我，
    // 在終端機裡翻兩次都找不到——那行只進 console.log、會被後面的輸出捲走。
    // 「診斷的成本不該由使用者付」這條課我當天早上才記，晚上自己又犯一次。
    lastDivergence: t.lastDivergence ?? null,
    lastDivergenceZone: t.lastDivergenceZone ?? null,   // 'system' | 'chat' | null
    lastSystemDrift: t.lastSystemDrift ?? null,
  };
}

/**
 * 拆塊「開著但沒生效」的警告。回 null＝沒事，不要吵。
 *
 * 門檻取「一半」是刻意的鈍值：拆塊本來就有合理不拆的時候（第一發沒基準、
 * 斷點剛好在頭幾則），偶爾不拆不是病；**長期過半不拆才是**。
 */
function splitWarningOf(t) {
  const 樣本夠 = t.requests >= 3;
  // 帳本沒帶這欄就問即時狀態（production 走這條）；測試傳假帳本時可以覆寫。
  const 開著 = t.splitEnabled !== undefined ? t.splitEnabled !== false : splitEnabled();
  if (!樣本夠 || !開著) return null;
  const applied = t.splitApplied || 0;
  if (applied * 2 >= t.requests) return null;     // 過半有拆到＝健康

  const 原因 = t.lastSkipReason
    ? `最近一次的原因是：${t.lastSkipReason}`
    : '這次啟動還沒記到不拆的原因（重開過的話再玩幾則就會有）';
  // 位置也一起講——只看面板的人才不用去終端機翻。
  const 位置 = typeof t.lastDivergence === 'number'
    ? `｜量到的變動點在第 ${t.lastDivergence} 則`
      + (t.lastDivergenceZone === 'system'
          ? '，它落在「系統提示區」——拆塊救不了這種，要去找是誰在每則重算那一段'
          : t.lastDivergenceZone === 'chat'
            ? '，落在對話區——通常是會回頭改寫舊訊息的機制'
            : '')
    : '';
  return {
    level: 'warn',
    text: `拆塊開著，但 ${t.requests} 則裡只有 ${applied} 則真的拆到塊——`
        + `省快取這件事現在幾乎沒有在發生。${原因}${位置}`,
  };
}
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// 讓前一則停下來。26-07-25 改：原本「同時只准一個、後來的回 429」，
// 在 RP 場景是錯的——玩家按重新生成/停止時，想要的是「換一則」不是「排隊」，
// 而酒館超時斷線後舊的還在跑，重試就一直吃 429（實際使用時踩到）。
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
// 預設也改回 auto——26-07-24 硬寫 medium 那版沒得選，使用者只能吃我們替他決定的檔位。
const VALID_EFFORTS = ['auto', 'low', 'medium', 'high', 'max'];
let configEffort = 'auto';

function effortOption() {
  return configEffort === 'auto' ? {} : { outputConfig: { effort: configEffort } };
}

// SDK 原生思考摘要（26-07-27 加開關，預設關）。
// 病理（讀聊天記錄檔實證）：思考只有 SDK thinking block 一條通道，開著的時候，
// 預設要求的中文思考鏈**有時搶到、有時被模型原生英文腦蓋掉**，而正文的 `<thinking>`
// 只剩空標籤——預設設計的位置被架空，這才是中英不穩的真因，不是「兩股並跑」。
// 關掉＝把思考鏈趕回 prompt 管得住的正文層，酒館照樣解析得到、使用者照樣看得見。
// 順帶解掉「該輪只生 thinking block、沒生 text block → 回空字串」的空回覆。
// 預設關的理由：現役使用者 100% 用帶思考鏈的預設，這股對他們是冗餘＋燒 token；
// 素卡使用者想要原生摘要再自己打開。
let configThinking = false;
let warnedNoSystemPrompt = false;   // 「有 system 卻沒系統提示」的提醒每次啟動只講一次

// 26-07-27 退修（實彈驗收 FAIL）：**不送參數 ≠ 關閉**。
// SDK 型別文件寫明 `{ type: 'adaptive' }` 是「支援的模型的預設值」——省略 thinking
// 只是「不主動要求」，模型端照樣自己開、照樣產 thinking block，reasoning_content 照回。
// 要關就得明確送 `{ type: 'disabled' }`。這才是把思考鏈趕回正文層的正解。
// 誠實邊界（Grok MED-4，26-07-27）：Always-on 思考的模型仍可能在模型端 think，
// 本層只保證**不回酒館**，不保證那份 token 完全不燒。
// ⚠️ 隱式依賴：Messages API 的模型能力矩陣其實會拒某些組合（fable 拒 disabled／
// haiku 拒 adaptive），我們沒踩到是因為 Agent SDK 那層有容錯（26-07-27 兩發實彈驗過）。
// **SDK 升級後要重跑 fable+disabled／haiku+adaptive 兩發實彈**，那層容錯不是我們的合約。
function thinkingOption() {
  return configThinking
    ? { thinking: { type: 'adaptive', display: 'summarized' } }
    : { thinking: { type: 'disabled' } };
}

// 拆塊快取開關（26-08-03 起預設開，逃生門留著）。
// 做什麼：把對話流切兩塊，穩定那塊貼 cache_control(1h)，讓快取斷點落在會動區之外。
// 真實流量實測一發 $2.3459 → $0.7149（省 69.5%），所以預設開——不必人人自己去設環境變數。
//
// 兩層控制，優先順序寫在這裡免得以後有人猜：
//   ① 啟動時 `TCB_SPLIT=0` ＝**硬關並鎖住**，面板改不動（逃生門：拆塊出事時一定關得掉）
//   ② 其餘情況預設開，面板那格隨時可關（存在 ST 設定裡，前端每次動作都會推整份過來）
// `TCB_SPLIT=1` 照舊是開，舊腳本不必改。
//
// 為什麼「鎖住」而不是「當初始值」：前端 init 時會把它記住的設定推過來覆蓋，
// 不鎖的話逃生門形同虛設——更糟的是使用者會看到勾選框開著、卻不知道自己被壓著，
// 又是一次「失敗長得跟成功一樣」。鎖了就把狀態誠實回報給面板，讓它把那格關成不可點。
const SPLIT_LOCKED_OFF = process.env.TCB_SPLIT === '0';
let configSplit = !SPLIT_LOCKED_OFF;

function splitEnabled() { return configSplit; }

// /config 的讀寫只有這一份實作，兩條路徑（5199 直連與 ST 同源 router）都呼叫它。
// 26-08-03 抽出來的理由很實際：原本兩邊各寫一份幾乎相同的邏輯，加第三個欄位就要改兩處，
// 而「改一半」的症狀是安靜的——面板走 router 那條會動，curl 走 5199 那條不動，兩邊都不報錯。
function currentConfig() {
  return { effort: configEffort, thinking: configThinking, split: configSplit, splitLocked: SPLIT_LOCKED_OFF };
}

// 只認得懂的欄位、只吃型別對的值；其餘一律忽略並維持原值（髒資料不該把設定踩回預設）。
function applyConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return currentConfig();
  if (cfg.effort && VALID_EFFORTS.includes(cfg.effort)) configEffort = cfg.effort;
  if (typeof cfg.thinking === 'boolean') configThinking = cfg.thinking;
  // 被啟動參數鎖住時，面板送什麼都不動——逃生門要真的關得住
  if (typeof cfg.split === 'boolean' && !SPLIT_LOCKED_OFF) configSplit = cfg.split;
  return currentConfig();
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

// 空回覆的成因分流（26-07-28 加，官方 cookbook 深讀）。
// 在此之前空回覆只有一種訊息：「模型沒有產出任何文字」——正確但沒用，因為成因不只一種，
// 而使用者能做的事按成因完全不同（換句話說 vs 按重新生成 vs 這是我方設定問題）。
// 官方明列的關鍵事實：`result` 欄位**只有 subtype === 'success' 時才存在**，
// `error_max_turns` 那類根本沒有；`stop_reason: 'refusal'` 代表模型拒答。
// 而我們設 maxTurns: 1 —— **模型只要想動一次工具就會撞 error_max_turns**，
// 在酒館端長得跟拒答、跟真的沒話講一模一樣（一位外部使用者 26-07-27 那個查不出病因的間歇性空回覆，
// 這是候選解釋之一，而且解釋得通「為什麼間歇」：同一張卡有時模型想動工具、有時不想）。
const EMPTY_REASONS = [
  {
    match: d => d.stop_reason === 'refusal',
    label: '模型拒答',
    say: '這一則模型選擇不回應（安全層攔下）。換個說法或調整情節通常就過得去——這不是當機。',
  },
  {
    match: d => d.subtype === 'error_max_turns',
    label: '撞回合上限',
    say: '這一則模型想動用工具，但這座橋只允許一次回合就結束（不開放工具）。'
      + '通常是提示詞裡有「請搜尋／請執行」這類指令引發的，把那類句子拿掉就好。',
  },
  {
    match: d => d.stop_reason === 'max_tokens',
    label: '長度上限',
    say: '這一則在還沒開始寫正文前就用完了額度上限。若開著思考功能，先關掉再試一次。',
  },
  {
    match: d => d.subtype === 'error_max_budget_usd',
    label: '費用上限',
    say: '這一則撞到費用上限被中止了。',
  },
  {
    // 26-08-03 加（外部使用者回報）：**額度用盡時 SDK 不拋例外**，它回一個帶 is_error 的
    // result，所以整條 humanError() 的 rate_limit 分支繞過去了（那條只在拋例外時走得到）。
    // 唯一能自動分辨的線索是 result 自己帶的那段文字——有寫額度就直接判額度，
    // 不要讓它掉進下面那條「兩種可能」的通用條目，那條要人自己去查。
    // 同族前例：26-08-02 撞到 SDK 對 API 400 也不丟例外、照樣回全 0 的 result。
    //
    // ✅ **26-08-03 12:00 已實測**（外部使用者在額度用盡的當下實跑並回報原文）：
    //    `result="You've hit your session limit · resets 4:10pm (Asia/Taipei)"`
    //    推測對一半——SDK **確實**會帶出錯誤文字（第一版推測成立），
    //    但**字樣不是我猜的那些**：它寫 `session limit`，不是 rate limit／usage limit／quota，
    //    所以第一版的正則整條抓不到、自動分流沒觸發，使用者拿到的是下面那條並列版。
    //    這正好證明「真正的防線是並列那條」——它不依賴任何字樣假設，救了這一場。
    //    教訓：**猜得到「有沒有」不代表猜得到「長什麼樣」**，字串比對的條件一定要拿真樣本校準。
    //    另一個意外收穫：那段文字自帶**重置時間**，比叫人去翻 Settings 有用得多，直接轉給使用者。
    match: d => typeof d.resultText === 'string'
      && /rate.?limit|quota|exceeded|too.?many|usage.?limit|session.?limit|hit your.{0,20}limit|額度/i.test(d.resultText),
    label: '額度用完了',
    say: d => {
      // 從 SDK 原文抽重置時間（實測樣本：「· resets 4:10pm (Asia/Taipei)」）
      const m = /resets?\s+([^"\n·]+)/i.exec(d.resultText || '');
      const 重置 = m ? m[1].trim() : null;
      return '這一則沒送出去——Claude 回報額度已達上限，重新生成不會有幫助。'
        + (重置
          ? `**${重置} 就會重置**，到時候直接繼續玩就好。`
          : '訂閱額度是滾動窗口，過一陣子會自己回來；到 claude.ai 的 Settings → Usage 可以看什麼時候重置。')
        + '想現在就繼續的話，換便宜一點的模型（Sonnet／Haiku）通常還有額度。'
        + '**這跟登入憑證無關，不用重新登入。**';
    },
  },
  {
    // 26-07-29 加：**空回覆的第一個確診病因＝登入憑證失效**（外部使用者實案）。
    // 她的實況：`blocks=[無] subtype=success is_error=true usage=n/a cost=$0.0000`——
    // 模型一個字都沒吐、沒有 token 統計、沒扣費＝根本沒被呼叫成功；而她自己排除到
    // 「同一份 SDK 在自己程式裡跑正常，透過酒館全失敗，連 Haiku 都失敗」，最後查出是
    // 憑證沒更新成功。指紋：**沒有任何 block ＋ 標記出錯 ＋ 零成本**（真的跑起來過的請求
    // 就算失敗也多半留得下痕跡）。
    // 這條必須排在「執行錯誤」前面——**對憑證問題叫人「按重新生成」是錯的指示，
    // 按一百次也沒用**，而給錯指示比不給更糟。
    // 判準要抓那個**矛盾組合**：SDK 說 `success` 卻同時標 `is_error`——它自己都說不清楚
    // 發生什麼事，正是「還沒真的開始就結束了」的樣子。若 subtype 明講是 error_during_execution
    // 之類，那 SDK 已經告訴你是執行錯誤了，這條不該搶（26-07-29 寫測試時被 R4 打回來才修對）。
    match: d => d.is_error === true
      && (d.subtype === 'success' || d.subtype === undefined)
      && Array.isArray(d.blockTypes) && d.blockTypes.length === 0
      && (d.costUsd === 0 || d.costUsd === undefined),
    // 26-08-03 修（外部使用者回報，v1.6.0 那版的說法會誤導）：
    // **同一個指紋至少對應兩種病因**——他的案例憑證完全正常，是訂閱額度用完。
    // 舊版單指憑證，會把人導去重新登入白忙一場；更糟的是舊版還叫人「按自我健檢確認」，
    // 而額度用完時健檢那一發同樣撞牆失敗，看起來更像憑證壞了。
    // 這裡不猜、兩種並列，並告訴使用者先查哪一個——處置完全不同（等回補 vs 重新登入）。
    label: '模型沒被叫起來（額度用盡或憑證失效）',
    say: '模型一個字都沒吐、也沒有任何用量——請求根本沒被送出去，重新生成不會有幫助。'
      + '兩種可能，先查第一個：\n'
      + '① **訂閱額度用完**——到 claude.ai 的 Settings → Usage 看還剩多少；等額度回補，或先換便宜一點的模型。\n'
      + '② **登入憑證過期或沒更新成功**——在終端機執行 `claude login`，然後**重啟 SillyTavern**（憑證是啟動時載入的）。\n'
      + '注意：面板的「自我健檢」在額度用完時同樣會失敗，所以它只能證明「現在不通」，'
      + '不能證明是憑證的錯——額度沒滿才往憑證查。',
  },
  {
    match: d => d.subtype === 'error_during_execution' || d.is_error === true,
    label: '執行錯誤',
    say: '這一則在生成過程中出錯了。可以先按重新生成試一次；連續發生請看終端機那行診斷。',
  },
  {
    match: d => Array.isArray(d.blockTypes) && d.blockTypes.length > 0 && !d.blockTypes.includes('text'),
    label: '只產出非文字內容',
    say: '這一則模型只產出了思考、沒有寫出正文。把「SDK 原生思考」關掉通常可解（擴充面板裡）。',
  },
];

// 空回覆時印出黑盒子，並回一句使用者看得懂的話取代空字串（26-07-27 外部使用者案）。
// 空字串在酒館裡跟「當機」長得一模一樣——沉浸感讓一步，換使用者知道發生什麼事。
function emptyReplyNotice(reqNo, blockTypes, diag) {
  const parts = [`blocks=[${blockTypes.length ? blockTypes.join(',') : '無'}]`];
  for (const k of ['stop_reason', 'subtype', 'num_turns', 'is_error']) {
    if (diag[k] !== undefined) parts.push(`${k}=${diag[k]}`);
  }
  // result 自己帶的文字要印出來——它是「額度用盡」與「憑證失效」唯一的分辨線索，
  // 不印的話下一個人只能看著兩個同形的指紋猜（26-08-03 外部使用者案的直接教訓）
  if (diag.resultText) parts.push(`result="${diag.resultText.replace(/\s+/g, ' ').slice(0, 120)}"`);

  const hit = EMPTY_REASONS.find(r => r.match({ ...diag, blockTypes }));
  const label = hit ? hit.label : '成因不明';
  console.warn(`[${PLUGIN_ID}][${reqNo}] ⚠️ 空回覆（${label}） — ${parts.join(' ')}`);

  // 落檔（26-08-03 加）。**這條的立案理由值得寫下來**：
  // 空回覆最常見的病因之一是額度用盡，而額度用盡的那一刻，使用者的 AI 助手往往
  // 同樣動不了——「請你下次撞到時把終端機那行貼給我」在最需要的當下剛好做不到。
  // 所以不要靠人在慌亂時抄，讓橋自己留下來：額度回來之後誰都撈得到，事後補證一樣算數。
  // 只存結構不存內容（同 turn-log 的紀律）：診斷欄位、成因判定、result 那段文字，
  // 沒有任何一句對話。上限與 turn-log 同一套，超過就只留最後 200 筆。
  try {
    const file = path.join(__dirname, 'empty-replies.jsonl');
    try {
      if (fs.statSync(file).size > TURN_LOG_MAX_BYTES) {
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').slice(-200).join('\n'), 'utf8');
      }
    } catch {}
    fs.appendFileSync(file, JSON.stringify({
      t: new Date().toISOString(), n: reqNo, label,
      blocks: blockTypes, stop_reason: diag.stop_reason, subtype: diag.subtype,
      num_turns: diag.num_turns, is_error: diag.is_error, costUsd: diag.costUsd,
      // 這格就是「額度用盡 vs 憑證失效」的分辨依據——沒有它，兩種病因在事後完全同形
      resultText: diag.resultText ?? null,
    }) + '\n', 'utf8');
  } catch (e) {
    // 不靜默吞：落檔壞掉會讓「事後撈得到」變成空頭支票，而那正是這段存在的理由
    console.warn(`[${PLUGIN_ID}] 空回覆落檔失敗：${String((e && e.message) || e).slice(0, 120)}`);
  }

  // 認得出成因就直說並給路；認不出才回原本那句保守的話（不要假裝知道）
  // say 可以是字串或函式——函式版拿得到 diag，用來把 SDK 原文裡的線索
  // （例如額度的重置時間）轉給使用者，那比叫人自己去翻設定頁有用得多
  return hit
    ? `（${hit.label}）${typeof hit.say === 'function' ? hit.say({ ...diag, blockTypes }) : hit.say}`
    : '（這一則模型沒有產出任何文字，而且成因不在已知清單裡。診斷資訊已印在 SillyTavern 的'
      + '終端機視窗，找 “空回覆” 那一行——把那行貼給維護者，這是目前唯一的線索。可以先按重新生成試一次。）';
}

// SDK 回報錯誤時，把它給的東西整包印出來（26-07-29 加，外部使用者案）。
// 病史：外部使用者回報 `blocks=[無] subtype=success is_error=true usage=n/a cost=$0`——
// 模型連一個字都沒吐、沒有 token 統計、沒扣費＝**根本沒開始生成**。而 `subtype=success`
// 配 `is_error=true` 這個組合本身就矛盾，代表 SDK 有話要說，只是我們沒印。
// 我們原本只收 subtype／num_turns／is_error 三個旗標，**把 SDK 放在 result 訊息裡的
// 錯誤內容整包丟掉了**——等於拿到病歷卻只抄了體溫。
// 只在出錯時印，正常路徑零噪音；截斷 1200 字元防洗版。
function dumpResultOnError(reqNo, msg) {
  try {
    if (!msg || (msg.subtype === 'success' && msg.is_error !== true)) return;
    const copy = {};
    for (const [k, v] of Object.entries(msg)) {
      if (k === 'type') continue;
      copy[k] = typeof v === 'string' && v.length > 400 ? v.slice(0, 400) + '…(截斷)' : v;
    }
    const s = JSON.stringify(copy);
    console.warn(`[${PLUGIN_ID}][${reqNo}] 🔎 SDK result 原文：${s.length > 1200 ? s.slice(0, 1200) + '…(截斷)' : s}`);
  } catch {}
}

// ── 快取讀數（26-08-01 加）─────────────────────────────────────────
// 為什麼要撈這個：走訂閱額度時，省不省得下來幾乎全看提示詞前綴有沒有命中快取
// （命中的部分只算約十分之一）。但「有沒有命中」原本完全看不見——usage 拿到了，
// 印出來的只有 in/out 兩個數字，所以只能憑感覺猜。
//
// **刻意不寫死欄位名**。usage_EXPERIMENTAL() 是實驗性 API，欄位名不保證跟
// Messages API 一樣（`cache_read_input_tokens` / `cache_creation_input_tokens`），
// 也可能包在子物件裡。寫死名字的失效方式最陰險：不會報錯，只會印出 undefined，
// 看起來就像「這裡沒有快取」——拿著一份含有答案的資料，回報查不到。
// 所以改成掃描：把所有名字含 cache 的數值欄位撈出來，讓資料自己說它叫什麼。
function collectCacheFields(usage) {
  const out = {};
  const scan = (obj, prefix, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 2) return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number') {
        if (/cache/i.test(k) || /cache/i.test(prefix)) out[prefix + k] = v;
      } else if (v && typeof v === 'object') {
        scan(v, prefix + k + '.', depth + 1);
      }
    }
  };
  scan(usage, '', 0);
  return out;
}

function sumMatching(fields, re) {
  let n = 0;
  for (const [k, v] of Object.entries(fields)) if (re.test(k)) n += v;
  return n;
}

// 快取讀數落檔（26-08-01 加）。
// 為什麼不能只靠 console.log：酒館多半是無視窗啟動的（實測本機這台就是——
// 父行程早就結束、沒有主控台），所以 stdout 根本沒有人接。log 印得再漂亮，
// 看不到就等於沒印。這是門鈴那次踩過的同一個結構：**沒有人在看的執行路徑，
// 紀錄要自己帶**。所以另外寫一個檔，一次請求一行。
//
// 刻意選 JSONL：一行一筆、壞一行不影響其他行、隨時可以用 tail 看尾巴。
// 寫入失敗一律吞掉——這是診斷用的東西，不該有能力讓對話失敗。
const CACHE_LOG_MAX_BYTES = 2 * 1024 * 1024;   // 超過就從頭砍一半，不無限長大
let cacheLogError = null;   // 落檔失敗的原因，帶進回應裡（見下）
function appendCacheLog(entry) {
  try {
    const file = path.join(__dirname, 'cache-log.jsonl');
    try {
      const st = fs.statSync(file);
      if (st.size > CACHE_LOG_MAX_BYTES) {
        const kept = fs.readFileSync(file, 'utf8').split('\n').slice(-2000).join('\n');
        fs.writeFileSync(file, kept, 'utf8');
      }
    } catch {}
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    cacheLogError = null;
  } catch (e) {
    // 吞掉例外是對的（診斷用的東西不該讓對話失敗），但**不能靜默**——
    // 靜默吞錯會讓「上線即失效」長得跟「正常運作」一模一樣。
    // 所以記下原因，隨回應的 usage.cache.log_error 一起送出去，看得見。
    cacheLogError = String(e && e.message || e).slice(0, 200);
  }
}

// 取 usage（串流與非串流共用）。
// 原本兩處都是 `try { … } catch {}`——**靜默吞錯**，所以「SDK 沒給 usage」
// 跟「呼叫拋錯了」長得一模一樣，兩種都只會印成 usage=n/a。
// 26-08-01 實測就卡在這裡：落檔 in/out 全是 null，卻看不出是哪一種。
// 改成把原因留下來，讓資料自己說話。
// **方法名也不寫死**（26-08-01 實測教訓）：原本硬呼叫 `usage_EXPERIMENTAL()`，
// 而 SDK 0.3.216 已經把它改名成 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`
// ——名字本身就是警告。舊呼叫拋 "is not a function"，被 catch{} 吞掉，
// log 一路印 usage=n/a，沒人發現壞了多久。
// 改成：先掃出 q 上所有名字含 usage 的方法，依序試，回傳第一個成功的。
// 這樣 SDK 下次再改名也不會再靜默壞掉。
let lastUsageError = null;
let usageMethodUsed = null;
function findUsageMethods(q) {
  const names = new Set();
  for (const k of Object.keys(q || {})) if (typeof q[k] === 'function' && /usage/i.test(k)) names.add(k);
  let proto = Object.getPrototypeOf(q || {});
  let depth = 0;
  while (proto && depth < 3) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (/usage/i.test(k)) { try { if (typeof q[k] === 'function') names.add(k); } catch {} }
    }
    proto = Object.getPrototypeOf(proto);
    depth++;
  }
  // 長名（帶警語那個）排前面：它是比較新的命名
  return [...names].sort((a, b) => b.length - a.length);
}

async function readUsage(q) {
  const candidates = findUsageMethods(q);
  if (!candidates.length) {
    lastUsageError = 'q 上找不到任何名字含 usage 的方法';
    usageMethodUsed = null;
    return undefined;
  }
  const errs = [];
  for (const name of candidates) {
    try {
      const u = await q[name]();
      if (u !== undefined && u !== null) {
        lastUsageError = null;
        usageMethodUsed = name;
        return u;
      }
      errs.push(`${name}: 回傳空值`);
    } catch (e) {
      errs.push(`${name}: ${String(e && e.message || e).slice(0, 80)}`);
    }
  }
  lastUsageError = errs.join(' / ').slice(0, 300);
  usageMethodUsed = null;
  return undefined;
}

// ── 前綴指紋（26-08-02 加，CX-260802-01 定位用）──────────────────────
// 要解的問題：快取每輪整包重寫、一次都沒讀到（十發實測）。而 spike 證明
// 「攤平送出不是問題，只要前面那段逐字不變就會命中」——所以一定有東西
// 插在前面、每輪在變，但不知道是哪一段。
//
// 做法：把送出去的內容切段，每段只記 SHA256 前 8 碼。兩輪一比，
// 從第幾段開始雜湊不同，那段就是兇手。
//
// **只記雜湊不記原文**——使用者的 RP 內容不落盤，這是紅線（同族：26-07-29
// 密鑰偵察全程用遮罩與指紋比對，不讓值進畫面就是不讓它進雲端）。
// 預設關（`TCB_PREFIX_TRACE=1` 才開），因為它每輪都要寫檔。
// 每段字元數。4000 是第一輪的粗掃粒度（22 段，夠定位到「哪一區」）；
// 要精確到「哪一句」就調小重測，例如 TCB_PREFIX_CHUNK=500。
// 26-08-02 首輪實測：4000 粒度已定位到 S03（系統提示第 12000~16000 字元）。
const PREFIX_CHUNK = Math.max(100, parseInt(process.env.TCB_PREFIX_CHUNK, 10) || 4000);
const PREFIX_LOG_MAX_BYTES = 2 * 1024 * 1024;
function tracePrefix(systemPrompt, prompt, reqNo) {
  if (process.env.TCB_PREFIX_TRACE !== '1') return;
  try {
    const segs = [];
    const cut = (label, text) => {
      const s = typeof text === 'string' ? text : '';
      for (let i = 0; i < s.length; i += PREFIX_CHUNK) {
        const part = s.slice(i, i + PREFIX_CHUNK);
        segs.push({
          id: `${label}${String(Math.floor(i / PREFIX_CHUNK)).padStart(2, '0')}`,
          len: part.length,
          h: createHash('sha256').update(part).digest('hex').slice(0, 8),
        });
      }
    };
    cut('S', systemPrompt);   // 系統提示（角色卡＋預設前段）
    cut('P', prompt);         // 對話流（攤平後那一大串）
    const file = path.join(__dirname, 'prefix-log.jsonl');
    try {
      const st = fs.statSync(file);
      if (st.size > PREFIX_LOG_MAX_BYTES) {
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').slice(-500).join('\n'), 'utf8');
      }
    } catch {}
    fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), n: reqNo, segs }) + '\n', 'utf8');
  } catch (e) {
    // 不能靜默吞——靜默會讓「上線即失效」長得跟「正常運作」一模一樣（8/01 的課）
    console.warn(`[${PLUGIN_ID}] 前綴指紋記錄失敗：${String((e && e.message) || e).slice(0, 120)}`);
  }
}

// 從 SDK 的 usage 回應撈出這次要的三組數字。
// 結構（0.3.216 實測）：session.model_usage[<模型名>] 底下才是 inputTokens /
// outputTokens / cacheReadInputTokens / cacheCreationInputTokens（**駝峰、三層巢狀**）；
// 另外 rate_limits.five_hour / seven_day 帶訂閱額度的使用率——這是意外收穫。
function flattenUsage(u) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0, models: [] };

  // ⚠️ 三種形狀是**同一份資料的不同表示**，只能擇一——兩個都累加會重複計算，
  // 顯示的用量直接翻倍（26-08-01 差點犯，跟 prompt_tokens 那次同款）。
  // 優先序：modelUsage（分模型、資訊最多）→ session.model_usage（控制 API）
  //        → usage（Messages API 總計，最後備援）
  const mu = u?.modelUsage || u?.session?.model_usage;
  if (!mu) {
    const mapi = u?.usage;
    if (mapi && typeof mapi === 'object') {
      out.input = mapi.input_tokens || 0;
      out.output = mapi.output_tokens || 0;
      out.cacheRead = mapi.cache_read_input_tokens || 0;
      out.cacheWrite = mapi.cache_creation_input_tokens || 0;
      out.source = 'usage';
    }
  }
  if (mu && typeof mu === 'object') {
    out.source = u?.modelUsage ? 'modelUsage' : 'session.model_usage';
    for (const [name, m] of Object.entries(mu)) {
      if (!m || typeof m !== 'object') continue;
      out.models.push(name);
      out.input += m.inputTokens || 0;
      out.output += m.outputTokens || 0;
      out.cacheRead += m.cacheReadInputTokens || 0;
      out.cacheWrite += m.cacheCreationInputTokens || 0;
      out.costUSD += m.costUSD || 0;
      // 明細：加總會把「SDK 另外叫了誰」藏起來
      (out.perModel ||= {})[name] = {
        in: m.inputTokens || 0, out: m.outputTokens || 0,
        cR: m.cacheReadInputTokens || 0, cW: m.cacheCreationInputTokens || 0,
        cost: Number((m.costUSD || 0).toFixed(6)),
      };
    }
  }
  const rl = u?.rate_limits;
  if (rl) {
    if (rl.five_hour) out.fiveHourPct = rl.five_hour.utilization ?? null;
    if (rl.seven_day) out.sevenDayPct = rl.seven_day.utilization ?? null;
    if (rl.five_hour?.resets_at) out.fiveHourResetsAt = rl.five_hour.resets_at;
    if (rl.seven_day?.resets_at) out.sevenDayResetsAt = rl.seven_day.resets_at;
  }
  if (u?.subscription_type) out.plan = u.subscription_type;
  return out;
}

// 一次請求收尾時記帳（串流與非串流共用）。
//
// **為什麼一定要共用**：這支有兩份幾乎一樣的收尾邏輯（串流一份、非串流一份）。
// 26-08-01 第一版只改了非串流那份就交件——而酒館預設走串流，等於整個功能
// 在真實使用情境下一次都不會被觸發，單測全過也照樣是廢的。
// 抽成一支的意義不是少寫幾行，是**下次再加東西時不可能只加一半**。
function recordUsage(usage, ctx) {
  // 先走已知結構（session.model_usage 那條，0.3.216 實測），
  // 掃描當備援——SDK 換結構時仍撈得到，不會靜默歸零
  const flat = flattenUsage(usage);
  const cacheFields = collectCacheFields(usage);
  const cacheRead = flat.cacheRead || sumMatching(cacheFields, /read/i);
  const cacheWrite = flat.cacheWrite || sumMatching(cacheFields, /creat|write/i);
  const cacheOther = sumMatching(cacheFields, /^(?!.*(read|creat|write)).*$/i);
  const inTok = flat.input || usage?.input_tokens || 0;
  const outTok = flat.output || usage?.output_tokens || 0;
  // 命中率分母＝這次真正處理的輸入量（未快取＋快取讀）
  const inputTotal = inTok + cacheRead;
  const hitPct = inputTotal > 0 ? Math.round((cacheRead / inputTotal) * 100) : null;

  // 累計進面板要顯示的統計。只有真的拿到 usage 才記——拿不到就記 0 會把倍數稀釋，
  // 而那種稀釋看起來像「快取效果變差」，是會害人查錯方向的假訊號。
  if (usage) {
    cacheTally.requests++;
    if (ctx.splitApplied) cacheTally.splitApplied++;
    // 不拆的理由要留最後一筆——面板的警告靠它把「沒生效」講成「為什麼沒生效」。
    else if (ctx.splitReason) cacheTally.lastSkipReason = ctx.splitReason;
    if (ctx.splitDivergence !== undefined) cacheTally.lastDivergence = ctx.splitDivergence;
    if (ctx.splitZone !== undefined) cacheTally.lastDivergenceZone = ctx.splitZone;
    if (ctx.systemDrift !== undefined) cacheTally.lastSystemDrift = ctx.systemDrift;
    cacheTally.input += inTok;
    cacheTally.cacheRead += cacheRead;
    cacheTally.cacheWrite += cacheWrite;
    cacheTally.output += outTok;
    cacheTally.costUsd += ctx.costUsd || 0;
    cacheTally.prevCostUsd = cacheTally.lastCostUsd;
    cacheTally.lastCostUsd = ctx.costUsd || 0;
  }

  // 首次請求把 usage 的欄位名列一次——欄位名跟預期不同時，這是唯一的線索。
  // 只印一次，維持這支「正常路徑零噪音」的規矩。
  if (ctx.reqNo === 1 && usage) {
    console.log(`[${PLUGIN_ID}] usage 欄位一覽（只印一次，供對帳）：${describeUsageShape(usage)}`);
  }

  const cacheNote = !usage
    ? ''
    : Object.keys(cacheFields).length === 0
      ? ' cache=無此欄位'
      : ` cacheRead=${cacheRead} cacheWrite=${cacheWrite}${cacheOther ? ` cacheOther=${cacheOther}` : ''}${hitPct === null ? '' : ` hit=${hitPct}%`}`;

  // 訂閱額度使用率（SDK 順便給的，對訂閱制使用者比 token 數更有感）
  const quotaNote = (flat.fiveHourPct != null || flat.sevenDayPct != null)
    ? ` 額度[5h=${flat.fiveHourPct ?? '?'}% 7d=${flat.sevenDayPct ?? '?'}%]`
    : '';

  console.log(`[${PLUGIN_ID}][${ctx.reqNo}] model=${ctx.modelId} effort=${ctx.effort} ${ctx.shape}${ctx.imgCount ? ` img=${ctx.imgCount}` : ''} cost=$${ctx.costUsd.toFixed(4)} total=$${totalCostUsd.toFixed(4)}${usage ? ` in=${inTok} out=${outTok}` : ' usage=n/a'}${cacheNote}${quotaNote}${ctx.suffix || ''}`);

  // 同一份資料落檔一份——上面那行 console 在無視窗啟動的酒館裡沒有人接得到
  appendCacheLog({
    t: new Date().toISOString(),
    n: ctx.reqNo,
    mode: ctx.mode,               // stream | json，用來確認兩條路都有記到
    model: ctx.modelId,
    effort: ctx.effort,
    in: usage ? inTok : null,
    out: usage ? outTok : null,
    cacheRead,
    cacheWrite,
    hitPct,
    // 訂閱額度使用率——SDK 順便給的，比 token 數對訂閱制更有意義
    ...(flat.fiveHourPct != null ? { quota5hPct: flat.fiveHourPct } : {}),
    ...(flat.sevenDayPct != null ? { quota7dPct: flat.sevenDayPct } : {}),
    ...(flat.sevenDayResetsAt ? { quota7dResetsAt: flat.sevenDayResetsAt } : {}),
    ...(flat.plan ? { plan: flat.plan } : {}),
    ...(usageMethodUsed ? { via: usageMethodUsed } : {}),
    // 每個模型分開記（26-08-01 加）：實測同一個請求的 in 會在兩個數字間跳，
    // 而 modelUsage 裡不只主模型——SDK 有時會另外叫 Haiku 做雜務，那也在算帳。
    // 加總會把這件事藏起來，所以明細要留。
    ...(flat.perModel && Object.keys(flat.perModel).length > 1 ? { perModel: flat.perModel } : {}),
    ...(flat.models?.length ? { models: flat.models } : {}),
    ...(flat.source ? { src: flat.source } : {}),
    cost: Number(ctx.costUsd.toFixed(6)),
    ...(ctx.aborted ? { aborted: true } : {}),
    // 拿不到 usage 時，把原因帶著——不然「SDK 沒給」跟「呼叫拋錯」看起來一樣
    ...(usage ? {} : { usageError: lastUsageError || '(未記錄)' }),
    ...(cacheLogError ? { logError: cacheLogError } : {}),
    // 首筆帶欄位名一覽：欄位名跟預期不同時，這是對帳的依據
    ...(ctx.reqNo === 1 && usage ? { usageShape: Object.keys(collectCacheFields(usage)) } : {}),
  });

  return { cacheFields, cacheRead, cacheWrite, hitPct };
}

// 首次請求印一次 usage 的形狀（欄位名＋型別，不印值以外的東西）。
// 欄位名跟預期不同時，這行是唯一的線索；印一次就好，維持正常路徑零噪音。
function describeUsageShape(usage) {
  try {
    const parts = [];
    const walk = (obj, prefix, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 2) return;
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object') walk(v, prefix + k + '.', depth + 1);
        else parts.push(`${prefix}${k}=${typeof v === 'number' ? v : typeof v}`);
      }
    };
    walk(usage, '', 0);
    const s = parts.join(' ');
    return s.length > 600 ? s.slice(0, 600) + '…(截斷)' : s;
  } catch { return '(讀不到)'; }
}

// 執行環境指紋（啟動時印一次）。
// 為什麼需要（26-07-29 外部使用者案的直接教訓）：對方自己測到「同一份 SDK、同樣參數，在她的程式裡
// 跑正常，**透過酒館就全失敗，連 Haiku 都失敗**」——差異只剩「跑在哪個進程裡」。
// SDK 是靠 spawn `claude` 子程序工作的，所以 ST 進程的 node 版本、cwd、家目錄、
// 有沒有自訂 CLAUDE_CONFIG_DIR，全都會影響它找不找得到 CLI 與登入憑證。
// 這幾行印出來，下次同型問題五分鐘就能對帳，不必再花一晚做排除法。
// 只印「有沒有／叫什麼」，不印 PATH 全文與任何憑證內容。
function logEnvFingerprint() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '(未設)';
    const cfgDir = process.env.CLAUDE_CONFIG_DIR;
    console.log(
      `[${PLUGIN_ID}] 執行環境：node ${process.version}｜platform ${process.platform}`
      + `｜cwd ${process.cwd()}`
      + `｜家目錄 ${home === '(未設)' ? '⚠️ 未設' : '已設'}`
      + `｜CLAUDE_CONFIG_DIR ${cfgDir ? cfgDir : '(未設，走預設 ~/.claude)'}`
    );
  } catch {}
}

function renderTurn(m) {
  const tag = m.role === 'user' ? 'user' : (m.role === 'system' ? 'system' : 'reply');
  return `<${tag}>\n${m.content}\n</${tag}>`;
}

// 位置語義（26-07-27 大修）：
// 舊版把所有 role=system 不分位置一律搬進系統提示的最前面。酒館的注入是**帶位置的**——
// 世界書 depth、作者註記、post-history 指令都靠位置生效，全部搬到最前面等於改寫了酒館的語義。
// 實案：一位外部使用者的預設有 94 則 system、其中 93 則穿插在對話中間、最後一則也是 system，
// 症狀＝不照格式輸出；另一位使用者同病輕度（5 條 depth 注入裡的「導演指令 depth=1」被搬位，
// 病徵是模型在思考裡手工重建該判定，讀聊天記錄檔才抓到現場）。
//
// 核心規則：**header 區才是系統提示；對話開始之後的每一則 system 都留在它原本的位置。**
// bridge 是橋，不是編輯。「header 到哪裡為止」的判準見下方兩段式說明。
//
// ── header 到哪裡為止：兩段式判準（26-07-27 第三版，外部使用者兩份驗收報告逼出來的）──
//
// 判準一（嚴格，預設走這條）：開頭連續的 system，空白佔位訊息跳過不算數。
//   涵蓋絕大多數預設。正常對話 `system…, user(第一句), assistant(回應)…` 完全正確。
//
// 判準二（救援，只在判準一拼不出系統提示卻確實有 system 訊息時啟用）：
//   第一則 assistant 之前全歸 header。
//   為什麼需要它：該使用者的預設把 `[PERSONA·STORYTELLER]` 和 `---` **指定為 user 角色**
//   排在最前面（有實質內容，判準一在 index 0 就結束），結果 94 則 system 全落進
//   對話流、系統提示是空的。她的 header 區長達 41 則且完全沒有 assistant——
//   「角色說過話才代表對話開始了」在這種形狀下是可靠訊號。
//
// 為什麼不無條件用判準二：一般對話的第一則 assistant 前面那個 user 是**玩家的第一句話**，
//   無條件套用會把它吃進系統提示（實測打掉 7 組既有案例）。兩者無法用結構分辨，
//   所以只在判準一確實失敗時才啟用救援，不拿正常情況去賭。
//
// 判準二的失效情形（該使用者自己指出）：整份沒有 assistant 時會吃掉玩家那句 → 退到
//   「最後一則 user 之前」保住它。
/**
 * 這則訊息「實質上是空的」嗎？——三種格式都要看得懂。
 * 有圖片就不算空（圖片本身就是內容）；文字塊陣列要看塊裡的文字。
 */
function blankContent(content) {
  if (typeof content === 'string') return content.trim() === '';
  if (Array.isArray(content)) {
    if (content.some(p => p && p.type === 'image_url')) return false;
    return !content.some(p => p && typeof p.text === 'string' && p.text.trim() !== '');
  }
  return content == null ? true : String(content).trim() === '';
}

function strictHeaderEnd(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'system') continue;
    // 「空白」要看得懂三種格式，不然對話開頭會被誤判成 header（26-08-27 實案）：
    //   字串／文字塊陣列／含圖片的陣列。舊版只認字串，**分塊格式的訊息一律當成空白跳過**，
    //   headerEnd 因此一路往後跑，真實對話的開頭被吃進系統提示區——
    //   使用者看到的「歷史只有 5 則」不是他對話短，是這裡認錯了地方。
    //   抓到它的方式：同一則訊息，這裡當它空白、describeDivergentTurn 卻算得出 56 字元。
    //   **兩支函式對同一份資料判定不一致，就是有一支錯了。**
    const isBlank = blankContent(m.content);
    if (isBlank) continue;      // 空白佔位不算對話開始
    return i;
  }
  return messages.length;
}

function rescueHeaderEnd(messages) {
  if (!Array.isArray(messages)) return 0;
  const firstBot = messages.findIndex(m => m && m.role === 'assistant');
  if (firstBot < 0) {
    // 沒有 assistant（新聊天：只有設定，玩家剛送出第一句還沒收到回覆）。
    // **保住當前訊息**——回 messages.length 會把玩家正在送出的那句也吃進 header。
    // 這條路徑目前幾乎不可達（上游閘門會先攔下 strictEnd===0 的情形），
    // 但改寫時我差點把它弄丟，而「不可達」不等於「不可能」：上游判準一改它就活了。
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user') return i;
    }
    return messages.length;
  }

  // 從第一個 assistant **往回走**，遇到 system 就停（26-08-28 第四刀）。
  //
  // 舊版直接回 firstBot，假設「角色說過話才代表對話開始」。那對純設定區塊成立，
  // 但漏掉這種形狀（26-08-28 外部回報，跑 v1.7.7 仍中）：
  //   設定區塊（user/system 交錯）… 真實對話 … 第一個 assistant
  // 第一個 assistant 之前確實有 system（設定區塊裡的），v1.7.7 的閘門因此放行 rescue，
  // 而 rescue 一路吃到 assistant——**把夾在中間的對話一起吃進系統提示區**。
  // 使用者看到診斷指著她自己打的話說「它在系統提示區」，差點又去改世界書。
  //
  // 判準：設定區塊是 user/system 交錯的（每塊設定後面還有別的設定），
  // 而**對話一旦開始就不會再夾 system**——注入都排在對話之後。
  // 所以從 firstBot 往回收，收到最後一則 system 為止；那之後的都是對話。
  let end = firstBot;
  for (let i = firstBot - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'system') break;   // 碰到設定就停，這裡就是 header 的盡頭
    end = i;                          // 這則不是 system 且後面沒 system → 它是對話
  }
  return end;
}

function parseMessages(messages) {
  const strictEnd = strictHeaderEnd(messages);
  const strict = parseWithHeaderEnd(messages, strictEnd);
  if (strict.systemPrompt || !messages.some(m => m && m.role === 'system')) return strict;

  // 判準一失敗且確實有 system → 本來會啟用救援（找第一個 assistant 當邊界）。
  // **但救援只在「header 區確實存在、只是開頭不是 system」時才成立。**
  //
  // 26-08-28 實案：使用者的對話開頭就是玩家發言，strictEnd 因此是 0——
  // 代表「這份訊息根本沒有 header 區」，不是「header 判錯了」。舊碼分不出這兩者，
  // 一律去救，於是 rescue 一路找到第一個 assistant，把開頭 22 則對話全吃進系統提示區。
  // 診斷因此每則都在那裡報變動點，而使用者差點照著去改世界書——那完全救不了。
  //
  // 抓到它的是 v1.7.6 新加的「內容開頭片段」：只看 role 與長度時它像個設定條目，
  // 印出開頭「我看了一眼被夾回來的食物…」一看就知道是 RP 對白。
  // **診斷夠具體，才分得出「使用者的東西」與「我的錯」。**
  // 兩種形狀在訊息結構上長得一樣，但語義相反，判準是「第一個 assistant 之前有沒有 system」：
  //
  //   形狀 A（26-07-27 回報）：usr([PERSONA]), sys([BASELINE]), sys(...), usr(---), sys(...), bot(開場白)
  //     → 預設把設定條目標成 user，**中間夾著 system**。那些 user 是設定，該救。
  //
  //   形狀 B（26-08-28 回報）：usr×21（玩家發言）, bot(回覆), sys(注入), ...
  //     → 第一個 assistant 之前**一則 system 都沒有**。那些 user 是真對話，不該救。
  //
  // 為什麼這條分得開：預設區塊是 system/user 交錯的（不同條目被標成不同角色），
  // 而真實對話的開頭不會夾 system——system 注入都排在對話開始之後。
  if (strictEnd === 0) {
    const firstBot = messages.findIndex(m => m && m.role === 'assistant');
    const 前面有system = firstBot > 0
      && messages.slice(0, firstBot).some(m => m && m.role === 'system');
    if (!前面有system) return strict;   // 開頭是純對話＝真的沒有 header，不要硬救
  }

  return parseWithHeaderEnd(messages, rescueHeaderEnd(messages));
}

// ── 拆塊第一階：只量不動（26-08-02）────────────────
//
// 為什麼先做一個「不改行為的量測模式」，而不是直接貼標記：
//   斷點算錯的失效方式是**安靜的**——照樣有命中，只是少省一半，讀數看起來很正常。
//   所以先讓儀器上線、拿真實對話驗斷點算得對不對，數字對了再讓修法上線。
//   （今天的帳：合成題測不到會動的場景；沒有真實基準就改行為，等於拿使用者當測試環境。）
//
// 開關：TCB_TURN_TRACE=1。預設關，關著的時候這段一步都不走。
let prevTurnFps = null;   // 上一發的逐則指紋（記憶體即可，橋重啟歸零＝第一發走 fallback，安全）
// **基準要綁對話**（26-08-28 第五種變形，外部回報催出來的）：
// prevTurnFps 原本是純全域，換一個聊天／換角色卡照樣拿來比——第一個對不上的位置
// 就成了「假的變動點」，而且**它會落在對話開頭**（共用角色卡時 header 一樣、對話不同）。
// 使用者看到的正是「對話區第 0 則每則都在變」，然後照著去翻自己那則寫定的舊對話——
// 那則什麼事都沒有。**我今天已經犯過一次同型（儀器說謊、害三個人追一整夜）。**
//
// 綁法：用 systemPrompt 的雜湊當對話識別。橋看不到酒館的 chat id，但同一個對話的
// header（角色卡＋預設＋常駐世界書）是穩定的；換卡換聊天它就變。
// 不完美（同一張卡開兩個聊天會撞），但比純全域好一個量級，而且不用跨進酒館的檔案結構。
let prevTurnKey = null;
const splitState = { sticky: null };   // 上次實際用過的斷點（黏住用；重啟歸零＝重新建一次，安全）
const TURN_LOG_MAX_BYTES = 2 * 1024 * 1024;
// **一發只准算一次**：量測模式與拆塊模式都要用這個結果，各自算一次的話，
// 第二次會拿「這一發自己」當基準（prevTurnFps 已被第一次更新掉），分歧點變成整串長度、
// 斷點直接跑到最尾巴——而那看起來像「這發超級穩定」，是會騙人的那種錯。
export function evaluateBreakpoint(messages, headerEnd, convKey) {
  // 對話換了就丟掉基準——拿別的對話當基準，算出來的分歧點是假的（見 prevTurnKey 註解）。
  // convKey 拿不到時（呼叫端沒給）維持舊行為，不要在這裡自己造一個半吊子的識別。
  if (convKey !== undefined && convKey !== prevTurnKey) {
    prevTurnFps = null;
    prevTurnKey = convKey;
  }
  const decision = decideBreakpoint(messages, prevTurnFps, {
    headerEnd,
    safetyTurns: Math.max(0, parseInt(process.env.TCB_SAFETY_TURNS, 10) || 1),
    fallbackDepth: Math.max(1, parseInt(process.env.TCB_FALLBACK_DEPTH, 10) || 8),
  });
  const prevFps = prevTurnFps;
  prevTurnFps = fingerprintTurns(messages);
  return { decision, prevFps, fps: prevTurnFps };
}

/** 對話識別：header 的雜湊。同一張卡＋同一組設定＝同一個對話串。 */
export function conversationKey(systemPrompt) {
  return createHash('sha1').update(String(systemPrompt || '')).digest('hex').slice(0, 12);
}

function traceTurns(messages, headerEnd, reqNo, evaluated, splitInfo) {
  if (process.env.TCB_TURN_TRACE !== '1') return;
  try {
    const { decision, prevFps, fps } = evaluated || evaluateBreakpoint(messages, headerEnd);
    const entry = {
      t: new Date().toISOString(),
      n: reqNo,
      total: messages.length,
      headerEnd,
      // 拆塊實況：開關開了沒／有沒有真的拆／切在哪。沒有這格的話，
      // 「標記沒貼上去」與「貼了但沒作用」在 cacheRead 上完全同形，查不出來。
      split: splitInfo || { enabled: splitEnabled(), applied: false, reason: '本次呼叫沒帶 splitInfo' },
      divergence: decision.divergence,
      breakpoint: decision.index,
      // 距尾第幾則——這是跟施工卡規格對話用的單位
      depthFromTail: decision.index ? messages.length - decision.index : null,
      source: decision.source,
      why: decision.why,
      // 每則只留 role 與長度，不留內容（結構模式的紀律：看得出哪裡變了，看不到寫了什麼）
      turns: messages.map((m, i) => ({
        i,
        role: m?.role || '?',
        len: typeof m?.content === 'string' ? m.content.length : -1,
        // 比的是 prevFps（上一發），**不是 prevTurnFps**——後者已經被 evaluateBreakpoint
        // 更新成這一發的指紋了，拿它比等於自己跟自己比，changed 會全部是 false。
        // （26-08-02：這個坑我在 evaluateBreakpoint 上面才寫過警告，然後在下面十行踩進去，
        //   測試「被改寫那則有標 changed」當場抓到。註解擋不住，測試擋得住。）
        changed: prevFps ? (prevFps[i] !== fps[i]) : null,
      })),
    };
    const file = path.join(__dirname, 'turn-log.jsonl');
    try {
      const st = fs.statSync(file);
      if (st.size > TURN_LOG_MAX_BYTES) {
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').slice(-200).join('\n'), 'utf8');
      }
    } catch {}
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    console.log(`[${PLUGIN_ID}] 斷點量測 #${reqNo}：${decision.source} 斷在第 ${decision.index}/${messages.length} 則` +
                `${decision.divergence !== null ? `（第一個變動在 ${decision.divergence}）` : ''}`);
  } catch (e) {
    // 不靜默吞——靜默會讓「上線即失效」長得跟「正常運作」一樣（8/01 的課，同 tracePrefix）
    console.warn(`[${PLUGIN_ID}] 斷點量測失敗：${String((e && e.message) || e).slice(0, 120)}`);
  }
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
    // 那些是指令不是對話，酒館把它們標成 user 只是格式選擇（外部使用者的預設實況）。
    if (!headerDone) {
      systemParts.push(content);
      continue;
    }

    // _srcIdx＝這則在原始 messages 裡的位置。拆塊的斷點是用 messages 座標算的，
    // 但 flow 會跳過 null 元素（澄衡 26-07-21 那條低危的防護），兩邊用減法對齊遲早錯位一則——
    // 而錯位一則的後果是斷點落進會動區，症狀又是「有命中但少一截」。讓每則自己記住出處。
    flow.push({ role: msg.role, content, images, _srcIdx: idx });
  }

  // 空段落要濾掉再 join——否則兩則空 system 會拼出 "\n\n"，那是 truthy，
  // 等於送一個「看起來有、其實空白」的系統提示出去（Grok MED-2）。
  const systemPrompt = systemParts.filter(s => s.trim() !== '').join('\n\n') || undefined;

  // 當前訊息取「最後一則 **user**」，不是「最後一則」——depth=0 的注入會排在玩家發言之後，
  // 舊版直接把它當成玩家現在說的話送出去（外部使用者案：最後一則是 MVU 規則）。
  let curIdx = -1;
  for (let i = flow.length - 1; i >= 0; i--) {
    if (flow[i].role === 'user') { curIdx = i; break; }
  }

  let prompt;
  let images = [];
  // 拆塊要用的兩件（26-08-02，CX-260802-03 第二階）：歷史區逐則渲染後的字串，與歷史之後的整段。
  // 不另外重組——直接把組 prompt 當下的中間產物留下來，這樣「拆完接回來一字不差」是結構保證，
  // 不是靠兩段程式碼各自算一次然後祈禱相同。
  let historyTurns = null;   // string[]｜null＝這發沒有 <history> 區（不可拆）
  let historyMsgIdx = null;  // 每則歷史對應的原始 messages 索引（斷點座標換算用，不做減法）
  let tailText = '';         // <history> 之後的全部（含前面的 \n\n 分隔）

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
    // 整段歷史的圖全帶會讓長對話的 token 成本爆掉（26-07-25 取捨）。
    images = cur.images || [];

    const parts = [];
    if (before.length) {
      historyTurns = before.map(renderTurn);
      historyMsgIdx = before.map(t => t._srcIdx);
      parts.push(`<history>\n${historyTurns.join('\n')}\n</history>`);
    }
    parts.push(cur.content);
    if (after.length) parts.push(after.map(renderTurn).join('\n'));
    prompt = parts.join('\n\n');
    if (historyTurns) tailText = prompt.slice(parts[0].length);   // 從 <history> 結束到最後，原樣切
  }

  // headerEnd 一起回傳：拆塊要知道「對話流從第幾則開始」，而這個判準只能有一份——
  // 讓外面自己再算一次，兩處遲早會漂（26-07-29 那課：改判準要把用同一個判準的地方全找出來）。
  return { systemPrompt, prompt, images, headerEnd, historyTurns, historyMsgIdx, tailText };
}

// 斷點座標換算：decideBreakpoint 給的是 messages 座標，切分要的是 historyTurns 座標。
// 用查表不用減法——中間可能有 null 被跳過（見 flow.push 的 _srcIdx 註解）。
// 回傳「歷史區前幾則算穩定」；0＝沒得切。
export function cutFromMessageIndex(historyMsgIdx, breakpointMsgIdx) {
  if (!Array.isArray(historyMsgIdx) || !(breakpointMsgIdx > 0)) return 0;
  let cut = 0;
  while (cut < historyMsgIdx.length && historyMsgIdx[cut] < breakpointMsgIdx) cut++;
  return cut;
}

// 把對話流切成「穩定塊＋會動塊」兩段（26-08-02，CX-260802-03 第二階）。
//
// **唯一不變式：兩塊的 text 接起來 === 不拆時的 prompt，一個字都不能差。**
// 內容只要動一個字，快取全盤落空，而症狀是「拆了反而沒省」——今晚最難查的那一型。
// 所以這裡不重新組裝任何東西，只在既有字串上切一刀。
//
// 切點 cut 是「歷史區的第幾則之後」（historyTurns 的索引）。回 null＝這發不拆。
//
// ttl 一律帶 '1h'：手動標記預設 5m，而 SDK 會在最後一塊自己補 1h，
// API 規定 1h 不得排在 5m 之後 → 整組 400（26-08-02 實測，request-018 為證）。
// 這條是結構必然不是經驗法則：SDK 補的位置永遠在我們後面。
/**
 * 把「變動點那一則是什麼」講出來（26-08-27，CX-260827-01）。
 *
 * 改版紀錄：第一版只在 divergence===0 時開口。當天傍晚使用者回報
 * `變動點在第 9 則（歷史 71 則）`——**落在中間，第一版一個字都講不出來**，
 * 而那正是最需要診斷的形狀：對話 71 則穩得很，前面系統提示區有一則每次都在變，
 * 快取從那裡斷掉、後面全部作廢。使用者拿到「第 9 則」還是不知道該去看什麼。
 *
 * **落在系統提示區還是對話區要分開講**，因為這決定了「拆塊救不救得了」：
 * 拆塊只切對話那一段，變動點在系統提示區時它完全無能為力——這句話不講白，
 * 使用者會以為調拆塊設定有用，然後白花一輪額度。
 *
 * 只讀 role 與長度，不碰內容——RP 內容不進 log（同族：tracePrefix 的隱私規則）。
 */
export function describeDivergentTurn(messages, divergence, headerEnd) {
  if (typeof divergence !== 'number' || !Number.isFinite(divergence)) return '';
  if (!Array.isArray(messages)) return '';
  const m = messages[divergence];
  if (!m) return '';   // 超出範圍：沒有那一則可講，不要瞎編

  const len = typeof m.content === 'string' ? m.content.length
    : Array.isArray(m.content) ? m.content.reduce((n, p) => n + ((p && p.text && p.text.length) || 0), 0)
    : 0;
  const role = m.role || '(未知)';
  const 界 = Number.isFinite(headerEnd) ? headerEnd : 0;
  const 在系統區 = divergence < 界;

  // 內容開頭：位置會漂、長度認不出來，這才是使用者真正能拿去比對的線索
  const 頭 = contentHead(m.content);
  const 片段 = 頭 ? `、開頭：「${頭}」` : '';

  const 位置說明 = 在系統區
    ? `它落在「系統提示區」（前 ${界} 則：角色卡、預設各條目、世界書常駐那些）——`
      + `拆塊救不了這種，因為拆塊只切對話那一段，而這一則排在對話前面，`
      + `它一變、後面整包作廢。要修得去關掉是誰在每則重算它`
    : `它落在「對話區」（第 ${divergence - 界} 則對話）——`
      + `通常是會回頭改寫舊訊息的機制（狀態欄寫回、變數系統更新舊樓）`;

  return `｜第 ${divergence} 則是 role=${role}、長度 ${len} 字元${片段}——${位置說明}`;
}

/**
 * 取內容開頭當「認得出來」的線索（26-08-27 深夜，外部使用者親自抓到的缺陷）。
 *
 * 為什麼要打破原本「完全不碰內容」的隱私線：使用者回報同一條東西，
 * 第 2 則時是「第 17 條」、第 3 則跑到「第 32 條」——**位置每則都在漂**
 * （前面某塊長度一變，後面全部推移），而我一整晚拿它當座標報給人。
 * 她照著找到的當然是別的東西，於是「你說它在長大／我看它沒在動」兩邊各說各話。
 * 位置不可用、長度＋role 也認不出來，**不給片段就等於沒有可操作的線索**。
 *
 * 三個限制讓這條線放得住：
 *   ① 只取開頭 30 字——足夠認出是哪一條，不足以還原 RP 內容
 *   ② 壓成單行——否則一則長訊息會把 log 撐爛
 *   ③ 只出現在使用者自己機器的終端機與面板，不上傳、不落遠端
 */
function contentHead(content, max = 30) {
  const raw = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(p => (p && typeof p.text === 'string') ? p.text : '').join('')
    : '';
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

function splitPromptBlocks(parsed, cut, modelId) {
  const turns = parsed && parsed.historyTurns;
  if (!Array.isArray(turns) || turns.length === 0) return null;
  if (!(cut > 0) || cut >= turns.length) return null;   // 沒東西可切或整段都算穩定＝不拆

  const stable = `<history>\n${turns.slice(0, cut).join('\n')}\n`;
  const moving = `${turns.slice(cut).join('\n')}\n</history>${parsed.tailText || ''}`;

  // 自檢：接不回去就不要送出去（寧可不拆，也不要送一份被動過的內容）
  if (stable + moving !== parsed.prompt) return null;

  // 份量閘（26-08-27，CX-260827-01）：塊短於模型最小可快取長度就**整個不拆**。
  // 貼一個低於門檻的標記不是「少省一點」，是**兩頭落空**——標記靜默失效，
  // 而其餘內容因為我們宣告了不貼、也拿不到斷點。不拆反而讓整包維持單一前綴。
  // 這道閘擋的是舊版用「則數」把關放行的那一型（實案：5 則＝226 字元）。
  if (!meetsCacheMinimum(stable, modelId)) return null;

  return [
    { type: 'text', text: stable, cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: moving },
  ];
}

// 多塊 prompt 包成串流輸入（形狀與 makeImagePrompt 同源——SDK 只吃 user 角色，
// 所以歷史不能裝成多則對話，只能是單則 user 底下的多個 content 塊。26-08-02 spike 實測）。
function makeSplitPrompt(blocks, images) {
  return (async function* () {
    yield {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [...blocks, ...(images || [])] },
    };
  })();
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
    const parsedMsgs = parseMessages(messages);
    const { systemPrompt, prompt, images, headerEnd } = parsedMsgs;
    // 斷點：量測模式與拆塊模式共用同一次計算（兩邊各算一次會讓第二次拿自己當基準，
    // 見 evaluateBreakpoint 的註解）。兩個開關都關著就完全不算，不付這個成本。
    const bpNeeded = process.env.TCB_TURN_TRACE === '1' || splitEnabled();
    const evaluated = bpNeeded ? evaluateBreakpoint(messages, headerEnd, conversationKey(systemPrompt)) : null;
    // 前綴指紋：只在 TCB_PREFIX_TRACE=1 時動作，兩條路徑（串流／非串流）都在這之後分岔，
    // 所以放這裡一次涵蓋——8/01 只改非串流那份、真實情境一次都沒觸發，不再犯。
    tracePrefix(systemPrompt, prompt, requestCount + 1);
    // 斷點量測（TCB_TURN_TRACE=1 才動）：算出斷點該落在哪一則並落檔，但**不改變送出去的東西**。
    // 放在同一個位置、同樣理由——兩條路徑在這之後才分岔。
    // traceTurns 移到拆塊決策之後（見下方）——落檔要記「這發到底有沒有真的拆」，
    // 不然「沒貼標記」與「貼了沒作用」在讀數上長得一模一樣，分不出來。
    // 26-08-02 首次上線就撞到這個缺口：cacheRead 沒跳，而我手上沒有任何資料能說是哪一種。
    // 請求形狀進 log：sys=0字/0則 一眼看出「角色卡沒送到」——酒館端把 system 拆掉時
    // （提示詞後處理選半嚴格/嚴格會把首則以外的 system 改成 user）症狀是模型跳出角色拒答，
    // 沒有這行就只能靠臨時插碼才診斷得出來（26-07-27 實案）。長度而已，不印內容。
    const sysCount = messages.filter(m => m && m.role === 'system').length;
    const shape = `sys=${systemPrompt ? systemPrompt.length : 0}字/${sysCount}則 msgs=${messages.length}`;

    // 有 system 訊息卻拼不出系統提示＝對話開頭就是使用者訊息，所有 system 都屬對話流。
    // 這是規則的正確行為（位置語義優先），但它讓「角色卡沒進系統提示」變成靜默狀態，
    // 所以出一次聲（每次啟動只講一次，不洗版）——外部使用者 26-07-27 驗收建議 (c)。
    if (!systemPrompt && sysCount > 0 && !warnedNoSystemPrompt) {
      warnedNoSystemPrompt = true;
      console.warn(`[${PLUGIN_ID}] 注意：本次請求有 ${sysCount} 則系統訊息，但系統提示是空的——你的對話開頭是使用者訊息，所以每一則 system 都留在對話流的原位（位置語義優先）。角色扮演若不穩定，可從預設的訊息結構查起。此訊息每次啟動只出現一次。`);
    }
    const completionId = `chatcmpl-${randomUUID().slice(0, 8)}`;
    // 有圖 → 串流輸入模式（SDK 才收得到 image block）；沒圖 → 維持原本的字串 prompt
    const hasImages = images.length > 0;

    // ── 拆塊（26-08-03 起預設開，面板可關；開關語義見 splitEnabled 上方）─────
    // 把對話流切兩塊、穩定那塊貼 cache_control(1h)，讓快取斷點落在「會動區之外」。
    // 三道閘任何一道不過就退回原本的單一字串——**寧可不省，也不要送出被動過的內容**。
    let splitBlocks = null;
    const splitInfo = { enabled: splitEnabled(), applied: false, cut: null, stableChars: null, movingChars: null, reason: null, sticky: null };

    // 系統提示有沒有在變（26-08-27，CX-260827-01 第四刀）。
    // 拆塊只管對話那一段，但 system 排在更前面——它動一個字，後面整包作廢，
    // 而症狀跟「拆塊沒生效」在讀數上完全同形（cacheRead 都是 0）。這一格是為了分得出來。
    // 只存雜湊不存原文（使用者的角色卡與預設不落盤）。
    const systemDrift = trackSystemPrompt(systemPrompt, splitState);
    if (systemDrift.changed) {
      cacheTally.systemDriftCount = (cacheTally.systemDriftCount || 0) + 1;
      console.warn(`[${PLUGIN_ID}] 第 ${requestCount + 1} 發：**系統提示跟上一發不一樣**`
        + `（雜湊 ${systemDrift.hash}）——它排在對話前面，一變整包快取就作廢，拆塊救不了。`
        + `常見來源：角色卡或預設裡有每則重算的內容（時間戳最常見）、剛改過設定、換了角色卡`);
    }
    // 第一發（沒有上一發可比）**不拆**。26-08-03 實測教訓：
    //   那時只能靠結構掃描猜位置，而結構掃描看不到改寫型機制（蛇），猜出來的 113 踩進會動區，
    //   害第二發被迫 forced 修正——等於白費一發。而第一發本來就在建立、貼了也讀不到，不虧。
    //   改成不拆之後：第二發（有量測值）建立、第三發起命中，比原本少繞一發。
    if (splitInfo.enabled && evaluated && evaluated.decision.divergence === null) {
      splitInfo.reason = '第一發沒有基準可比，不猜位置（猜錯會害下一發重建）';
    } else if (splitInfo.enabled && evaluated) {
      // 黏住斷點：貼標記的塊必須逐字不變才命中，所以不能讓斷點跟著對話一路前移
      // （26-08-03 spike 定案；沒有這層的話每發都在重建，五發實測全部只命中系統包）
      const held = stickyBreakpoint(evaluated.decision, splitState,
        Math.max(1, parseInt(process.env.TCB_JUMP_GAIN, 10) || 40));
      splitInfo.sticky = held;
      const cut = cutFromMessageIndex(parsedMsgs.historyMsgIdx, held.index);
      splitInfo.cut = cut;
      splitBlocks = splitPromptBlocks(parsedMsgs, cut, modelId);   // 內部會自檢「接回來一字不差」與份量門檻，不合就回 null
      if (splitBlocks) {
        splitInfo.applied = true;
        splitInfo.stableChars = splitBlocks[0].text.length;
        splitInfo.movingChars = splitBlocks[1].text.length;
        splitInfo.stableTokensEst = estimateTokens(splitBlocks[0].text);
        splitInfo.minTokens = minCacheTokensFor(modelId);
        console.log(`[${PLUGIN_ID}] 拆塊 #${requestCount + 1}：歷史 ${cut}/${parsedMsgs.historyTurns.length} 則進穩定塊` +
                    `（${splitInfo.stableChars} 字元／約 ${splitInfo.stableTokensEst} token 貼 1h 標記，門檻 ${splitInfo.minTokens}），` +
                    `其餘 ${splitInfo.movingChars} 字元不貼` +
                    `｜斷點 ${held.mode}${held.gain != null ? `（可多納 ${held.gain} 則）` : ''}`);
      } else {
        // 理由要分得出「切不出來」與「切得出來但份量不夠」——這兩件在 cacheRead 上完全同形，
        // 而後者正是 26-08-27 那個 bug 的臉。不分流的話，修好了也看不出修好沒有。
        const turns = parsedMsgs.historyTurns || [];
        const stablePreview = cut > 0 && cut < turns.length ? `<history>\n${turns.slice(0, cut).join('\n')}\n` : '';
        const est = estimateTokens(stablePreview);
        const min = minCacheTokensFor(modelId);
        splitInfo.stableTokensEst = est;
        splitInfo.minTokens = min;
        // cut=0 的時候「切不出來」講了等於沒講——使用者需要知道的是**哪裡在變**，
        // 因為那個東西在他的設定裡、只有他關得掉（26-08-27 實案：一位使用者拿到
        // 「切不出來（cut=0，歷史 32 則）」，訊息本身沒告訴她該去看哪裡）。
        // divergence 是「從頭數第幾則開始對不上」，換算成「距離最新第幾則」比較好懂。
        const div = evaluated && evaluated.decision ? evaluated.decision.divergence : null;
        // divergence===0 是最壞的一種：**整包從第一則就對不上**，快取一格都留不住。
        // 這時候「變動點在第 0 則」講了等於沒講——使用者需要知道**第 0 則是什麼東西**，
        // 才找得到是誰在改它。這個診斷要預設就有，不能還要人去開環境變數
        // （26-08-27 實案：兩位使用者都卡在 divergence=0，而 TCB_TURN_TRACE 預設關著，
        //  要他們開開關重跑等於再燒一次額度——診斷的成本不該由使用者付）。
        const 首則 = describeDivergentTurn(messages, div, parsedMsgs.headerEnd);
        const 變動位置 = div === null || div === undefined
          ? ''
          : `｜量到的變動點在第 ${div} 則（距離最新第 ${Math.max(0, messages.length - div)} 則）`
            + `——每則都有東西在改這個位置之前的內容，快取因此整包作廢。`
            + `常見來源：會把狀態寫回舊訊息的變數系統、每則重算的深度注入、系統提示裡的時間戳`
            + 首則;
        splitInfo.divergence = div ?? null;
        // 落在哪一區也存起來——面板要顯示，不能只活在終端機那行 log 裡
        splitInfo.zone = (typeof div === 'number' && Number.isFinite(parsedMsgs.headerEnd))
          ? (div < parsedMsgs.headerEnd ? 'system' : 'chat') : null;
        splitInfo.reason = stablePreview && est < min
          ? `穩定塊只有 ${stablePreview.length} 字元／約 ${est} token，低於 ${modelId || '(未指定模型)'} 的最小可快取長度 ${min}——貼了會被 API 靜默忽略，所以整發不拆`
          : `切不出來（cut=${cut}，歷史 ${turns.length} 則）${變動位置}`;
        console.log(`[${PLUGIN_ID}] 拆塊 #${requestCount + 1}：這發不拆（${splitInfo.reason}）`);
      }
    } else if (!splitInfo.enabled) {
      splitInfo.reason = SPLIT_LOCKED_OFF ? '拆塊被啟動參數鎖住（TCB_SPLIT=0）' : '拆塊開關關著（面板可開）';
    }
    // 落檔放這裡：要把「開關開了沒／有沒有真的拆／切在哪」寫進同一筆，
    // 讀數沒跳時才分得出「沒貼標記」與「貼了沒作用」——這兩件在 cacheRead 上完全同形。
    traceTurns(messages, headerEnd, requestCount + 1, evaluated, splitInfo);

    const buildPrompt = () => (
      splitBlocks ? makeSplitPrompt(splitBlocks, images)
        : hasImages ? makeImagePrompt(prompt, images)
          : prompt
    );

    if (stream === false) {
      try {
        let fullText = '';
        let thinkingText = '';
        let costUsd = 0;
      let resultUsage = null;      // result 訊息自帶的 usage（Messages API 形狀）
      let resultModelUsage = null; // result 訊息自帶的 modelUsage（駝峰形狀）
        const blockTypes = [];   // 這輪模型產出的 block 型別序列（空回覆診斷用）
        const diag = {};         // result 的 subtype/num_turns/is_error 與 stop_reason
        const q = queryFn({
          prompt: buildPrompt(),
          options: {
            systemPrompt: systemPromptForSdk(systemPrompt),
            tools: [],
            // 省掉自動標題生成（26-08-01 實測發現）。
            // SDK 型別原文：提供 title 就「skips automatic title generation」。
            // 不給的話，每次請求 SDK 會另外叫一次 Haiku 去生標題——實測它吃 527 tokens 輸入，
            // 比主模型那次（161）還多三倍，佔總成本約四成。而橋設了 persistSession: false，
            // session 根本不留，那個標題從頭到尾沒有任何用途。
            // 設 TCB_AUTO_TITLE=1 可退回舊行為（重新讓 SDK 自動生標題），供對帳。
            title: process.env.TCB_AUTO_TITLE === '1' ? undefined : 'SillyTavern bridge',
            maxTurns: 1,
            model: modelId,
            permissionMode: 'dontAsk',
            persistSession: persistSessionOption(),
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
            // 欄位名相容：SDK 型別寫的是 total_cost_usd，舊版是 cost_usd。
            // 只讀 cost_usd 會讓成本永遠是 0——而 costUsd===0 正是「模型沒被叫起來」
            // 的診斷指紋之一，讀錯欄位會讓那條判準對所有空回覆誤診（26-08-01 實測抓到）。
            costUsd = Number(msg.total_cost_usd ?? msg.cost_usd) || 0;
            // usage 直接從 result 訊息拿——不必事後呼叫 API（那時 transport 已關，
            // 會拿到 'ProcessTransport is not ready for writing'）。
            resultUsage = msg.usage || null;
            resultModelUsage = msg.modelUsage || null;
            diag.costUsd = costUsd;   // 「零成本」是「模型根本沒被叫起來」的指紋之一
            diag.subtype = msg.subtype;
            diag.num_turns = msg.num_turns;
            diag.is_error = msg.is_error;
            // result 自己帶的文字（26-08-03 加，外部使用者回報後補）：額度用盡時 SDK
            // **不拋例外**、照樣回一個 result，指紋跟憑證失效一模一樣——唯一能分辨的
            // 線索就在這段文字裡。沒有它，兩種病因在畫面上完全同形。
            if (typeof msg.result === 'string' && msg.result.trim()) diag.resultText = msg.result.slice(0, 300);
            dumpResultOnError(requestCount + 1, msg);   // 出錯才印，正常路徑零噪音
            break; // 串流輸入模式不會自己收尾（SDK 等下一則輸入），拿到 result 就走
          }
        }

        let usage;
        // 優先用 result 訊息自帶的（不必事後呼叫 API，也沒有 transport 時機問題）；
      // 都沒有才退回主動查詢，並把原因記下來
      usage = (resultUsage || resultModelUsage)
        ? { usage: resultUsage, modelUsage: resultModelUsage }
        : await readUsage(q);

        requestCount++;
        totalCostUsd += costUsd;

        // 快取讀數（26-08-01 加）。省額度的關鍵在快取有沒有命中，但這個數字
        // 原本拿到了卻沒印也沒傳——診斷不了就只能憑感覺猜「是不是有省到」。
        //
        // **刻意不寫死欄位名**：usage_EXPERIMENTAL() 是實驗性 API，欄位名可能
        // 跟 Messages API 不同、也可能包一層。寫死名字的後果不是報錯，是印出
        // undefined 然後看起來像「沒有快取」——拿著含有答案的資料說查不到。
        // 記帳走共用的 recordUsage（串流那條也呼叫同一支，避免只改一半）
        const { cacheFields, cacheRead, hitPct } = recordUsage(usage, {
          reqNo: requestCount, mode: 'json', modelId, effort: configEffort,
          shape, imgCount: hasImages ? images.length : 0, costUsd,
          splitApplied: splitInfo.applied,
          splitReason: splitInfo.reason,
          splitDivergence: splitInfo.divergence ?? null,
          splitZone: splitInfo.zone ?? null,
          systemDrift: systemDrift.changed,
        });

        // 空回覆的黑盒子（26-07-27 外部使用者案）：bridge 原本只記請求不記回應，
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
          // 既有三個欄位維持原樣，一個字都不動。
          // 曾經想把 prompt_tokens 改成「未快取＋快取讀」的總和（OpenAI 慣例是含快取），
          // 收回了：usage_EXPERIMENTAL() 的 input_tokens 含不含快取沒有保證，
          // 如果它本來就是總和，加上去就是重複計算——酒館顯示的用量會直接翻倍。
          // 診斷欄位只該用加的；改動既有欄位的語意，要等實跑數字對過帳再說。
          responseBody.usage = {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
          };
          if (Object.keys(cacheFields).length) {
            // OpenAI 相容陣營的慣例欄位，酒館與多數前端認得
            responseBody.usage.prompt_tokens_details = { cached_tokens: cacheRead };
            // 原始讀數也一起帶著——慣例欄位只裝得下「讀了多少」，
            // 裝不下「寫入多少」，而寫入是判斷「這次是建快取還是吃快取」的依據
            responseBody.usage.cache = {
              ...cacheFields,
              hit_percent: hitPct,
              ...(cacheLogError ? { log_error: cacheLogError } : {}),
            };
          }
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
        systemPrompt: systemPromptForSdk(systemPrompt),
        tools: [],
        // 省掉自動標題生成——見非串流那處的完整說明。
        // （這條是酒館實際會走的路徑；上次只改非串流那份，等於改了沒用。）
        title: process.env.TCB_AUTO_TITLE === '1' ? undefined : 'SillyTavern bridge',
        maxTurns: 1,
        model: modelId,
        permissionMode: 'dontAsk',
        persistSession: persistSessionOption(),
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
      let resultUsage = null;      // result 訊息自帶的 usage（Messages API 形狀）
      let resultModelUsage = null; // result 訊息自帶的 modelUsage（駝峰形狀）
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
          // 欄位名相容：SDK 型別寫的是 total_cost_usd，舊版是 cost_usd。
          // 只讀 cost_usd 會讓成本永遠是 0——而 costUsd===0 正是「模型沒被叫起來」
          // 的診斷指紋之一，讀錯欄位會讓那條判準對所有空回覆誤診（26-08-01 實測抓到）。
          costUsd = Number(msg.total_cost_usd ?? msg.cost_usd) || 0;
          // usage 直接從 result 訊息拿——不必事後呼叫 API（那時 transport 已關，
          // 會拿到 'ProcessTransport is not ready for writing'）。
          resultUsage = msg.usage || null;
          resultModelUsage = msg.modelUsage || null;
          diag.costUsd = costUsd;   // 「零成本」是「模型根本沒被叫起來」的指紋之一
          diag.subtype = msg.subtype;
          diag.num_turns = msg.num_turns;
          diag.is_error = msg.is_error;
          // 同上（串流路徑）——兩條路徑都要帶，只改一份等於真實情境永遠拿不到線索
          if (typeof msg.result === 'string' && msg.result.trim()) diag.resultText = msg.result.slice(0, 300);
          dumpResultOnError(requestCount + 1, msg);   // 出錯才印，正常路徑零噪音
          break; // 串流輸入模式不會自己收尾，拿到 result 就走
        }
      }

      let usage;
      // 優先用 result 訊息自帶的（不必事後呼叫 API，也沒有 transport 時機問題）；
      // 都沒有才退回主動查詢，並把原因記下來
      usage = (resultUsage || resultModelUsage)
        ? { usage: resultUsage, modelUsage: resultModelUsage }
        : await readUsage(q);

      requestCount++;
      totalCostUsd += costUsd;
      // 串流路徑（酒館的預設路徑）——記帳跟非串流走同一支 recordUsage
      recordUsage(usage, {
        reqNo: requestCount, mode: 'stream', modelId, effort: configEffort,
        shape, imgCount: hasImages ? images.length : 0, costUsd,
        splitApplied: splitInfo.applied,
        splitReason: splitInfo.reason,
          splitDivergence: splitInfo.divergence ?? null,
          splitZone: splitInfo.zone ?? null,
          systemDrift: systemDrift.changed,   // 26-08-27：這條（串流）原本漏了，面板因此對使用者說「還沒記到原因」
        aborted: ticket.aborted, suffix: ticket.aborted ? ' (讓位/斷線)' : '',
      });

      if (!ticket.aborted) {
        // 整輪一個字都沒送出＝空回覆。印黑盒子，並補一則通知取代空白畫面（26-07-27 外部使用者案）
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
          res.end(JSON.stringify({ status: 'ok', busy: current !== null, effort: configEffort, split: configSplit, requestCount, totalCostUsd, cache: cacheSummary() }));
          return;
        }

        if (req.method === 'GET' && req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: MODELS }));
          return;
        }

        if (req.method === 'GET' && req.url === '/config') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(currentConfig()));
          return;
        }

        if (req.method === 'POST' && req.url === '/config') {
          try {
            const raw = await readBody(req);
            if (raw) applyConfig(JSON.parse(raw));
          } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(currentConfig()));
          return;
        }

        // 5199 直連版的自我健檢（給 curl 用；面板走同源的 router 版）
        if (req.method === 'POST' && req.url === '/selftest') {
          const r = await runSelfTest();
          console.log(`[${PLUGIN_ID}] 自我健檢：${r.ok ? '✅' : '❌'} ${r.message}`);
          if (r.raw) console.warn(`[${PLUGIN_ID}] 自我健檢 result 原文：${r.raw}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(r));
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

// 版本號的唯一來源是 package.json——**不要在這裡寫第二個**（26-08-27）。
// 這格原本寫死 '1.3.0'，從 v1.3.0 起就沒人動過，而套件已經到 1.7.x。
// 危險的不是數字錯，是它讓「前端比對前後端版本」這個最自然的防呆做不成，
// 而那正是使用者踩的坑：面板更新了、server plugin 沒換，症狀完全無聲。
function readOwnVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';   // 讀不到就明說是 0.0.0，不要瞎編一個看起來像真的的版本
  }
}

const info = {
  id: PLUGIN_ID,
  name: 'Claude Bridge',
  description: 'Bridges SillyTavern to Claude via official Agent SDK and local subscription auth.',
  version: readOwnVersion(),
};

// 自我健檢：在**這個進程裡**實打一發最便宜的模型，驗 SDK 到底通不通（26-07-29 加，外部使用者案）。
// 為什麼要有：一位外部使用者花了一整晚做排除法才確認「SDK 沒問題、參數沒問題、只有透過酒館才失敗」。
// 那份排除本來該由這支橋自己回答——它就跑在那個進程裡，最有資格說「我在這裡叫不叫得動 SDK」。
// 不自動跑（會燒額度），由使用者從面板或 curl 主動觸發。
async function runSelfTest() {
  const t0 = Date.now();
  if (!queryFn) {
    return { ok: false, stage: 'sdk-load', message: 'SDK 沒載入——請在 plugins/tavern-claude-bridge/ 執行 npm install 後重啟 SillyTavern。' };
  }
  try {
    const q = queryFn({
      prompt: '回答一個字：好',
      options: {
        tools: [], maxTurns: 1, model: 'claude-haiku-4-5',
        permissionMode: 'dontAsk', persistSession: persistSessionOption(), settingSources: [],
        thinking: { type: 'disabled' },
      },
    });
    let text = '';
    const blocks = [];
    let result = null;
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const b of msg.message?.content || []) {
          blocks.push(b.type);
          if (b.type === 'text') text += b.text || '';
        }
      } else if (msg.type === 'result') { result = msg; break; }
    }
    const ms = Date.now() - t0;
    if (text.trim()) {
      return { ok: true, stage: 'done', ms, reply: text.trim().slice(0, 40), message: `通了（${ms}ms）——SDK 在 SillyTavern 這個進程裡叫得動，問題不在環境。` };
    }
    // 這裡才是那個症狀：跑完了、但一個字都沒有
    return {
      ok: false, stage: 'empty', ms,
      blocks, subtype: result?.subtype, is_error: result?.is_error,
      raw: result ? JSON.stringify(result).slice(0, 800) : null,
      message: '❌ SDK 在這個進程裡叫得動、但模型一個字都沒吐。兩種可能，先查第一個：'
        + '① **訂閱額度用完**（到 claude.ai → Settings → Usage 看一眼，健檢這一發同樣會撞額度，'
        + '所以健檢失敗不等於憑證壞了）② **登入憑證失效**（終端機 `claude login` 後重啟 SillyTavern）。'
        + '兩個都不是的話，把這整段連同上面那行「執行環境：…」貼給維護者。',
    };
  } catch (err) {
    return {
      ok: false, stage: 'throw', ms: Date.now() - t0,
      message: `❌ SDK 在這個進程裡直接拋錯：${err.message}`,
    };
  }
}

async function init(router) {
  logEnvFingerprint();
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
        ? { running: true, host: HOST, port: DEFAULT_PORT, busy: current !== null, effort: configEffort, split: configSplit, splitLocked: SPLIT_LOCKED_OFF, requestCount, totalCostUsd, cache: cacheSummary(), models: MODELS.map(m => m.id) }
        : { running: false },
      sdkAvailable: Boolean(queryFn),
    });
  });

  // effort 設定走 ST 自己的 router（同源），不走 5199——瀏覽器 CORS 擋跨 port 直連
  router.get('/config', (_req, res) => {
    res.json(currentConfig());
  });

  // 自我健檢（主動觸發，會打一發 haiku）——同源路徑供前端面板用
  router.post('/selftest', async (_req, res) => {
    const r = await runSelfTest();
    console.log(`[${PLUGIN_ID}] 自我健檢：${r.ok ? '✅' : '❌'} ${r.message}`);
    if (r.raw) console.warn(`[${PLUGIN_ID}] 自我健檢 result 原文：${r.raw}`);
    res.json(r);
  });

  router.post('/config', (req, res) => {
    res.json(applyConfig(req.body));
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
//（ST 只讀 info/init/exit，多幾個具名匯出對它無影響）。
// 位置語義與思考開關是這支橋最容易壞又最看不出來的兩處，測試必須測到本尊、不是抄一份副本。
// _setQueryFn 僅供測試：把 SDK 的 query 換成假的，讓契約測試驗「送進 SDK 的 options」與
// 「thinking block 關閉時不回酒館」的完整請求鏈（Grok MED-5），不必實彈也不佔真額度。
function _setQueryFn(fn) { queryFn = fn; }
// tracePrefix 一併 export：測試要驗的是**本體**，不是複製一份邏輯去測
// （複製品測過≠本體會動，26-08-01 只改非串流那份的同族教訓）
export { info, init, exit, parseMessages, thinkingOption, handleChatCompletions, _setQueryFn, tracePrefix, traceTurns, splitPromptBlocks, makeSplitPrompt, splitEnabled, cacheSummary };
