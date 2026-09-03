import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';   // createHash：對話識別雜湊用（conversationKey）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 拆塊斷點掃描器（26-08-02，CX-260802-03）：只做「斷點該落在哪一則」的計算，
// 不碰渲染也不貼標記——分工線在那支的檔頭註解。目前只被量測模式用到。
import { fingerprintTurns, lengthsOfTurns, decideBreakpoint, stickyBreakpoint, meetsCacheMinimum, estimateTokens, minCacheTokensFor, trackSystemPrompt, analyzeShift, cacheRoi, shortDiff, textOfTurn, composeTurns, composeLine, kindOfTurn, sysDriftAdvice } from './cache-breakpoint.mjs';

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
// 下午的翻案實測（test/spike/spike-resume-cache_260802.mjs，同樣內容三組對照）：
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
// 實驗腳本：上午 test/spike/spike-cache-threshold_260802.mjs／下午 test/spike/spike-resume-cache_260802.mjs
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
export function persistSessionOption() {
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

// 最近幾發的輕量紀錄（26-08-29 v1.8.3）——**只為了回答一個問題：那筆新建的錢收回來了嗎。**
// 累計器答不了它，因為判定要看「每發之間隔多久」與「這發有沒有讀到」，那是逐發的形狀。
// 落檔的 cache-log 裡也有，但面板是即時的、不該為了畫一行字去讀檔。
// 存三個數字乘以十幾筆，成本可以忽略；橋重啟歸零，跟面板其他統計同一個口徑。
const CACHE_HISTORY_MAX = 12;
const cacheHistory = [];

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
    // 26-09-02（審核 C9）：最近一次漂移是「落回看過的值」（true＝有東西時有時無，關鍵字條目那型）
    // 還是「每次都是新值」（false＝時間戳那型）。沒資料回 null，前端不准拿 null 當 false 印。
    lastSystemRecurring: t.lastSystemRecurring ?? null,
    // 26-09-02（⑫）：最近一發有值的 5h 額度使用率；一發都沒有就 null（前端顯示「還沒有數據」，不印 0%）
    lastQuota5hPct: t.lastQuota5hPct ?? null,
    // 那筆新建的錢有沒有收回來（26-08-29）。面板只報「新建快取 50,000」的話，
    // 看起來像做了好事——實際上新建是一般輸入的兩倍價，隔幾小時才玩一則的人一次都收不回。
    cacheRoi: t === cacheTally ? cacheRoi(cacheHistory) : null,
    // 26-09-02 組成表那一行（CX-260902-01）：後端組好字串，前端直接印——前端 import 不到後端函式，
    // 兩邊各組一次遲早各說各話。
    lastCompLine: t.lastComp ? composeLine(t.lastComp) : null,
    // 26-09-03（CX-260903-01 ③）：系統區連續漂移的計數與建議句。句子在後端組（sysDriftAdvice），
    // 前端只負責印——前端 import 不到後端函式，兩邊各組一次遲早各說各話。
    // null＝沒有連續漂到門檻，前端整段不顯示（**沒漂的人不該看到任何指認**，見 sysDriftAdvice 的守門註解）。
    sysDriftStreak: t.lastSysDriftStreak ?? null,
    sysDriftAdvice: t.lastSysDriftAdvice ?? null,
  };
}

/**
 * 拆塊「開著但沒生效」的警告。回 null＝沒事，不要吵。
 *
 * 門檻取「一半」是刻意的鈍值：拆塊本來就有合理不拆的時候（第一發沒基準、
 * 斷點剛好在頭幾則），偶爾不拆不是病；**長期過半不拆才是**。
 */
function splitWarningOf(t) {
  // 帳本沒帶這欄就問即時狀態（production 走這條）；測試傳假帳本時可以覆寫。
  const 開著 = t.splitEnabled !== undefined ? t.splitEnabled !== false : splitEnabled();
  if (!開著 || !t.requests) return null;
  const applied = t.splitApplied || 0;
  // **樣本不夠不是閉嘴的理由**（26-08-28 v1.8.1，使用者實案催出來的）：
  // 舊碼要滿三則才肯講話，於是燒掉三成額度來問「為什麼」的人，
  // 得到的回應是面板沉默——最需要診斷的人最看不到診斷。
  // 分開來看：「省多少」要幾則才算得準（那個門檻留在 cacheSummary 那側），
  // 「為什麼沒拆」第一則就知道了，沒有理由要人再花兩則的錢買。
  // 差別只在措辭：樣本不夠時不下「長期有問題」的判斷，只陳述這幾則的事實。
  const 樣本夠 = t.requests >= 3;
  if (樣本夠 && applied * 2 >= t.requests) return null;     // 過半有拆到＝健康
  if (!樣本夠 && applied > 0) return null;                   // 樣本少但有拆到＝先不吵

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
  // 樣本不夠時語氣要收：陳述事實、不下長期判斷，但原因與位置照給。
  const 開頭 = 樣本夠
    ? `拆塊開著，但 ${t.requests} 則裡只有 ${applied} 則真的拆到塊——省快取這件事現在幾乎沒有在發生。`
    : `拆塊開著，但這 ${t.requests} 則都沒拆到塊。才玩 ${t.requests} 則還不能說是不是長期問題，`
      + `不過原因現在就查得到，不用等你再花幾則的錢：`;
  return {
    level: 樣本夠 ? 'warn' : 'info',
    text: `${開頭}${原因}${位置}`,
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

// 診斷模式（26-09-02 ⑨ 後端半邊）：turn-log 每則的 head（開頭 30 字）、split.reason 裡變動點那則的片段、
// rewriteFull（改寫前後完整兩版）——這些**會碰到對話內容**的欄位只在診斷模式落檔。
// 以前只有環境變數 TCB_TURN_TRACE=1 能開，使用者不會設環境變數，要診斷等於叫他改腳本重開酒館。
// 現在面板 /config 的 trace 欄可開可關；環境變數仍可強制開（向後相容，舊腳本不必改）。
let configTrace = false;
function traceEnabled() { return configTrace || process.env.TCB_TURN_TRACE === '1'; }

// 系統提示走對話第一則（26-09-02 第二波 b ③，spike δ 定案；Mini 拍板「做成開關、寫得簡單易懂」）。
// **預設關，關的時候一切跟現在一樣。**
// 為什麼要它：SDK 自己佔 3 個 cache_control（內建句／我們傳的 systemPrompt／messages 尾），手動只剩 1 個；
// 把系統提示塞進 user 第一塊（不貼標記）→ system 側只剩 SDK 內建句 1 個，messages 就放得下 2 個手動斷點＋SDK 尾 1＝4。
// 兩個手動斷點＝「舊穩定塊」與「新增段」分開貼：跳斷點時舊塊逐字不動照樣命中、只重寫增量（spike δ Q3 實測）。
// 代價寫在面板文案裡：角色卡從 system 角色變 user 角色，模型看待它的方式可能微妙地不同——這是使用者自己選的。
let configSysInFirstTurn = false;
function sysInFirstTurnEnabled() { return configSysInFirstTurn; }

// /config 的讀寫只有這一份實作，兩條路徑（5199 直連與 ST 同源 router）都呼叫它。
// 26-08-03 抽出來的理由很實際：原本兩邊各寫一份幾乎相同的邏輯，加第三個欄位就要改兩處，
// 而「改一半」的症狀是安靜的——面板走 router 那條會動，curl 走 5199 那條不動，兩邊都不報錯。
function currentConfig() {
  // trace 回的是**實際生效值**（面板開 或 環境變數強制開），跟 splitLocked 同一個念頭：面板要看到真相，不是看到自己送過什麼
  return { effort: configEffort, thinking: configThinking, split: configSplit, splitLocked: SPLIT_LOCKED_OFF, trace: traceEnabled(), sysInFirstTurn: configSysInFirstTurn };
}

// 只認得懂的欄位、只吃型別對的值；其餘一律忽略並維持原值（髒資料不該把設定踩回預設）。
function applyConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return currentConfig();
  if (cfg.effort && VALID_EFFORTS.includes(cfg.effort)) configEffort = cfg.effort;
  if (typeof cfg.thinking === 'boolean') configThinking = cfg.thinking;
  // 被啟動參數鎖住時，面板送什麼都不動——逃生門要真的關得住
  if (typeof cfg.split === 'boolean' && !SPLIT_LOCKED_OFF) configSplit = cfg.split;
  if (typeof cfg.trace === 'boolean') configTrace = cfg.trace;   // 26-09-02 ⑨：型別不對就忽略，比照上面三欄
  if (typeof cfg.sysInFirstTurn === 'boolean') configSysInFirstTurn = cfg.sysInFirstTurn;   // 26-09-02 ③：同上
  return currentConfig();
}

const MODELS = [
  { id: 'claude-opus-5[1m]', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-opus-5', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-opus-4-6[1m]', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-opus-4-6', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-opus-4-8[1m]', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-fable-5-1', object: 'model', owned_by: 'anthropic' },   // 26-09-02 上線當天 Mini 點名加
  { id: 'claude-fable-5', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-sonnet-5', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-sonnet-4-6', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-haiku-4-5', object: 'model', owned_by: 'anthropic' },
];

// 酒館「傳送內嵌媒體」送的是 OpenAI 格式的 data URL，Claude 要的是 base64 三件組。
// 只吃 data URL——外部網址一律不下載（bridge 不該替使用者去打別人的伺服器）。
// 26-09-02（審核 A11）：丟棄要出聲、media_type 要驗。以前外部網址與非圖片 data URL 都靜默丟掉——
// 模型完全不知道有圖、終端機零訊息；PDF／SVG 則原樣包成 image block 送出，API 拒收後走「執行錯誤」，
// 使用者看不出是圖的格式。**只加警告，不往送出內容塞任何佔位字**（那是動送出內容，要另拍板）。
const IMAGE_MEDIA_TYPES = /^image\/(jpeg|png|gif|webp)$/i;
function toImageBlock(part) {
  const url = part && part.image_url && part.image_url.url;
  if (typeof url !== 'string') return null;
  const m = url.match(/^data:([^;,]+);base64,(.+)$/);
  if (!m) {
    console.warn(`[${PLUGIN_ID}] 圖片略過：只吃 data URL（base64），外部網址不下載（${url.slice(0, 60)}${url.length > 60 ? '…' : ''}）`);
    return null;
  }
  if (!IMAGE_MEDIA_TYPES.test(m[1])) {
    console.warn(`[${PLUGIN_ID}] 圖片略過：media_type ${m[1]} 不在 API 支援名單（jpeg／png／gif／webp）`);
    return null;
  }
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
  // 沒有任何一句對話。上限走共用的 appendJsonl（26-09-02 審核 B4）：超過 2MB 砍到只留最後 256KB（砍在行界）。
  try {
    appendJsonl(path.join(__dirname, 'empty-replies.jsonl'), {
      t: new Date().toISOString(), n: reqNo, label,
      blocks: blockTypes, stop_reason: diag.stop_reason, subtype: diag.subtype,
      num_turns: diag.num_turns, is_error: diag.is_error, costUsd: diag.costUsd,
      // 這格就是「額度用盡 vs 憑證失效」的分辨依據——沒有它，兩種病因在事後完全同形
      resultText: diag.resultText ?? null,
    }, { keepBytes: 256 * 1024 });
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
// JSONL 落檔＋rotation，**只有這一份**（26-09-02 審核 B4）。
// 以前 empty-replies／cache-log／turn-log 各抄一份：statSync → 超過 2MB → split('\n').slice(-N) → 寫回，
// 三種保留行數、零測試。turn-log 一筆帶 turns 陣列，長對話一筆 10KB 以上 → 2MB 約 200 筆 →
// `slice(-200)` 幾乎砍不掉東西，之後每一發都把 2MB 讀進來再寫回去。
// 現在：超過 maxBytes 就只留**最後 keepBytes 位元組**，而且砍在行界（從尾巴那段的第一個換行之後開始），
// 砍完仍是合法 JSONL。多位元組 UTF-8 不會被切一半——行界是 0x0a，UTF-8 的續位元組不會是它。
// rotation 失敗吞掉（檔不存在、讀不到都不該擋 append）；append 本身失敗**拋出去**，由呼叫端決定怎麼出聲——
// 三個呼叫端各有自己的「不靜默」方式（cache-log 記進 cacheLogError、其餘 console.warn）。
const JSONL_MAX_BYTES = 2 * 1024 * 1024;
export function appendJsonl(file, entry, { maxBytes = JSONL_MAX_BYTES, keepBytes = Math.floor(maxBytes / 2) } = {}) {
  try {
    const st = fs.statSync(file);
    if (st.size > maxBytes) {
      const buf = fs.readFileSync(file);
      const tail = buf.subarray(Math.max(0, buf.length - keepBytes));
      const nl = tail.indexOf(0x0a);
      // 尾巴那段開頭多半是半截行：從第一個換行之後留起。找不到換行＝整段都是半截，全部丟掉。
      const kept = nl === -1 ? Buffer.alloc(0) : tail.subarray(nl + 1);
      fs.writeFileSync(file, kept);
    }
  } catch {}
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
}

let cacheLogError = null;   // 落檔失敗的原因，帶進回應裡（見下）
function appendCacheLog(entry) {
  try {
    // 超過 2MB 留最後 1MB（26-09-02 B4 起按位元組砍；以前留 2000 行）
    appendJsonl(path.join(__dirname, 'cache-log.jsonl'), entry, { keepBytes: 1024 * 1024 });
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

// （26-08-02 的前綴切段雜湊工具——定位「哪一段每輪在變」用——已於 26-09-02 退役，審核 B7③、Mini 拍板 ⑩：
//   一次性工具，turn-log 逐則指紋＋cache-log 的 sysHash 已覆蓋同一件事。它的紅線「只記雜湊不記原文」
//   由 turn-log 的結構模式繼承。要考古看 git 歷史。）

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
  // 命中率分母＝這次送進去的全部輸入（未快取＋快取讀＋快取寫），跟 cacheSummary() 同一把尺。
  // 26-09-02（審核 C2）：舊分母漏了 cacheWrite——26-09-01 n5 真實數字 read 7,815／write 23,037／in 3，
  // 真命中率 25%，console 與 cache-log 卻印 hit=100%。「命中 100%」跟「額度在燒」同時成立，
  // 看的人會去找別的兇手。兩處口徑不同就是儀器說謊。
  const inputTotal = inTok + cacheRead + cacheWrite;
  const hitPct = inputTotal > 0 ? Math.round((cacheRead / inputTotal) * 100) : null;

  // 累計進面板要顯示的統計。只有真的拿到 usage 才記——拿不到就記 0 會把倍數稀釋，
  // 而那種稀釋看起來像「快取效果變差」，是會害人查錯方向的假訊號。
  if (usage) {
    cacheTally.requests++;
    // model 一起記（26-09-02 審核 C10b）：cacheRoi 按帳本最後一筆的 model 查價——沒這格，priceFor 永遠只吃到預設的 Opus 4.6
    cacheHistory.push({ atMs: Date.now(), cacheWrite, cacheRead, model: ctx.modelId });
    if (cacheHistory.length > CACHE_HISTORY_MAX) cacheHistory.shift();
    // 這一發真的送到了 → 它才有資格當下一發的比較基準（見 pendingTurnFps 註解）
    commitTurnBaseline();
    if (ctx.splitApplied) cacheTally.splitApplied++;
    // 不拆的理由要留最後一筆——面板的警告靠它把「沒生效」講成「為什麼沒生效」。
    else if (ctx.splitReason) cacheTally.lastSkipReason = ctx.splitReason;
    // ③ 面板「拆塊」那行要印「快取點 2 個：第 s1／s2 則」——只在系統提示走第一則且真的拆到時留座標；關掉就清（不留舊座標騙人）
    if (ctx.splitSysFirst && ctx.splitApplied) {
      cacheTally.lastSplitS1 = ctx.splitS1 ?? null;
      cacheTally.lastSplitS2 = ctx.splitS2 ?? null;
    } else {
      delete cacheTally.lastSplitS1;
      delete cacheTally.lastSplitS2;
    }
    if (ctx.splitDivergence !== undefined) cacheTally.lastDivergence = ctx.splitDivergence;
    if (ctx.splitZone !== undefined) cacheTally.lastDivergenceZone = ctx.splitZone;
    if (ctx.systemDrift !== undefined) cacheTally.lastSystemDrift = ctx.systemDrift;
    // 26-09-02（審核 C9）：recurring（來回切換 vs 每則新值）後端早就算了，面板卻拿不到——
    // 前端只能印一句寫死的舊指認。把最近一次的布林暴露給 cacheSummary。
    if (ctx.sysRecurring !== undefined) cacheTally.lastSystemRecurring = ctx.sysRecurring;
    // 26-09-03（CX-260903-01 ③）：連續漂移的計數與建議句給面板。
    // **每發都覆寫，包含 null**——漂移停了建議句就要消失，留著舊句等於對已經修好的人繼續喊病。
    cacheTally.lastSysDriftStreak = ctx.sysDriftStreak ?? null;
    cacheTally.lastSysDriftAdvice = ctx.sysDriftAdvice ?? null;
    // 26-09-02（審核 C10d，⑫ 後端半邊）：訂閱使用者付的是 5h 額度不是美元——最近一發**有值**的留給面板。
    // 這一發沒帶（SDK 有些版本不回 rate_limits）就保留上一個有值的，不歸零。
    if (flat.fiveHourPct != null) cacheTally.lastQuota5hPct = flat.fiveHourPct;
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
  // 26-09-02 組成表那一行（CX-260902-01）：每發印一行，面板也拿得到（cacheSummary.lastCompLine）
  if (ctx.comp) {
    cacheTally.lastComp = ctx.comp;
    console.log(`[${PLUGIN_ID}] #${ctx.reqNo} ${composeLine(ctx.comp)}`);   // 前綴刻意不同於請求 log 那行——request-log 測試釘死那格只准一處
  }

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
    shiftKind: ctx.shiftKind ?? null,
    shiftDropped: ctx.shiftDropped ?? null,
    rewriteDiff: ctx.rewriteDiff ?? null,
    rewriteFull: ctx.rewriteFull ?? null,
    // 26-09-01：系統提示雜湊落檔。原本只把 changed 這個布林傳進 ctx、而且沒進 entry——
    // 等於記了最沒用的那一格。使用者反映「玩到下一則就看不到上一則的面板」，
    // 而分辨「一直在變」與「來回切換」靠的正是雜湊序列，那只活在 console 裡。
    sysDrift: ctx.systemDrift ?? null,
    sysHash: ctx.sysHash ?? null,
    sysRecurring: ctx.sysRecurring ?? null,
    // 26-09-02（CX-260902-03 ⑤）：對話識別。同一個聊天每發相同、換聊天才變——「基準被丟」與「基準留著」在讀數上分不出來，這格分得出來。
    // 只是對話開頭兩則的指紋（各 12 碼），不含內容。
    convKey: ctx.convKey ?? null,
    // 26-09-03（CX-260903-01 ①）：這一發的基準從哪來——prev（上一發）／recall（翻回看過的鑰匙）／none（沒有）。
    // 綾 n=3 拿到看過的 key 卻判 fallback 那件事，沒有這格就只能靠猜。
    convBase: ctx.convBase ?? null,
    // ③ 系統提示走第一則的那幾發才落：sysFirst＋兩個快取點座標（三塊那發 s1 是 null）。關閉時**沒有這幾個鍵**。
    ...(ctx.splitSysFirst ? { sysFirst: true, s1: ctx.splitS1 ?? null, s2: ctx.splitS2 ?? null } : {}),
    // 26-09-02 組成表彙總（CX-260902-01）：系統區／對話／注入各多少則多少字元、跟上一發幾則變幾則移位。
    // 只有數字不含內容。逐則明細在 turn-log.jsonl。
    comp: ctx.comp ?? null,
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

  // inTok／outTok 也回：非串流回酒館的 usage 三欄要用**同一份**攤平結果——
  // 26-09-02（審核 A1）之前那裡讀的是 usage.input_tokens（舊的平坦形狀），永遠 undefined → 三欄恆 0，
  // 而同一發的 console／cache-log 走 flattenUsage 是對的，兩邊各說各話。
  return { cacheFields, cacheRead, cacheWrite, hitPct, inTok, outTok };
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

function rescueHeaderEnd(messages, prevFps = null) {
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
  //
  // 26-09-02 第二波 b ②（審核 C 第 3 條）：「對話開始後不會再夾 system」對排在對話後的注入成立，
  // **對 @D 深度注入不成立**——玩家先發言、@D 深度 ≥2 時，那則 system 剛好落在第一個 assistant 前。
  // 舊 walkback 碰到它就停，把玩家第一句吃進 systemPrompt；下一發 @D 跟著對話往後走、自己跳回對話區，
  // systemPrompt 每次位移就變、整包快取重建。兩層修法（都保守：寧可系統提示少一段，也不把玩家的話當系統提示送）：
  //   ① 有基準時查它在上一發的位置（composeTurns 的 vs，判準只有一份）：**moved＝跟著對話走的注入，跳過它繼續往回走**；
  //      same／new／沒基準 → 維持現行停下（常駐條目兩發同位置照舊進 header，不誤傷）。
  //   ② 附加安全閘（第一發就生效、不用基準）：緊貼第一個 assistant 的那群 system，前面若是「像玩家發言的非空 user、
  //      而且它前面已經有 system（header 區已開始）」→ 那群 system 是玩家第一句之後的注入，一起跳過。
  //      「像玩家發言」用 kindOfTurn 那把尺（'---'、'['、'<' 開頭的算設定），形狀 A 的 usr('---') 因此不會被誤判；
  //      「前面已經有 system」排除 E-1 那種 usr('設定') 在第 0 則的形狀。
  const vs = Array.isArray(prevFps) && prevFps.length ? composeTurns(messages, 0, prevFps).turns.map(t => t.vs) : null;
  let trailStart = firstBot;
  while (trailStart - 1 >= 0 && (!messages[trailStart - 1] || messages[trailStart - 1].role === 'system')) trailStart--;
  let before = trailStart - 1;
  while (before >= 0 && !messages[before]) before--;
  const trailIsInjection = trailStart < firstBot && before >= 0
    && messages[before].role === 'user' && !blankContent(messages[before].content)
    && kindOfTurn(messages[before], before, 0) === 'dlg'
    && messages.slice(0, before).some(m => m && m.role === 'system');
  let end = firstBot;
  for (let i = firstBot - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'system') {
      if (vs && vs[i] === 'moved' && !blankContent(m.content)) continue;   // ① 上一發在別的位置＝注入，不是設定
      if (trailIsInjection && i >= trailStart) continue;                     // ② 玩家第一句後面那群 system
      break;   // 碰到設定就停，這裡就是 header 的盡頭
    }
    end = i;                          // 這則不是 system 且後面沒（設定型的）system → 它是對話
  }
  return end;
}

// opts（26-09-02 第二波 b ②）：prevFps＝上一發的逐則指紋、prevKey＝上一發的對話識別（conversationKey）。
// 只有救援路徑用得到（判 system 是不是 moved）；不給就是無基準、行為跟以前一樣。
function parseMessages(messages, { prevFps = null, prevKey } = {}) {
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

  const end = rescueHeaderEnd(messages, prevFps);
  let out = parseWithHeaderEnd(messages, end);
  // 基準要綁對話（跟 evaluateBreakpoint 同一條紀律）：算出來的 header 若對不上上一發的 key，那份基準是別的對話的，
  // 不拿它判 moved——用無基準重算一次。key 得先有 systemPrompt 才算得出來，所以只能算完再驗、驗不過再重來一次。
  if (prevFps && prevKey !== undefined && !sameConversation(prevKey, conversationKey(out.systemPrompt, messages, end))) {
    const end2 = rescueHeaderEnd(messages, null);
    if (end2 !== end) out = parseWithHeaderEnd(messages, end2);
  }
  return out;
}

// ── 拆塊第一階：只量不動（26-08-02）────────────────
//
// 為什麼先做一個「不改行為的量測模式」，而不是直接貼標記：
//   斷點算錯的失效方式是**安靜的**——照樣有命中，只是少省一半，讀數看起來很正常。
//   所以先讓儀器上線、拿真實對話驗斷點算得對不對，數字對了再讓修法上線。
//   （今天的帳：合成題測不到會動的場景；沒有真實基準就改行為，等於拿使用者當測試環境。）
//
// 開關（歷史）：原本 TCB_TURN_TRACE=1 才走；26-09-02 起結構永遠落檔，內容欄位由 traceEnabled() 管。
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
// **基準只在請求成功後才提交**（26-08-28 第六種變形，使用者「額度不足→重刷」催出來的）：
// evaluateBreakpoint 跑在送出前，舊碼當場就把 prevTurnFps 換掉——所以請求失敗（額度不足、
// 連線斷、使用者按了停）也照樣更新基準，下一發等於跟一個**從未送出去的東西**比對。
// API 那側根本沒收到那一發，真正該當基準的是上一發成功的。
// 判準跟 cacheTally.requests++ 用同一個（`if (usage)`）——量得到用量才算真的送出去了，
// 兩處用同一把尺，不會出現「計數說 3 則、基準說 4 則」這種各說各話。
let pendingTurnFps = null;
let pendingTurnKey = null;
// 26-09-03（CX-260903-01 ②）：基準除了指紋還要存長度——指紋答得出「一不一樣」，答不出
// 「一樣長還是連長度都變了」，而那正是綾那個形狀的分水嶺（見 lengthsOfTurns 註解）。
let prevTurnLens = null;
let pendingTurnLens = null;

// ── 看過的鑰匙（26-09-03，CX-260903-01 ①）────────────────────────────
//
// 為什麼要它：綾 26-09-03 四發的 convKey 是 K1、K2、K1、K3——**在少數幾個值之間來回跳**。
// 第三發拿到的 key 跟第一發一模一樣，橋卻照樣判「換對話、丟基準」，因為基準只留「上一發」那一把（K2 的）。
// 一把看過的鑰匙開的是同一扇門：命中歷史 key 就把**那把 key 的基準**取回來，不是從頭來過。
//
// 上限 8、LRU、只在記憶體不落檔：這是診斷用的短期記憶，不是使用者資料。
// 一個服務進程通常就服務一位使用者的幾個聊天，8 把夠用；無上限會讓長時間開著的酒館越吃越多記憶體。
const KEY_MEMORY_MAX = 8;
const keyMemory = [];   // [{ key, fps, lens, snap }]，最近用過的排最後

// **只有 `u:` 形狀的鑰匙進得了記憶**（26-09-03）。那把綁的是玩家真的打進去的第一句話，有識別力；
// 其餘三種退路形狀（`fp0`＝只有開場白、`fp0.fp1`＝對話流沒有 user、`s:`＝連對話流都沒有）
// 識別力不足——同一張卡、同一句開場白的兩個不同新聊天算出來是同一把，記了就會拿別的對話當基準，
// 那正是 26-08-28 修掉的病。寧可少救一發，也不重開那個門。
// **這條收窄不在工單規格裡**，是實作時被 `fingerprint-baseline-contamination` 的
// 「切回原對話也不拿別人的基準」那一格拒紅才發現的——沒有它，換錨後的鑰匙記憶會把
// 同卡同開場白的兩個新聊天認成同一個，等於重開 26-08-28 那道門。26-09-03 承曦裁決收下。
const 有識別力 = k => typeof k === 'string' && k.startsWith('u:');

function recallBaseline(key) {
  if (!有識別力(key)) return null;
  for (let i = keyMemory.length - 1; i >= 0; i--) {
    if (sameConversation(keyMemory[i].key, key)) return keyMemory[i];
  }
  return null;
}
function rememberBaseline(key, fps, lens, snap) {
  if (!有識別力(key) || !fps) return;
  const at = keyMemory.findIndex(e => e.key === key);
  if (at >= 0) keyMemory.splice(at, 1);
  keyMemory.push({ key, fps, lens, snap });
  while (keyMemory.length > KEY_MEMORY_MAX) keyMemory.shift();
}
/** 測試用：現在記得哪幾把鑰匙（只回 key，不回基準內容）。 */
export function __keyMemory() {
  return keyMemory.map(e => e.key);
}

/**
 * 「新聊天只有開場白」長成「玩家送出第一句」——同一個聊天，但 key 換了形狀（26-09-03）。
 *
 * 沒有 user 可當錨時 conversationKey 退回單則指紋（12 碼十六進位）；玩家一送出第一句就換成 `u:` 形狀，
 * 兩把字面上對不起來。26-09-02 靠「key 的前綴關係」放行，換錨後那條前綴不存在了。
 * 這裡改用**內容**驗，而且比舊法嚴：上一發**對話流**那一段的每一則指紋，都要原樣出現在
 * 這一發的同一個位置，而且這一發更長（純追加）。系統區不比——它每發都可能變（時間戳、觸發條目），
 * 拿它當同一性條件等於把這條門焊死，而那正是綾那個病的形狀。
 * 只放行單則形狀那一種——`u:`→`u:` 不同值就是換聊天，不准走這條門。
 */
function grewFromGreeting(prevKey, prevFps, fps, headerEnd) {
  if (typeof prevKey !== 'string' || !/^[0-9a-f]{12}$/.test(prevKey)) return false;
  if (!Array.isArray(prevFps) || !Array.isArray(fps)) return false;
  const end = Number.isFinite(headerEnd) && headerEnd > 0 ? headerEnd : 0;
  if (prevFps.length <= end || fps.length <= prevFps.length) return false;
  for (let i = end; i < prevFps.length; i++) if (prevFps[i] !== fps[i]) return false;
  return true;
}

// 被改寫那一則的原文快照（26-08-29 v1.8.4）。只留**一則**——診斷要講得出「變成什麼」
// 就夠了，留整份對話是拿記憶體換一個用不到的精度。
// 跟指紋基準同一條紀律：**失敗的請求不提交**，否則下一發拿沒送出去的東西比。
let prevRewriteSnap = null;      // { index, text }
let pendingRewriteSnap = null;
const splitState = { sticky: null, sticky1: null };   // 上次實際用過的斷點（黏住用；重啟歸零＝重新建一次，安全）；sticky1＝多斷點的舊塊座標 s1（26-09-02 ③，只在開關開時有值）
// 26-09-02（審核 A5＋A10）：splitState 裡的 sticky／systemHash／systemHashSeen 也走 pending。
// 8/28 把指紋基準改成「成功才提交」，但這三格還是**送出前當場寫**——失敗那發（額度不足、斷線）
// 算出的 jump、量到的系統提示雜湊、換 key 時的清空，全都直接落地不回滾，跟 8/28 修掉的是同一型病。
// 現在 evaluateBreakpoint 開一份暫存，trackSystemPromptPending／stickyBreakpointPending 寫暫存，
// commitTurnBaseline 一起提交；失敗那發的暫存被下一發 evaluateBreakpoint 直接覆蓋＝丟棄。
let pendingSplit = null;   // { sticky, systemHash, systemHashSeen }
function ensurePendingSplit() {
  return pendingSplit || (pendingSplit = {
    sticky: splitState.sticky,
    sticky1: splitState.sticky1 ?? null,
    systemHash: splitState.systemHash,
    systemHashSeen: [...(splitState.systemHashSeen || [])],
  });
}
// **一發只准算一次**：量測模式與拆塊模式都要用這個結果，各自算一次的話，
// 第二次會拿「這一發自己」當基準（prevTurnFps 已被第一次更新掉），分歧點變成整串長度、
// 斷點直接跑到最尾巴——而那看起來像「這發超級穩定」，是會騙人的那種錯。
export function evaluateBreakpoint(messages, headerEnd, convKey) {
  // 對話換了就不拿舊基準比——拿別的對話當基準，算出來的分歧點是假的（見 prevTurnKey 註解）。
  // convKey 拿不到時（呼叫端沒給）維持舊行為，不要在這裡自己造一個半吊子的識別。
  // **但不在這裡改 prevTurnKey／prevTurnFps／splitState**（26-09-02 審核 A5／A10）：這一發若失敗，
  // 舊對話的基準與 sticky 要還在——使用者換到新聊天第一發撞額度、切回舊聊天，舊的一切不該被清掉。
  // 26-09-02（CX-260902-03）：比 key 用 sameConversation——「開場白單則長成雙則」不算換對話（見 conversationKey 註解）。
  // 指紋先算——下面「開場白單則長成雙則」那條要拿內容驗，不能只看 key 的形狀（26-09-03）
  pendingTurnFps = fingerprintTurns(messages);
  pendingTurnLens = lengthsOfTurns(messages);
  const sameAsPrev = convKey === undefined || sameConversation(prevTurnKey, convKey);
  let baseFps = sameAsPrev ? prevTurnFps : null;
  let baseLens = sameAsPrev ? prevTurnLens : null;
  let baseSnap = sameAsPrev ? prevRewriteSnap : null;
  // 26-09-03（CX-260903-01 ①）：上一發不是同一個對話，就去翻「看過的鑰匙」——
  // 綾 n=3 拿到的 key 跟 n=1 一模一樣，那一發本來就該有基準可比（見 keyMemory 註解）。
  let baseSource = sameAsPrev ? (prevTurnFps ? 'prev' : 'none') : 'none';
  if (!sameAsPrev) {
    const hit = recallBaseline(convKey);
    if (hit) {
      baseFps = hit.fps; baseLens = hit.lens; baseSnap = hit.snap;
      baseSource = 'recall';
    } else if (grewFromGreeting(prevTurnKey, prevTurnFps, pendingTurnFps, headerEnd)) {
      // 「新聊天只有開場白」→「玩家送出第一句」：key 從單則形狀（`fp0`）換成 `u:` 形狀，
      // 兩把字面上對不起來。26-09-02 靠 key 的前綴關係放行，換錨後那條前綴不存在了——
      // 改用**內容**驗，而且比舊法嚴：上一發的指紋整串要是這一發的前綴（純追加）才算同一個聊天。
      baseFps = prevTurnFps; baseLens = prevTurnLens; baseSnap = prevRewriteSnap;
      baseSource = 'grew';
    }
  }
  // 「真的換了對話」＝上一發不是它、記憶裡也沒有它。取回基準的那種不算換——sticky 與雜湊歷史都該留著。
  const keyChanged = !sameAsPrev && baseSource === 'none';
  // 26-09-02（審核 C5）：換對話時 sticky 斷點與雜湊歷史也要歸零——放暫存，成功才提交。
  // sticky 不清：新對話黏在舊對話的第 N 則上，held 期間少納一截進穩定塊，要再玩到 gain≥40 才跳。
  // systemHashSeen 不清：A→B→A 切回來被判 recurring「來回切換」，其實只是換了聊天。
  // systemHash **保留**——換對話後第一發報一次「系統提示變了」是真的，該報。
  pendingSplit = {
    sticky: keyChanged ? null : splitState.sticky,
    sticky1: keyChanged ? null : (splitState.sticky1 ?? null),
    systemHash: splitState.systemHash,
    systemHashSeen: keyChanged ? [] : [...(splitState.systemHashSeen || [])],
  };
  // 算好先放著，**等請求真的成功再由 commitTurnBaseline() 提交**（見 pendingTurnFps 註解）
  pendingTurnFps = fingerprintTurns(messages);
  pendingTurnLens = lengthsOfTurns(messages);
  pendingTurnKey = convKey !== undefined ? convKey : prevTurnKey;
  // 26-09-02（CX-260902-03）：**header 內的變動不計入斷點的分歧點**。
  // 斷點切的是對話流（header 那段已進 systemPrompt，不在拆塊範圍）；系統提示變了整包前綴作廢是另一層的事，
  // 由 trackSystemPrompt 報漂移、composeTurns 指出哪則變。以前基準綁 systemPrompt 雜湊、系統提示一變就丟基準，
  // 這條路根本走不到；現在基準留著，header 那則變動若照算進 findDivergence，分歧點落在 header 裡 →
  // decideBreakpoint 把斷點頂到 headerEnd → 穩定區 0 → skip——使用者看到的是「系統提示在變」＋「不拆」，
  // sticky 建不起來，等她修好漂移還要再繞一發。所以餵給 decideBreakpoint 的基準，header 段換成這一發自己的指紋；
  // 回傳的 prevFps／analyzeShift 仍用完整基準（診斷要看得到 header 那則）。
  let baseForBreakpoint = baseFps;
  let headerChanged = 0;
  if (baseFps && headerEnd > 0) {
    baseForBreakpoint = baseFps.map((f, i) => (i < headerEnd && i < pendingTurnFps.length ? pendingTurnFps[i] : f));
    for (let i = 0; i < headerEnd && i < baseFps.length && i < pendingTurnFps.length; i++) if (baseFps[i] !== pendingTurnFps[i]) headerChanged++;
  }
  const decision = decideBreakpoint(messages, baseForBreakpoint, {
    headerEnd,
    safetyTurns: Math.max(0, parseInt(process.env.TCB_SAFETY_TURNS, 10) || 1),
    fallbackDepth: Math.max(1, parseInt(process.env.TCB_FALLBACK_DEPTH, 10) || 8),
  });
  if (headerChanged > 0) decision.why += `｜系統區有 ${headerChanged} 則跟上一發不同，不計入斷點（那層歸系統提示漂移管，見 sysDrift／comp.sys.changed）`;
  const prevFps = baseFps;
  // 這一發是哪一種變化——滑動／改寫／追加。**沒有這一格，診斷會把視窗滑動
  // 說成「有東西在改寫」，叫人去抓一隻不存在的鬼**（26-08-29 實案，見 analyzeShift）。
  const shift = analyzeShift(pendingTurnFps, prevFps);

  // 被改寫的那一則「變成什麼」——**只有 rewrite 才算**。
  // 滑動的時候同一個 index 坐的根本是不同訊息，拿它們比對出來的「差異」是垃圾，
  // 而且會長得很像證據——那正是今晚那隻鬼的形狀（26-08-29）。
  let rewriteDiff = null;
  let rewriteFull = null;
  const ri = shift?.kind === 'rewrite' ? shift.index : null;
  if (typeof ri === 'number' && Array.isArray(messages) && messages[ri]) {
    const curText = textOfTurn(messages[ri]);
    if (baseSnap && baseSnap.index === ri) {
      rewriteDiff = shortDiff(baseSnap.text, curText);
    }
    // 完整前後兩版只在診斷模式落檔（面板 trace 或 TCB_TURN_TRACE=1）。
    // 為什麼要分層：差異片段（24 字元上限）多數情況就夠認出是時間戳還是狀態欄，
    // 那個預設就給；但真的查不出來的疑難雜症需要看完整原文，而那是使用者的對話內容——
    // **預設不落檔，要看的人自己開**。這條線畫在「隱私」與「診斷的成本不該由使用者付」之間：
    // 前者贏在預設值，後者贏在「有需要時打得開，而且不用改碼」。
    if (traceEnabled() && baseSnap && baseSnap.index === ri) {
      rewriteFull = { index: ri, before: baseSnap.text, after: curText };
    }
    pendingRewriteSnap = { index: ri, text: curText };
  } else {
    pendingRewriteSnap = null;
  }

  // convKey 一起回：cache-log／turn-log 每筆落一格，事後看得出「有沒有換鑰匙」（CX-260902-03 ⑤）
  // prevLens／baseSource 是 26-09-03 加的：前者給 composeTurns 算 sameLenDiffContent，
  // 後者讓落檔看得出這一發的基準是「上一發」「翻記憶翻回來的」還是「根本沒有」。
  return { decision, prevFps, prevLens: baseLens, baseSource, fps: pendingTurnFps, shift, rewriteDiff, rewriteFull, convKey: pendingTurnKey };
}

// ── 系統區連續漂移的計數（26-09-03，CX-260903-01 ③）──────────────────
//
// 「連續幾發 changed 非空」——一發沒漂就歸零。跟指紋基準同一條紀律：**成功才提交**，
// 失敗的請求（額度不足、斷線）不該把 streak 往上推，不然使用者重刷兩次就被指認一次。
let sysDriftStreak = 0;
let sysDriftIdx = null;
let pendingSysDrift = null;
/**
 * @param {object} sysSummary comp.summary.sys（要有 changedIdx）
 * @param {boolean} sameConv  這一發跟基準是不是同一個對話（換對話就重新數）
 */
export function trackSysDriftStreakPending(sysSummary, sameConv) {
  const changedIdx = Array.isArray(sysSummary?.changedIdx) ? sysSummary.changedIdx : null;
  const baseStreak = sameConv ? sysDriftStreak : 0;
  const baseIdx = sameConv ? sysDriftIdx : null;
  let streak = 0, idx = null;
  if (changedIdx && changedIdx.length) {
    streak = baseStreak + 1;
    // 點名的是「**每一發**都在變」的那幾則——所以取交集，不是聯集。
    // 交集被清空（這一發變的是完全不同的則）就重新從這一發數起，不硬湊一個空名單。
    idx = baseIdx ? baseIdx.filter(i => changedIdx.includes(i)) : changedIdx.slice();
    if (!idx.length) { idx = changedIdx.slice(); streak = 1; }
  }
  pendingSysDrift = { streak, idx };
  return { streak, idx };
}

/**
 * 提交這一發的指紋當下一發的基準。**只有請求真的成功才准呼叫**。
 * 失敗的請求不提交——它從來沒到過 API，拿它當基準會讓下一發報出假的變動點。
 */
export function commitTurnBaseline() {
  if (!pendingTurnFps) return false;
  prevTurnFps = pendingTurnFps;
  prevTurnLens = pendingTurnLens;
  prevTurnKey = pendingTurnKey;
  prevRewriteSnap = pendingRewriteSnap;
  // 這一發成功了 → 這把鑰匙配這份基準，記進「看過的鑰匙」（26-09-03 ①）
  rememberBaseline(prevTurnKey, prevTurnFps, prevTurnLens, prevRewriteSnap);
  if (pendingSysDrift) {
    sysDriftStreak = pendingSysDrift.streak;
    sysDriftIdx = pendingSysDrift.idx;
    pendingSysDrift = null;
  }
  // sticky／systemHash／systemHashSeen 同一刻提交（26-09-02 A5＋A10）
  if (pendingSplit) {
    splitState.sticky = pendingSplit.sticky;
    splitState.sticky1 = pendingSplit.sticky1 ?? null;
    splitState.systemHash = pendingSplit.systemHash;
    splitState.systemHashSeen = pendingSplit.systemHashSeen;
    pendingSplit = null;
  }
  pendingRewriteSnap = null;
  pendingTurnFps = null;
  pendingTurnLens = null;
  return true;
}

/**
 * 系統提示漂移偵測——寫進這一發的暫存，不直接動 splitState（26-09-02 審核 A10）。
 * trackSystemPrompt 本身照舊就地寫它拿到的 state，所以餵它一份暫存的視圖，量完把視圖抄回暫存。
 */
export function trackSystemPromptPending(systemPrompt) {
  const p = ensurePendingSplit();
  const probe = { systemHash: p.systemHash, systemHashSeen: p.systemHashSeen };
  const r = trackSystemPrompt(systemPrompt, probe);
  p.systemHash = probe.systemHash;
  p.systemHashSeen = probe.systemHashSeen;
  return r;
}

/**
 * 黏住斷點——stickyBreakpoint 是純函式，建議的新 sticky 寫進暫存，成功才提交（26-09-02 審核 A5）。
 *
 * multi（26-09-02 ③，系統提示走第一則時開）：同時記第二個座標 s1（舊塊的斷點），回傳多一個 `s1` 欄：
 *   s2 照現行 sticky 邏輯（held／jump／forced／new）；
 *   **jump 時 s1 ← 舊 s2**——舊塊逐字沿用、只重寫 s1..s2 那段增量（spike δ Q3：舊塊不動就命中）；
 *   held／skip 兩座標不動；new（第一次）沒有 s1；
 *   forced（變動點落進穩定塊）：舊 s1 塊若沒被動到（s1 ≤ divergence）就留著，否則清掉。
 *   s1 一律要落在 (0, s2) 內，不然就當沒有（三塊）。
 * multi 關著（預設）：回傳跟以前一模一樣、s1 歸零——關過一次再開，座標重新累積，不拿舊座標切。
 */
export function stickyBreakpointPending(decision, jumpGain, { multi = false } = {}) {
  const p = ensurePendingSplit();
  const held = stickyBreakpoint(decision, { sticky: p.sticky }, jumpGain);
  const prev1 = p.sticky1 ?? null;
  const prev2 = p.sticky;
  p.sticky = held.nextSticky;
  if (!multi) { p.sticky1 = null; return held; }
  let s1;
  switch (held.mode) {
    case 'skip':   p.sticky1 = prev1; return { ...held, s1: prev1 };   // 這發不拆，座標原地不動
    case 'held':   s1 = prev1; break;
    case 'jump':   s1 = prev2; break;
    case 'forced': s1 = (prev1 != null && decision.divergence != null && prev1 <= decision.divergence) ? prev1 : null; break;
    default:       s1 = null;   // new
  }
  if (s1 != null && !(s1 > 0 && s1 < held.index)) s1 = null;
  p.sticky1 = s1;
  return { ...held, s1 };
}

/** 測試用：已提交的跨請求狀態長什麼樣（唯讀拷貝）。 */
export function __splitStateSnapshot() {
  return { sticky: splitState.sticky, sticky1: splitState.sticky1 ?? null, systemHash: splitState.systemHash, systemHashSeen: [...(splitState.systemHashSeen || [])] };
}

/** 測試用：把模組層級的基準清乾淨，讓每組測試從同一個起點開始。 */
export function __resetTurnBaseline() {
  prevTurnFps = null;
  prevTurnKey = null;
  prevTurnLens = null;
  pendingTurnFps = null;
  pendingTurnKey = null;
  pendingTurnLens = null;
  keyMemory.length = 0;
  sysDriftStreak = 0;
  sysDriftIdx = null;
  pendingSysDrift = null;
  prevRewriteSnap = null;
  pendingRewriteSnap = null;
  pendingSplit = null;
  splitState.sticky = null;
  splitState.sticky1 = null;
  splitState.systemHash = undefined;
  splitState.systemHashSeen = [];
}

/**
 * 對話識別（26-09-02 CX-260902-03 改綁對話開頭；舊版是 header 的雜湊）。
 *
 * 為什麼不再用 systemPrompt 的雜湊：綾的實測（橋 1.8.7）——她的系統提示每發變（時間戳型），
 * key 於是每發變，evaluateBreakpoint 每發都判「換對話」丟基準：四發同一個聊天，每發都印
 * 「沒有上一發可比」、斷點 37→31→32→28 每發靠結構猜、comp.sys.changed 全空——
 * **最需要診斷「系統區哪一則在變」的人，正是被這把 key 弄瞎的人。**
 *
 * 新綁法：對話流開頭兩則（messages[headerEnd]、messages[headerEnd+1]）的內容指紋——
 * 同一個聊天這兩則不會變（開場白＋玩家第一句），換聊天／換卡／換開場白才變。
 * 指紋用 cache-breakpoint 那套（fingerprintTurns），不另發明一套雜湊。
 * 系統提示變了 → key 不變 → 基準留著 → 漂移由 trackSystemPrompt 報、變在哪則由 composeTurns 指。
 *
 * 26-09-03（CX-260903-01 ①）**再換一次錨**：綁「對話流第一則 role=user 的前 200 字」。
 * 為什麼上面那套「開頭兩則」也不夠：綾的實測（1.9.2 診斷模式）——她的對話流開頭那兩則
 * **本身就是酒館合併出來的區塊**（同 position 的觸發條目併成一則 system），內容每回合變、
 * 錨跟著每回合變，四發跳出三個 key（n=1 與 n=3 相同、n=2／n=4 各一個）。
 * 合併區塊是 system；玩家真正打進去的第一句是 user——那才是不會變的東西。
 *
 * 四種形狀（sameConversation 靠這個分）：
 *   `u:hash`（14 碼）   對話流找得到 role=user——**正常情況**
 *   `fp0.fp1`（25 碼）  對話流 ≥ 2 則但一則 user 都沒有——退回舊錨
 *   `fp0`（12 碼）      對話流只有 1 則且不是 user——新聊天只有開場白
 *   `s:hash`（14 碼）   沒有對話流（headerEnd＝總長）——退回更舊的法（systemPrompt 雜湊）；舊簽名只給 systemPrompt 也走這裡
 *
 * 「開場白單則」那個邊界（工單規格 1）：不用「舊法→新法視同一對話」——那條會把「只有開場白的聊天 A →
 * 有對話的聊天 B」也放行（A 的 key 是系統提示雜湊，對任何 B 都相容），正是 8/28 修掉的污染再開一個門。
 * 改成：單則 key 就是開場白自己的指紋；下一發滿 2 則時 key 以它為前綴（`fp0.fp1`）——
 * sameConversation 認「前綴相同」為同一個聊天長出了第二則。反過來（雙則→單則）當換對話，保守。
 * 同卡另開新聊天（開場白同、只有 1 則）從有對話的聊天切過去也會被判換對話（雙則→單則）——對。
 * 但從「只有開場白的聊天 A」切到「同卡、有對話的聊天 B」會被放行：A 的內容確實是 B 的前綴，
 * 算出來是純追加、不是假變動點，可接受。
 */
export function conversationKey(systemPrompt, messages, headerEnd) {
  if (Array.isArray(messages) && typeof headerEnd === 'number' && headerEnd >= 0 && headerEnd < messages.length) {
    // 26-09-03（CX-260903-01 ①）：**首選錨＝對話流第一則 role=user 的前 200 字**（正規化空白後）。
    // 綾的實測打穿了「開頭兩則」這個假設：她那兩則本身就是酒館合併出來的 system 區塊
    // （同 position 的觸發條目併成一則），內容每回合變 → 錨每回合變 → key 每回合變。
    // 合併區塊是 system，不是 user——玩家真正打進去的第一句話才是這個聊天不會變的東西。
    // 只取前 200 字：整句雜湊沒有比較準，短前綴反而擋得住「同一句話後面被接了東西」這種偽變動。
    for (let i = headerEnd; i < messages.length; i++) {
      const m = messages[i];
      if (!m || m.role !== 'user') continue;
      const norm = textOfTurn(m).replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!norm) continue;
      return 'u:' + createHash('sha1').update(norm).digest('hex').slice(0, 12);
    }
    // 找不到 user（極少數：整段對話流只有開場白、或全是注入）才退回舊做法
    const head = fingerprintTurns(messages.slice(headerEnd, headerEnd + 2));
    return head.join('.');
  }
  return 's:' + createHash('sha1').update(String(systemPrompt || '')).digest('hex').slice(0, 12);
}

/**
 * 兩把 key 是不是同一個聊天。相等＝同一個；「單則長成雙則」（開場白單則的 key 是雙則 key 的前綴）也算同一個。
 * 其餘一律當換了——寧可多丟一發基準，不拿別的對話當基準（8/28 第五種變形的紀律）。
 */
export function sameConversation(prevKey, curKey) {
  if (prevKey === curKey) return true;
  if (typeof prevKey !== 'string' || typeof curKey !== 'string') return false;
  return prevKey.length === 12 && !prevKey.includes('.') && curKey.startsWith(prevKey + '.');
}

function traceTurns(messages, headerEnd, reqNo, evaluated, splitInfo, compIn) {
  // 26-09-02（CX-260902-01）：**預設開**。原本要設 TCB_TURN_TRACE=1，使用者不會設環境變數，
  // 於是「每一則是誰、變沒變」這份資料從來沒到過任何使用者手上。
  // 現在逐則**結構**永遠落檔（role／kind／長度／同／移位／新，不含內容）。
  // 會碰到內容的兩格——每則的 head（開頭 30 字）、split.reason 裡變動點那則的開頭片段——
  // 只在診斷模式落檔；預設模式的 split.reason 先把片段剝掉（stripContentHead）再落，console 那行也只在診斷模式。
  // （cache-log 的 rewriteDiff——前後各 24 字＋前後文 36 字——是另一條線，預設就落，不歸這段管。）
  const trace = traceEnabled();   // 26-09-02 ⑨：面板 /config 的 trace 欄或環境變數，兩者其一
  try {
    const { decision, prevFps, prevLens, fps } = evaluated || evaluateBreakpoint(messages, headerEnd);
    const comp = compIn || composeTurns(messages, headerEnd, prevFps, { fps, prevLens });
    const entry = {
      t: new Date().toISOString(),
      n: reqNo,
      total: messages.length,
      headerEnd,
      convKey: (evaluated && evaluated.convKey) ?? null,   // 26-09-02 對話識別（CX-260902-03 ⑤），跟 cache-log 同一把
      // 拆塊實況：開關開了沒／有沒有真的拆／切在哪。沒有這格的話，
      // 「標記沒貼上去」與「貼了但沒作用」在 cacheRead 上完全同形，查不出來。
      // reason 在不拆時夾著 describeDivergentTurn() 的「、開頭：「…30 字…」」——那是內容。
      // 預設模式落檔前剝掉、只留結構描述；診斷模式才原樣落（26-09-02 審核 C11a）。
      // 只改落檔這份拷貝——cacheTally.lastSkipReason（面板用，本機即時看）照舊帶片段。
      split: splitInfo
        ? { ...splitInfo, reason: trace ? splitInfo.reason : stripContentHead(splitInfo.reason) }
        : { enabled: splitEnabled(), applied: false, reason: '本次呼叫沒帶 splitInfo' },
      divergence: decision.divergence,
      breakpoint: decision.index,
      // 距尾第幾則——這是跟施工卡規格對話用的單位
      depthFromTail: decision.index ? messages.length - decision.index : null,
      source: decision.source,
      why: decision.why,
      comp: comp.summary,
      // 每則：i/role/kind/len/vs/prevIndex/changed——結構，不含內容。
      // vs 是指紋查表（same／moved／new），changed 是同位置比對；兩個都留——
      // 前者給人讀（插入一則不會把後面全報成變），後者給舊工具讀。
      // changed 比的是 prevFps（上一發），**不是 prevTurnFps**——後者已被 evaluateBreakpoint
      // 更新成這一發的指紋了（26-08-02 的坑，測試擋著）。
      turns: comp.turns.map((t, i) => ({
        ...t,
        changed: prevFps ? (prevFps[i] !== fps[i]) : null,
        ...(trace ? { head: contentHead(messages[i] && messages[i].content) } : {}),
      })),
    };
    // 超過 2MB 留最後 1MB、砍在行界（26-09-02 B4：以前留 200 行，長對話一筆 10KB 以上時幾乎砍不掉東西）
    appendJsonl(path.join(__dirname, 'turn-log.jsonl'), entry, { keepBytes: 1024 * 1024 });
    if (trace) {
      console.log(`[${PLUGIN_ID}] 斷點量測 #${reqNo}：${decision.source} 斷在第 ${decision.index}/${messages.length} 則` +
                  `${decision.divergence !== null ? `（第一個變動在 ${decision.divergence}）` : ''}`);
    }
  } catch (e) {
    // 不靜默吞——靜默會讓「上線即失效」長得跟「正常運作」一樣（8/01 的課）
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
 * 只讀 role 與長度，不碰內容——RP 內容不進 log（同族：cache-log 只存雜湊不存原文的隱私規則）。
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
/**
 * 把 describeDivergentTurn 塞進 reason 的「、開頭：「…」」片段剝掉，只留結構描述。
 * turn-log 預設模式不落內容（26-09-02 審核 C11a）——這句宣稱要成立，落檔前得真的剝。
 * 片段固定長「、開頭：「<單行 ≤31 字>」——」（contentHead 已壓成單行），用後面的「——」當右界，
 * 內容裡就算出現「」也剝得乾淨。
 */
function stripContentHead(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/、開頭：「[\s\S]*?」(?=——)/g, '');
}

function contentHead(content, max = 30) {
  const raw = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(p => (p && typeof p.text === 'string') ? p.text : '').join('')
    : '';
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

// opts（26-09-02 第二波 b ③）：sysInFirstTurn＝系統提示走對話第一則（開時回 3 或 4 塊，見下）；cut1＝舊塊斷點 s1（historyTurns 座標）。
// 不給 opts＝跟以前一模一樣的兩塊。
function splitPromptBlocks(parsed, cut, modelId, { sysInFirstTurn = false, cut1 = null } = {}) {
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
  // 26-09-02 第二波 b ④：門檻算「到斷點為止的整個前綴」＝系統提示＋穩定塊，不是穩定塊自身
  // （spike δ Q2：784 token 的塊排在 11k 前綴後照樣建了快取）。只加橋看得到的 systemPrompt，SDK 內建句不算。
  if (!meetsCacheMinimum(stable, modelId, parsed.systemPrompt || '')) return null;

  const stableBlock = { type: 'text', text: stable, cache_control: { type: 'ephemeral', ttl: '1h' } };
  const movingBlock = { type: 'text', text: moving };
  // 關（預設）、或根本沒有系統提示可搬 → 跟以前一模一樣的兩塊
  if (!sysInFirstTurn || !parsed.systemPrompt) return [stableBlock, movingBlock];

  // ③ 開：系統提示**原樣**當第一塊——不貼 cache_control、不加任何前綴或標記（它在後面斷點的前綴裡，一樣被蓋到）。
  // 有 s1 就切四塊 [sys, 舊塊✓, 新增段✓, 會動塊]：舊塊逐字不動 → 跳斷點只重寫增量。
  // 不變式擴成：除 sys 外所有塊依序接回 ＝ 原始 prompt 逐字（舊塊＋新增段＝穩定塊，穩定塊＋會動塊＝prompt，上面已驗）。
  const sysBlock = { type: 'text', text: parsed.systemPrompt };
  if (cut1 > 0 && cut1 < cut) {
    const old = `<history>\n${turns.slice(0, cut1).join('\n')}\n`;
    const add = `${turns.slice(cut1, cut).join('\n')}\n`;
    // 舊塊的斷點也要過門檻（算到 s1 為止的前綴＝系統提示＋舊塊，跟 ④ 同一把尺）——
    // 不到門檻的標記會被靜默忽略、還白佔一個配額，那就退化成三塊，穩定塊仍是 0..s2
    if (old + add === stable && meetsCacheMinimum(old, modelId, parsed.systemPrompt)) {
      return [
        sysBlock,
        { type: 'text', text: old, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: add, cache_control: { type: 'ephemeral', ttl: '1h' } },
        movingBlock,
      ];
    }
  }
  return [sysBlock, stableBlock, movingBlock];
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

// ── 兩條回應路徑的共同部分（26-09-02 審核 B3）────────────────────────────
// 串流／非串流原本各抄一份：SDK options（30 行，唯一差別 includePartialMessages）、result 訊息收取（20 行，逐字相同）、
// recordUsage 的 ctx（20 行，差 mode／aborted／suffix）。26-08-01 與 26-08-27 兩次「只改一半」都是這個形狀，
// parity 測試只堵得住 ctx 那一種。抽成三支之後**結構上不可能只改一半**——差異（串流的 partial chunk、
// 非串流的 finish_reason）留在各自路徑，這裡只放兩邊必須一模一樣的東西。

/** 送進 SDK query 的 options。兩條路徑唯一的差別是串流要 includePartialMessages。 */
export function buildQueryOptions(modelId, systemPrompt, { stream, sysInFirstTurn = false } = {}) {
  return {
    // ③ 開關開：系統提示已放進 prompt 那則 user 的 content[0]，這裡**不傳**（SDK 的內建句仍在，那不歸我們管）。
    // 一處改、兩條路徑都生效——這正是 26-09-02 把 options 抽成一支的理由。
    systemPrompt: sysInFirstTurn ? undefined : systemPromptForSdk(systemPrompt),
    tools: [],
    // 省掉自動標題生成（26-08-01 實測發現）。
    // SDK 型別原文：提供 title 就「skips automatic title generation」。
    // 不給的話，每次請求 SDK 會另外叫一次 Haiku 去生標題——實測它吃 527 tokens 輸入，
    // 比主模型那次（161）還多三倍，佔總成本約四成。那個標題從頭到尾沒有任何用途。
    // 設 TCB_AUTO_TITLE=1 可退回舊行為（重新讓 SDK 自動生標題），供對帳。
    title: process.env.TCB_AUTO_TITLE === '1' ? undefined : 'SillyTavern bridge',
    maxTurns: 1,
    model: modelId,
    permissionMode: 'dontAsk',
    persistSession: persistSessionOption(),
    ...(stream ? { includePartialMessages: true } : {}),
    settingSources: [],
    ...thinkingOption(),
    ...effortOption(),
  };
}

/**
 * 收取 result 訊息：成本、自帶的 usage、診斷五欄、result 原文，並在出錯時印 SDK 原文。
 * diag 就地寫入（空回覆診斷要用），回 { costUsd, resultUsage, resultModelUsage }。
 */
export function absorbResult(msg, diag, reqNo) {
  // 欄位名相容：SDK 型別寫的是 total_cost_usd，舊版是 cost_usd。
  // 只讀 cost_usd 會讓成本永遠是 0——而 costUsd===0 正是「模型沒被叫起來」
  // 的診斷指紋之一，讀錯欄位會讓那條判準對所有空回覆誤診（26-08-01 實測抓到）。
  const costUsd = Number(msg.total_cost_usd ?? msg.cost_usd) || 0;
  diag.costUsd = costUsd;   // 「零成本」是「模型根本沒被叫起來」的指紋之一
  diag.subtype = msg.subtype;
  diag.num_turns = msg.num_turns;
  diag.is_error = msg.is_error;
  // result 自己帶的文字（26-08-03 加，外部使用者回報後補）：額度用盡時 SDK
  // **不拋例外**、照樣回一個 result，指紋跟憑證失效一模一樣——唯一能分辨的
  // 線索就在這段文字裡。沒有它，兩種病因在畫面上完全同形。
  if (typeof msg.result === 'string' && msg.result.trim()) diag.resultText = msg.result.slice(0, 300);
  dumpResultOnError(reqNo, msg);   // 出錯才印，正常路徑零噪音
  // usage 直接從 result 訊息拿——不必事後呼叫 API（那時 transport 已關，
  // 會拿到 'ProcessTransport is not ready for writing'）。
  return { costUsd, resultUsage: msg.usage || null, resultModelUsage: msg.modelUsage || null };
}

/** 優先用 result 訊息自帶的 usage；都沒有才退回主動查詢（readUsage 會把失敗原因記在模組狀態裡）。 */
async function resolveUsage(absorbed, q) {
  if (absorbed && (absorbed.resultUsage || absorbed.resultModelUsage)) {
    return { usage: absorbed.resultUsage, modelUsage: absorbed.resultModelUsage };
  }
  return readUsage(q);
}

/**
 * recordUsage 的 ctx。base 是兩條路都有的材料（splitInfo／evaluated／systemDrift／comp 整包丟進來，
 * 這裡負責挑欄），mode／aborted／suffix 是路徑各自的。
 * 欄位集合由 record-usage-parity.test 釘住——加欄位加在這裡，兩條路同時拿到。
 */
export function usageCtx(base, { mode, aborted = false, suffix = aborted ? ' (讓位/斷線)' : '' } = {}) {
  const { reqNo, modelId, effort, shape, imgCount, costUsd, splitInfo, evaluated, systemDrift, comp } = base;
  // 26-09-03（CX-260903-01 ③）：連續漂移的計數與建議句。句子在後端組好——
  // 前端 import 不到後端函式，兩邊各組一次遲早各說各話（跟 lastCompLine 同一條紀律）。
  return {
    reqNo, mode, modelId, effort, shape, imgCount, costUsd,
    // 26-09-02（審核 A4）：帳上要看得出這發被打斷（console 後綴＋cache-log 的 aborted），兩條路都帶
    aborted, suffix,
    splitApplied: splitInfo.applied,
    splitReason: splitInfo.reason,
    splitDivergence: splitInfo.divergence ?? null,
    splitZone: splitInfo.zone ?? null,
    // ③ 系統提示走第一則：這發有沒有搬、兩個快取點在哪（關閉時三格都 null，cache-log 不落）
    splitSysFirst: splitInfo.sysFirst ?? null,
    splitS1: splitInfo.s1 ?? null,
    splitS2: splitInfo.s2 ?? null,
    // 改寫診斷落檔（26-08-29）：差異片段預設就落，完整前後兩版要開診斷模式。
    // 橋是唯一看得到實際送出內容的位置——外部工具攔不到 payload 的時候，這裡是唯一的證據源。
    shiftKind: evaluated?.shift?.kind ?? null,
    shiftDropped: evaluated?.shift?.dropped ?? null,
    rewriteDiff: evaluated?.rewriteDiff ?? null,
    rewriteFull: evaluated?.rewriteFull ?? null,
    systemDrift: systemDrift.changed,   // 26-08-27：串流那條原本漏了，面板因此對使用者說「還沒記到原因」
    sysHash: systemDrift.hash,
    sysRecurring: systemDrift.recurring,
    comp: comp.summary,   // 26-09-02 組成表彙總（CX-260902-01）
    convKey: evaluated?.convKey ?? null,   // 26-09-02 對話識別（CX-260902-03 ⑤）：事後看有沒有換鑰匙
    convBase: evaluated?.baseSource ?? null,   // 26-09-03 ①：基準從哪來（prev／recall／none）
    sysDriftStreak: base.sysDriftStreak ?? null,
    sysDriftAdvice: base.sysDriftAdvice ?? null,
  };
}

// 把 SDK 的錯誤翻成使用者能處置的一句話。**翻譯後面一律括號保留原文**——
// 給錯處置比不給更糟（EMPTY_REASONS 那段的教訓）：翻錯了至少原文還在，人能自己查。
// 26-09-02（審核 A7）收窄兩條正則：舊的 `not.?found` 把「model: xxx not found」翻成「找不到 CLI」，
// 舊的 `log.?in` 把「Error logging request」翻成「未登入」——都是叫人去修一個不存在的病。
function humanError(err) {
  const msg = (err && err.message) || String(err);
  const withRaw = text => `${text}（原始錯誤：${msg}）`;
  if (/not.?(logged|authenticated)|please.?log.?in|unauthorized|401/i.test(msg)) {
    return withRaw('Claude Code 尚未登入。請在終端機執行 claude login 完成訂閱登入後重啟 SillyTavern。');
  }
  if (/rate.?limit|too.?many|quota|exceeded/i.test(msg)) {
    return withRaw('額度已達上限或請求太頻繁。稍後再試，或到 claude.ai Settings → Usage 查看額度。');
  }
  if (/overloaded|capacity/i.test(msg)) {
    return withRaw('Claude 伺服器忙碌中，稍後再試。');
  }
  if (/ENOENT|spawn|command.?not.?found/i.test(msg)) {
    return withRaw('找不到 Claude Code CLI。請確認已安裝 Claude Code（npm install -g @anthropic-ai/claude-code）並完成登入。');
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

  // 票先開、斷線監聽先掛；**讓位與坐上位子都等驗證通過之後**（見下方 releaseCurrent 那段）。
  // current = ticket 若在讓位之前就設，releaseCurrent 會把自己讓掉。
  const ticket = { q: null, aborted: false };
  let completionId = null;   // 兩條路徑與外層 catch 都要用，所以提到 try 外
  let modelId = null;
  // 連線還活著才寫——讓位時 res 還開著，要收尾；酒館自己斷線時 res 已關，寫了也沒人收。
  const resAlive = () => !res.writableEnded && !res.destroyed;
  // SSE 收尾三件套：finish chunk＋[DONE]＋end。正常、被讓位、拋錯三條路都走這支，不會再有哪條忘了收。
  const endSse = (finishReason) => {
    if (!resAlive()) return;
    res.write(`data: ${JSON.stringify(makeChunk(completionId, modelId, {}, finishReason))}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  };
  // 26-09-02（審核 A3）：SDK 拋錯不准靜默——以前兩條路的 catch 只把 humanError 回給酒館，
  // 終端機空白、cache-log 那一發不存在、requestCount 不加，事後看 log 像「那一發沒發生過」。
  // 讓位／斷線造成的中斷不算錯（那是設計），不記。
  let counted = false;   // requestCount 這發加過了沒（正常路徑加在收尾，拋錯路徑加在這裡，不重複）
  const noteSdkError = (err, mode) => {
    if (ticket.aborted) return;
    if (!counted) { requestCount++; counted = true; }
    const msg = String((err && err.message) || err).slice(0, 300);
    console.error(`[${PLUGIN_ID}][${requestCount}] SDK 拋錯：${msg}`);
    appendCacheLog({ t: new Date().toISOString(), n: requestCount, mode, error: msg });
  };

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

    // 26-09-02（審核 A9）：JSON.parse('null') 會成功，直接解構就炸成 500 帶 JS 內部錯誤字串。
    // 不是物件（null／陣列／字串／數字）一律 400——那是客戶端的錯，不是伺服器的。
    const isObj = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    const { messages, model: requestModel, stream } = isObj ? parsed : {};

    if (!isObj || !Array.isArray(messages)) {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: isObj ? 'messages must be an array' : 'request body must be a JSON object', type: 'invalid_request' } }));
      }
      return;
    }

    // 酒館在 body 還沒讀完就斷線（26-09-02 審核 A8）：這則已經沒人要了——不讓位、不呼叫 SDK。
    // 以前這裡照樣 spawn CLI 把 prompt 送出去，API 端多半已計 input tokens，白燒一發。
    if (ticket.aborted) return;

    // 新的一則進來＝玩家要這一則，前一則直接讓位（不再回 429 把人擋在門外；26-07-25 Mini 拍板）。
    // 26-09-02（審核 A6，Mini 拍板 ⑦）讓位**移到驗證之後**：以前任何 POST 進來先讓位再驗證，
    // 一個註定回 400／413 的壞請求（監控腳本、瀏覽器預檢、另一個分頁的測試連線）也會把
    // 正在生成的主回覆殺掉。讓位語義是「玩家要新的一則」，壞請求不是玩家要的那一則。
    await releaseCurrent('新請求進來');
    current = ticket;

    modelId = requestModel || 'claude-opus-4-6[1m]';
    // ②：救援路徑要拿上一發的指紋判「這則 system 是不是跟著對話移位」；prevTurnKey 讓它自己驗基準是不是同一個對話
    const parsedMsgs = parseMessages(messages, { prevFps: prevTurnFps, prevKey: prevTurnKey });
    const { systemPrompt, prompt, images, headerEnd } = parsedMsgs;
    // 斷點：量測模式與拆塊模式共用同一次計算（兩邊各算一次會讓第二次拿自己當基準，
    // 見 evaluateBreakpoint 的註解）。兩個開關都關著就完全不算，不付這個成本。
    // 26-09-02（CX-260902-01）：組成表**預設開**，每發都要有「上一發的指紋」可比，所以斷點評估
    // 不再看開關——它本來就是純計算，基準只在請求成功後由 commitTurnBaseline 提交。
    // 拆塊關著時 evaluated 照算但不用來切，只餵組成表與診斷。
    const evaluated = evaluateBreakpoint(messages, headerEnd, conversationKey(systemPrompt, messages, headerEnd));
    // 組成表：每一則是 系統區／對話／注入、多長、跟上一發 同／移位／新。
    // 彙總進 cache-log 與面板，逐則進 turn-log（traceTurns）。指紋沿用 evaluated 算好的，不重算。
    // 為什麼要它：一位使用者的「擴充功能 7,074 token」在酒館面板只有總數、內建子項全是 0——
    // 那七千來自第三方擴充的注入，只存在於送出的那一刻，檔案裡看不到，只有這裡看得到。
    const comp = composeTurns(messages, headerEnd, evaluated.prevFps, { fps: evaluated.fps, prevLens: evaluated.prevLens });
    // 26-09-03（CX-260903-01 ③）：系統區連續漂了幾發、是哪幾則。連續 ≥3 發才開口，
    // 而且**只由實測到的漂移觸發**——「系統區有幾條綠燈」這類靜態特徵推論不出漂移（見 sysDriftAdvice 的守門註解）。
    const sysStreak = trackSysDriftStreakPending(comp.summary.sys, evaluated.baseSource !== 'none');
    comp.summary.sys.driftStreak = sysStreak.streak;
    const 漂移建議 = sysDriftAdvice(sysStreak.streak, sysStreak.idx);
    if (漂移建議) console.warn(`[${PLUGIN_ID}] 第 ${requestCount + 1} 發：${漂移建議}`);
    // 斷點量測：算出斷點該落在哪一則並落檔，但**不改變送出去的東西**。
    // 放在兩條路徑（串流／非串流）分岔之前，一次涵蓋——8/01 只改非串流那份、真實情境一次都沒觸發，不再犯。
    // （26-08-02 定位兇手用的前綴切段雜湊工具已於 26-09-02 退役（審核 B7③，Mini 拍板 ⑩）——
    //   turn-log 逐則指紋＋cache-log 的 sysHash 覆蓋同一件事。）
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
    completionId = `chatcmpl-${randomUUID().slice(0, 8)}`;
    // 有圖 → 串流輸入模式（SDK 才收得到 image block）；沒圖 → 維持原本的字串 prompt
    const hasImages = images.length > 0;
    // ③ 系統提示走對話第一則：開關開、而且真的有系統提示可搬才算（沒有就跟關一樣）。這一發從頭到尾用同一個值。
    const sysFirst = sysInFirstTurnEnabled() && !!systemPrompt;

    // ── 拆塊（26-08-03 起預設開，面板可關；開關語義見 splitEnabled 上方）─────
    // 把對話流切兩塊、穩定那塊貼 cache_control(1h)，讓快取斷點落在「會動區之外」。
    // 三道閘任何一道不過就退回原本的單一字串——**寧可不省，也不要送出被動過的內容**。
    let splitBlocks = null;
    const splitInfo = { enabled: splitEnabled(), applied: false, cut: null, stableChars: null, movingChars: null, reason: null, sticky: null };
    // ③ 開時才多這三格（關時 splitInfo／turn-log／cache-log 的形狀跟以前一模一樣）：s1／s2＝兩個快取點（historyTurns 座標）
    if (sysFirst) { splitInfo.sysFirst = true; splitInfo.s1 = null; splitInfo.s2 = null; }

    // 系統提示有沒有在變（26-08-27，CX-260827-01 第四刀）。
    // 拆塊只管對話那一段，但 system 排在更前面——它動一個字，後面整包作廢，
    // 而症狀跟「拆塊沒生效」在讀數上完全同形（cacheRead 都是 0）。這一格是為了分得出來。
    // 只存雜湊不存原文（使用者的角色卡與預設不落盤）。
    const systemDrift = trackSystemPromptPending(systemPrompt);   // 寫暫存，成功才提交（26-09-02 A10）
    if (systemDrift.changed) {
      cacheTally.systemDriftCount = (cacheTally.systemDriftCount || 0) + 1;
      // 26-09-01：這裡原本寫「常見來源：…（時間戳最常見）」——那是指認，不是陳述。
      // 一位使用者照著去翻角色卡與預設裡的 {{time}}／{{date}}，翻不到，因為她的形狀
      // 根本不是那型（雜湊會落回看過的值）。v1.8.2 立過「診斷的本分是報實況不是抓兇手」，
      // 這一格漏掉了。現在改成：分得出來才講，分不出來就說還分不出來。
      const shape = systemDrift.recurring
        ? '**這串雜湊之前出現過**——系統提示是在幾個狀態之間來回切換，'
          + '比較像「有東西時有時無」（例如世界書條目按關鍵字激活／不激活），'
          + '而不是「有東西每則重算」。這型拔不掉，修法是把它移出系統提示區、搬到末尾。'
        : '還分不出是哪一型：記下這串雜湊，多幾發就知道——'
          + '每次都是新值＝有東西每則重算（那型可以拔掉）；'
          + '落回看過的值＝有東西時有時無（那型要搬走，拔不掉）。';
      console.warn(`[${PLUGIN_ID}] 第 ${requestCount + 1} 發：**系統提示跟上一發不一樣**`
        + `（雜湊 ${systemDrift.hash}）——它排在對話前面，一變整包快取就作廢，拆塊救不了。`
        + shape);
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
      // ③ 開關開時 jumpGain 預設 6（跳斷點只重寫增量、代價小，門檻可以低）；關時維持 40。TCB_JUMP_GAIN 仍可覆蓋兩者。
      const held = stickyBreakpointPending(evaluated.decision,
        Math.max(1, parseInt(process.env.TCB_JUMP_GAIN, 10) || (sysFirst ? 6 : 40)),
        { multi: sysFirst });   // 寫暫存，成功才提交（26-09-02 A5）；multi＝同時記舊塊座標 s1
      splitInfo.sticky = (({ nextSticky, ...pub }) => pub)(held);   // turn-log 只落 index／mode／gain（開關開時多 s1），跟以前一樣
      const cut = cutFromMessageIndex(parsedMsgs.historyMsgIdx, held.index);
      splitInfo.cut = cut;
      const cut1 = sysFirst && held.s1 != null ? cutFromMessageIndex(parsedMsgs.historyMsgIdx, held.s1) : null;
      splitBlocks = splitPromptBlocks(parsedMsgs, cut, modelId, { sysInFirstTurn: sysFirst, cut1 });   // 內部會自檢「接回來一字不差」與份量門檻，不合就回 null
      if (splitBlocks) {
        splitInfo.applied = true;
        // 帶標記的塊＝穩定區（關閉時只有一塊、跟以前同值；開時可能是舊塊＋新增段兩塊）；最後一塊永遠是會動塊
        const marked = splitBlocks.filter(b => b.cache_control);
        const stableText = marked.map(b => b.text).join('');
        splitInfo.stableChars = stableText.length;
        splitInfo.movingChars = splitBlocks[splitBlocks.length - 1].text.length;
        splitInfo.stableTokensEst = estimateTokens(stableText, modelId);
        if (sysFirst) {
          splitInfo.s1 = marked.length === 2 ? cut1 : null;   // 四塊才有 s1（三塊＝退化、或還沒累積到第一次跳）
          splitInfo.s2 = cut;
        }
        // ④ 門檻對的是前綴（系統提示＋穩定塊）；跟門檻並排印的數字也要是前綴，不然看起來像放行了不夠格的塊
        splitInfo.prefixTokensEst = estimateTokens(systemPrompt || '', modelId) + splitInfo.stableTokensEst;
        splitInfo.minTokens = minCacheTokensFor(modelId);
        console.log(`[${PLUGIN_ID}] 拆塊 #${requestCount + 1}：歷史 ${cut}/${parsedMsgs.historyTurns.length} 則進穩定塊` +
                    `（${splitInfo.stableChars} 字元／約 ${splitInfo.stableTokensEst} token 貼 1h 標記；到斷點為止約 ${splitInfo.prefixTokensEst} token 含系統提示，門檻 ${splitInfo.minTokens}），` +
                    `其餘 ${splitInfo.movingChars} 字元不貼` +
                    `｜斷點 ${held.mode}${held.gain != null ? `（可多納 ${held.gain} 則）` : ''}` +
                    (sysFirst ? `｜系統提示走第一則，快取點 ${splitInfo.s1 != null ? `2 個：第 ${splitInfo.s1}／${splitInfo.s2} 則` : `1 個：第 ${splitInfo.s2} 則`}` : ''));
      } else {
        // 理由要分得出「切不出來」與「切得出來但份量不夠」——這兩件在 cacheRead 上完全同形，
        // 而後者正是 26-08-27 那個 bug 的臉。不分流的話，修好了也看不出修好沒有。
        const turns = parsedMsgs.historyTurns || [];
        const stablePreview = cut > 0 && cut < turns.length ? `<history>\n${turns.slice(0, cut).join('\n')}\n` : '';
        // ④ 跟份量閘同一把尺：到斷點為止的整個前綴（系統提示＋穩定塊）
        const sysEst = estimateTokens(systemPrompt || '', modelId);
        const est = sysEst + estimateTokens(stablePreview, modelId);
        const min = minCacheTokensFor(modelId);
        splitInfo.stableTokensEst = est - sysEst;
        splitInfo.prefixTokensEst = est;
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
          : (evaluated?.shift?.kind === 'slide'
            // 視窗滑動：**沒有兇手**。舊版在這裡寫「有東西在改這個位置之前的內容」，
            // 把三個工程師送去找一隻不存在的鬼（26-08-29）——變動點根本不是同一則訊息。
            ? `｜**你的對話塞不下上下文了**：這一發比上一發多丟掉 ${evaluated.shift.dropped} 則最舊的訊息。`
              + `不是有東西在改寫你的訊息，是送出去的起點每則都在往後移，快取的前綴因此永遠對不上。`
              + `要解得把起點固定住——把舊對話永久隱藏、或壓成一段不再變動的摘要；`
              + `也可以把「回覆保留長度」調小，那會讓每次少丟一點舊訊息（但只要對話還是超過預算，滑動就還在）。`
              + `這一項橋修不了，是酒館設定層的事`
            : `｜量到的變動點在第 ${div} 則（距離最新第 ${Math.max(0, messages.length - div)} 則）`
              + `——這個位置的內容跟上一發不同，快取從這裡開始整包作廢。`
              // 講得出「變成什麼」就別只講「哪裡變了」（26-08-29）：那個變動點只差兩個字元，
              // 三個人推了一小時才猜到是時間巨集的分鐘進位——而這個差異橋本來就看得到。
              + (evaluated?.rewriteDiff
                  ? `｜**跟上一發差在這裡**：「${evaluated.rewriteDiff.before}」→「${evaluated.rewriteDiff.after}」`
                    + `（前後文：⋯${evaluated.rewriteDiff.context}⋯）`
                  : '')
              + `｜常見來源：會把狀態寫回舊訊息的變數系統、每則重算的深度注入、系統提示裡的時間戳`
              + 首則);
        splitInfo.divergence = div ?? null;
        // 落在哪一區也存起來——面板要顯示，不能只活在終端機那行 log 裡
        splitInfo.zone = (typeof div === 'number' && Number.isFinite(parsedMsgs.headerEnd))
          ? (div < parsedMsgs.headerEnd ? 'system' : 'chat') : null;
        splitInfo.reason = stablePreview && est < min
          ? `到斷點為止只有約 ${est} token（含系統提示；穩定塊 ${stablePreview.length} 字元），低於 ${modelId || '(未指定模型)'} 的最小可快取長度 ${min}——貼了會被 API 靜默忽略，所以整發不拆`
          : `切不出來（cut=${cut}，歷史 ${turns.length} 則）${變動位置}`;
        console.log(`[${PLUGIN_ID}] 拆塊 #${requestCount + 1}：這發不拆（${splitInfo.reason}）`);
      }
    } else if (!splitInfo.enabled) {
      splitInfo.reason = SPLIT_LOCKED_OFF ? '拆塊被啟動參數鎖住（TCB_SPLIT=0）' : '拆塊開關關著（面板可開）';
    }
    // 落檔放這裡：要把「開關開了沒／有沒有真的拆／切在哪」寫進同一筆，
    // 讀數沒跳時才分得出「沒貼標記」與「貼了沒作用」——這兩件在 cacheRead 上完全同形。
    traceTurns(messages, headerEnd, requestCount + 1, evaluated, splitInfo, comp);

    // ③ 開關開：系統提示原樣當 prompt 那則 user 的 content[0]（不貼、不加標記）；有拆時 splitPromptBlocks 已經把它排在第一塊
    const buildPrompt = () => (
      splitBlocks ? makeSplitPrompt(splitBlocks, images)
        : sysFirst ? makeSplitPrompt([{ type: 'text', text: systemPrompt }, { type: 'text', text: prompt || '(empty message)' }], images)
          : hasImages ? makeImagePrompt(prompt, images)
            : prompt
    );
    // recordUsage 的材料，兩條路共用；reqNo／costUsd 要等收尾才知道，呼叫時再補
    const ctxBase = { modelId, effort: configEffort, shape, imgCount: hasImages ? images.length : 0, splitInfo, evaluated, systemDrift, comp, sysDriftStreak: sysStreak.streak, sysDriftAdvice: 漂移建議 };

    // 讓位期間（await releaseCurrent）酒館若已斷線，這裡再擋一次——SDK 一發都別燒
    if (ticket.aborted) return;

    // 26-09-02（審核 A12，Mini 拍板 ⑧）：stream 缺省走 JSON——OpenAI 規範預設 stream=false。
    // 以前 `=== false` 才走 JSON，curl／第三方客戶端不帶 stream 會拿到一坨 data: 行。酒館永遠帶布林，不受影響。
    if (stream !== true) {
      try {
        let fullText = '';
        let thinkingText = '';
        let absorbed = null;     // result 訊息收取結果（costUsd／resultUsage／resultModelUsage）；沒收到 result 就是 null
        const blockTypes = [];   // 這輪模型產出的 block 型別序列（空回覆診斷用）
        const diag = {};         // result 的 subtype/num_turns/is_error 與 stop_reason
        const q = queryFn({ prompt: buildPrompt(), options: buildQueryOptions(modelId, systemPrompt, { stream: false, sysInFirstTurn: sysFirst }) });
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
            absorbed = absorbResult(msg, diag, requestCount + 1);
            break; // 串流輸入模式不會自己收尾（SDK 等下一則輸入），拿到 result 就走
          }
        }

        const usage = await resolveUsage(absorbed, q);
        const costUsd = absorbed ? absorbed.costUsd : 0;
        requestCount++; counted = true;
        totalCostUsd += costUsd;

        // 快取讀數（26-08-01 加）。省額度的關鍵在快取有沒有命中，但這個數字
        // 原本拿到了卻沒印也沒傳——診斷不了就只能憑感覺猜「是不是有省到」。
        // 記帳走共用的 recordUsage、ctx 走共用的 usageCtx（串流那條也呼叫同兩支，結構上不可能只改一半）
        const { cacheFields, cacheRead, hitPct, inTok, outTok } = recordUsage(usage, usageCtx(
          { ...ctxBase, reqNo: requestCount, costUsd }, { mode: 'json', aborted: ticket.aborted }));

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
            // 26-09-02（審核 A4，Mini 拍板 ⑥）：被讓位／斷線的那則回 length（OpenAI 慣例的「沒寫完」）。
            // 以前回 stop——半截當完整回覆送出去，客戶端分不出來。
            finish_reason: ticket.aborted ? 'length' : 'stop',
          }],
        };
        if (usage) {
          // 既有三個欄位維持原樣，一個字都不動。
          // 曾經想把 prompt_tokens 改成「未快取＋快取讀」的總和（OpenAI 慣例是含快取），
          // 收回了：usage_EXPERIMENTAL() 的 input_tokens 含不含快取沒有保證，
          // 如果它本來就是總和，加上去就是重複計算——酒館顯示的用量會直接翻倍。
          // 診斷欄位只該用加的；改動既有欄位的語意，要等實跑數字對過帳再說。
          // 26-09-02（審核 A1）：三欄改用 recordUsage 攤平後的 inTok／outTok。usage 變數在上面已被包成
          // { usage, modelUsage }，舊碼讀 usage.input_tokens 永遠 undefined → 三欄恆 0（cached_tokens 卻是對的）。
          // 語意不動：prompt_tokens 仍是 SDK 給的 input_tokens（含不含快取由 SDK 定，這裡不自己加總）。
          responseBody.usage = {
            prompt_tokens: inTok || 0,
            completion_tokens: outTok || 0,
            total_tokens: (inTok || 0) + (outTok || 0),
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
        noteSdkError(err, 'json');
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

    // 斷線／讓位的處理統一在函式開頭那個 res.on('close') 與 releaseCurrent()，這裡不再另掛
    try {
      // 26-09-02（審核 A2）：queryFn 呼叫搬進 try。以前在 try 外——SSE 標頭已送出後它若同步拋錯，
      // 會跳到外層 catch，而外層只在 !headersSent 才回應：連線懸掛到酒館超時、終端機一個字都沒有。
      const q = queryFn({ prompt: buildPrompt(), options: buildQueryOptions(modelId, systemPrompt, { stream: true, sysInFirstTurn: sysFirst }) });
      ticket.q = q;

      let absorbed = null;     // result 訊息收取結果；沒收到 result 就是 null
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
          absorbed = absorbResult(msg, diag, requestCount + 1);
          break; // 串流輸入模式不會自己收尾，拿到 result 就走
        }
      }

      const usage = await resolveUsage(absorbed, q);
      const costUsd = absorbed ? absorbed.costUsd : 0;
      requestCount++; counted = true;
      totalCostUsd += costUsd;
      // 串流路徑（酒館的預設路徑）——記帳跟非串流走同一支 recordUsage、同一支 usageCtx
      recordUsage(usage, usageCtx({ ...ctxBase, reqNo: requestCount, costUsd }, { mode: 'stream', aborted: ticket.aborted }));

      // 整輪一個字都沒送出＝空回覆。印黑盒子，並補一則通知取代空白畫面（26-07-27 外部使用者案）。
      // 被讓位／斷線的不算空回覆——那是被打斷，不是模型沒話講。
      if (!ticket.aborted && !sentText && resAlive()) {
        const notice = makeChunk(completionId, modelId, { content: emptyReplyNotice(requestCount, blockTypes, diag) }, null);
        res.write(`data: ${JSON.stringify(notice)}\n\n`);
      }
      // 26-09-02（審核 A4，Mini 拍板 ⑥）：被讓位的那則以前**不收尾**（無 stop chunk、無 [DONE]、不 end）——
      // 打斷者若不是酒館自己（酒館按停止會 abort fetch，那條走 res 'close'），連線就吊到客戶端超時。
      // 現在只要連線還活著就收尾；finish_reason 用 length 標「沒寫完」，跟非串流同一套說法。
      endSse(ticket.aborted ? 'length' : 'stop');
    } catch (err) {
      noteSdkError(err, 'stream');
      if (!ticket.aborted && resAlive()) {
        const errChunk = makeChunk(completionId, modelId, { content: `\n\n[${humanError(err)}]` }, null);
        res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
      }
      endSse(ticket.aborted ? 'length' : 'stop');
    }
  } catch (err) {
    noteSdkError(err, res.headersSent ? 'stream' : 'json');
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: humanError(err), type: 'server_error' } }));
    } else if (resAlive()) {
      // 26-09-02（審核 A2）：標頭已送（串流）才炸到這層——以前這裡什麼都不做也不 end，酒館掛到超時。
      // 補一個 error chunk 再收尾：畫面上看得到原因、連線關得掉。
      const errChunk = makeChunk(completionId, modelId, { content: `\n\n[${humanError(err)}]` }, null);
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
      endSse('stop');
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
// traceTurns 一併 export：測試要驗的是**本體**，不是複製一份邏輯去測
// （複製品測過≠本體會動，26-08-01 只改非串流那份的同族教訓）
// applyConfig／recordUsage 也 export（26-09-02 wave2-ε）：turn-trace 測 /config 的 trace 欄、cache-stats 測 recordUsage → cacheRoi 的價目接線——測本尊，不抄副本。
// sysInFirstTurnEnabled（26-09-02 第二波 b ③）：split-toggle 測 /config 的 sysInFirstTurn 欄要驗本尊
export { info, init, exit, parseMessages, thinkingOption, handleChatCompletions, _setQueryFn, traceTurns, splitPromptBlocks, makeSplitPrompt, splitEnabled, sysInFirstTurnEnabled, cacheSummary, applyConfig, recordUsage };
