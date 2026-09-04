// 快取斷點掃描器（26-08-02 承曦｜CX-260802-03 橋拆塊改造 第一步）
//
// 要解的問題：對話流要切兩塊——穩定區貼 cache_control(ttl 1h)、會動區不貼。
// 斷點放錯一則，省幅直接砍半，而且**失效方式是安靜的**（照樣有命中，只是少一半）。
//
// 為什麼不照「列舉機制」做（偏離霽野 21:16 規格字面，這裡說明理由）：
//   原規格是「掃描世界書 @D 值／正則 minDepth／Horae 深度，取最大值＋1」。問題有兩層——
//   ① **橋看不見那些設定**。它收到的是酒館組好的 messages，設定在酒館那側，
//      要讀就得跨進別人家的檔案結構（路徑會漂、版本會變，MEMORY 有前例）。
//   ② **列舉會漏，而且今天剛漏過一次**：卡上原本寫「距尾第 5 則」就是只算了注入層、漏掉蛇。
//      蛇那種「改寫舊樓內容」的機制，在單一發請求裡根本看不出痕跡——它不新增訊息，它改寫。
//
// 所以改成量測：**橋自己記住上一發每一則的指紋，這一發逐則比對，第一個對不上的位置就是邊界。**
//   這正是 API 快取自己在做的事（純前綴比對），我們只是把同一把尺拿到橋這側先量一次。
//   好處：不管使用者之後裝什麼外掛、改哪個 depth、開關哪條正則，它自己會跟著走——
//   沒有人需要記得回來更新一張清單。
//
// 誠實邊界（交件時要一起講的）：
//   - 第一發沒有基準可比，只能用 fallback（保守值）。快取本來就是第二發起才讀得到，代價可接受。
//   - 「上一發沒動到」不等於「以後不會動」——偶發型機制（條件觸發的正則）可能在某一發才現形。
//     safetyTurns 就是為這個留的邊際；真被咬到時，症狀是那一發少命中，不會壞掉。
//   - 本模組只算位置，不負責貼標記與渲染；貼標記在橋本體，兩邊的分工線寫在下面 API 註解。

import { createHash } from 'node:crypto';

/** 一則訊息的內容指紋。role 一起算進去——同樣一句話換個角色說，對模型是不同的東西。 */
/**
 * 一則訊息的可比對文字。**指紋與差異片段共用這一支**（26-08-29 導出）——
 * 兩邊各寫一份取法，遲早會走樣成「指紋說變了、差異說沒變」那種自己打自己的診斷。
 *
 * 塊之間的分隔用 NUL（U+0000），跟指紋同一個字元：那是為了讓
 * 『a』+『bc』與『ab』+『c』算出不同的結果。
 * **原始碼裡一律用 `\u0000` 逸出寫法，別回寫成原始字元**（26-09-02 審核 B1）——
 * 原始 NUL 會讓 git 把整支檔當二進位：11 次改版一次 diff 都看不到、grep 搜不到函式名。
 * 逸出寫法在 JS 裡是同一個字元，createHash 吃到的位元組一模一樣，指紋值不變。
 */
export function textOfTurn(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    // 圖片塊只取型別與 url 長度，不把 base64 整包丟進雜湊（一張圖幾百 KB，白算）
    return msg.content.map(p =>
      p?.type === 'image_url' ? `img:${(p.image_url?.url || '').length}` : (p?.text || '')
    ).join('\u0000');
  }
  if (msg.content != null) return String(msg.content);
  return '';
}

/** 一則訊息的內容指紋。role 一起算進去——同樣一句話換個角色說，對模型是不同的東西。 */
export function fingerprintTurn(msg) {
  if (!msg) return 'null';
  const content = textOfTurn(msg);
  return createHash('sha1').update(`${msg.role || ''}\u0000${content}`).digest('hex').slice(0, 12);
}

/**
 * 兩段文字「差在哪」的最小片段。
 *
 * 為什麼要它（26-08-29，v1.8.2）：橋以前只講得出「變動點在第幾則、開頭是什麼」，
 * 使用者拿到座標仍然不知道那裡變成什麼。那晚三個人推了一小時，最後是外部工程
 * 從「只差兩個字元」猜到是時間巨集的分鐘進位——**那個資訊橋本來就看得到，只是沒說**。
 *
 * 隱私：只回差異的那一小截與一點點前文，比現有的「開頭 30 字」暴露更少。
 * 兩邊完全相同、或任一邊不是字串 → 回 null（呼叫端不顯示這一格）。
 */
export function shortDiff(a, b, { max = 24, contextChars = 12 } = {}) {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  if (a === b) return null;

  // 共同前綴
  let head = 0;
  const minLen = Math.min(a.length, b.length);
  while (head < minLen && a[head] === b[head]) head++;

  // 共同後綴（不跟前綴重疊）
  let tail = 0;
  while (tail < minLen - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const before = a.slice(head, a.length - tail).slice(0, max);
  const after = b.slice(head, b.length - tail).slice(0, max);

  // 前文脈絡：差異點前面幾個字，讓人一眼認得出這是時間／數字／狀態
  const context = a.slice(Math.max(0, head - contextChars), head + max);

  return { before, after, context };
}

/** 整串訊息的指紋陣列。橋每發存一份，下一發拿來比。 */
export function fingerprintTurns(messages) {
  return (messages || []).map(fingerprintTurn);
}

/**
 * 整串訊息的長度陣列（26-09-03，CX-260903-01 ②）。
 *
 * 為什麼指紋之外還要存長度：綾的實測（26-09-03）——酒館把同 position 的觸發條目**合併成一則**，
 * 而多則共用同一個 order 值時排序不保證穩定，於是出現「長度相同、則數相同、**只有內容順序不同**」。
 * 指紋只答得出「一不一樣」，答不出「一樣長還是連長度都變了」——而這兩件的病因與修法完全不同：
 * 長度也變＝觸發組合換了（哪幾條進來不一樣）；長度沒變只換順序＝排序不穩（order 撞號）。
 * 光存指紋做不到這個分辨，所以基準要多存一份長度。長度是數字，不含內容。
 */
export function lengthsOfTurns(messages) {
  return (messages || []).map(m => textOfTurn(m).length);
}

/**
 * Anthropic 的每百萬 token 單價——Opus 4.6 那組（歷史匯出名，保留給還在 import 它的人）。
 *
 * 出處（26-08-29）：外部工程凌敘從真實 cache-log 拿六筆帳單反推、另外四筆驗算，
 * 每筆吻合到小數點後四位。**這比任何一份文件都硬**，尤其「新建 = 2 倍」那一格——
 * 它直接決定「該不該貼快取」這個判斷的正負號。
 * 順帶，2 倍本身就是「這是 1h 快取」的證據：5m 的新建是 1.25 倍。
 */
export const PRICE_PER_MTOK = {
  input: 5,
  cacheWrite: 10,   // 一般輸入的 2 倍
  cacheRead: 0.5,   // 一般輸入的 0.1 倍
  output: 25,
};

/**
 * 按模型查價（26-09-02 審核 C10b：舊版寫死 Opus 4.6，Sonnet／Haiku／Fable 使用者面板上的
 * 「多付 US$x」差 2～5 倍）。
 *
 * 數字出處：claude-api skill（bundled 2.1.258）——
 *   基價：SKILL.md「Current Models」表（Fable 5.1／Fable 5 $10／$50、Opus 5／4.8／4.7／4.6 $5／$25、
 *         Sonnet 5 $2／$10、Sonnet 4.6 $3／$15、Haiku 4.5 $1／$5）
 *   倍率：shared/prompt-caching.md「Economics」段——1h 快取寫 2×、讀 0.1×；**Fable 5.1 讀 0.025×**（$0.25/MTok）
 *   凌敘從真實帳單反推的 Opus 4.6 那組（上面）跟表對得上，兩邊互相印證。
 *
 * 比對用前綴（startsWith）：橋預設的 modelId 是 'claude-opus-4-6[1m]' 這種帶後綴的字串。
 * **順序有意義**：長的排前面（fable-5-1 要在 fable-5 之前）。
 */
export const PRICE_TABLE = [
  { match: 'claude-fable-5-1',  input: 10, output: 50, writeMul: 2, readMul: 0.025 },
  { match: 'claude-fable-5',    input: 10, output: 50, writeMul: 2, readMul: 0.1 },
  { match: 'claude-opus-5',     input: 5,  output: 25, writeMul: 2, readMul: 0.1 },
  { match: 'claude-opus-4-8',   input: 5,  output: 25, writeMul: 2, readMul: 0.1 },
  { match: 'claude-opus-4-7',   input: 5,  output: 25, writeMul: 2, readMul: 0.1 },
  { match: 'claude-opus-4-6',   input: 5,  output: 25, writeMul: 2, readMul: 0.1 },
  { match: 'claude-sonnet-5',   input: 2,  output: 10, writeMul: 2, readMul: 0.1 },
  { match: 'claude-sonnet-4-6', input: 3,  output: 15, writeMul: 2, readMul: 0.1 },
  { match: 'claude-haiku-4-5',  input: 1,  output: 5,  writeMul: 2, readMul: 0.1 },
];

/** 沒帶 modelId 時沿用的舊行為（index.mjs 目前的 cacheHistory 還沒記 model 欄，接線前先不讓面板整個沒金額）。 */
export const DEFAULT_PRICE_MODEL = 'claude-opus-4-6';

/**
 * 查某個 modelId 的每百萬 token 單價。查不到回 null——呼叫端遇 null 只印 token、不印 US$。
 * @returns {{model:string, input:number, cacheWrite:number, cacheRead:number, output:number}|null}
 */
export function priceFor(modelId) {
  if (typeof modelId !== 'string') return null;
  const id = modelId.trim().toLowerCase();
  const row = PRICE_TABLE.find(r => id.startsWith(r.match));
  if (!row) return null;
  return { model: row.match, input: row.input, cacheWrite: row.input * row.writeMul, cacheRead: row.input * row.readMul, output: row.output };
}

/**
 * 快取到底划不划算——**那筆「新建」的錢有沒有收回來**。
 *
 * 第九種形狀（26-08-29）：面板寫「新建快取 50,000」，使用者以為橋做了件好事，
 * 實際上新建付的是一般輸入的兩倍價；如果他習慣隔幾小時才玩一則，快取早就過期，
 * 那筆錢**一次都收不回來**。實案：某使用者最近六則付 $4.15，完全不走快取只要 $2.79
 * ——多付 33%，換到零次命中。
 *
 * 判定不需要問任何人：帳本裡有時間與 cacheRead，連續兩發的間隔加上「這發有沒有讀到」
 * 就足夠。**刻意不動 TTL**——同一位使用者連著玩時是 10~30 分鐘一則，1h 有效、5m 無用，
 * 改短會把她唯一會命中的那幾發也弄掉。面板的工作是讓人看懂自己屬於哪一類，不是替他選。
 *
 * 價目（26-09-02）：按 modelId 查表——opts.modelId 優先，沒給就看帳本最後一筆的 model／modelId 欄，
 * 都沒有就沿用 Opus 4.6（DEFAULT_PRICE_MODEL，舊行為）。**有給但查不到** → extraUsd／savedUsd 回 null，
 * 面板只印 token 不印 US$。verdict 不靠美元、靠倍率（各模型新建 2×／讀 0.1× 結構相同，Fable 5.1 讀 0.025×），
 * 所以查不到價目也照樣下得了判斷。
 *
 * 四檔判定（26-09-02 審核 C10a 加 wasted_heavy）：
 *   wasted        一次都沒讀到
 *   paying-off    省下 > 多付
 *   wasted_heavy  有讀到、但多付 > 3 × 省下（舊版把這種也叫「打平附近」——saved $0.05 vs extra $2.00）
 *   mixed         其餘
 *
 * @param {Array<{atMs?:number, cacheWrite?:number, cacheRead?:number, model?:string, modelId?:string}>} entries 由舊到新
 * @param {{minSamples?:number, modelId?:string|null}} [opts]
 * @returns {{verdict:'wasted'|'wasted_heavy'|'paying-off'|'mixed'|'unknown', extraUsd:number|null, savedUsd:number|null,
 *            lastGapHours:number|null, writes:number, reads:number, writeTok:number, readTok:number, priceModel:string|null}}
 */
export function cacheRoi(entries, opts = {}) {
  const { minSamples = 2 } = opts;
  const none = { verdict: 'unknown', extraUsd: 0, savedUsd: 0, lastGapHours: null, writes: 0, reads: 0, writeTok: 0, readTok: 0, priceModel: null };
  if (!Array.isArray(entries) || entries.length < minSamples) return none;

  let writeTok = 0, readTok = 0, writes = 0, reads = 0;
  for (const e of entries) {
    const w = Number(e?.cacheWrite) || 0;
    const r = Number(e?.cacheRead) || 0;
    writeTok += w; readTok += r;
    if (w > 0) writes++;
    if (r > 0) reads++;
  }

  // 用哪個模型的價：opts 明給 > 帳本最後一筆自帶 > 舊預設（Opus 4.6）
  let modelId = opts.modelId;
  if (modelId == null) {
    for (let i = entries.length - 1; i >= 0 && modelId == null; i--) {
      const m = entries[i]?.modelId ?? entries[i]?.model;
      if (typeof m === 'string' && m) modelId = m;
    }
  }
  const price = priceFor(modelId == null ? DEFAULT_PRICE_MODEL : modelId);
  // 倍率：查不到價目時用通用結構（新建 2×、讀 0.1×）下 verdict，金額則不算
  const writeMul = price ? price.cacheWrite / price.input : 2;
  const readMul = price ? price.cacheRead / price.input : 0.1;

  const M = 1_000_000;
  // 多付的：新建比一般輸入貴的那部分（以「一般輸入 1 單位」計）
  const extraUnits = (writeTok / M) * (writeMul - 1);
  // 省下的：讀取比一般輸入便宜的那部分
  const savedUnits = (readTok / M) * (1 - readMul);
  const extraUsd = price ? extraUnits * price.input : null;
  const savedUsd = price ? savedUnits * price.input : null;

  // 上一發到這一發隔多久
  let lastGapHours = null;
  const last = entries[entries.length - 1], prev = entries[entries.length - 2];
  if (typeof last?.atMs === 'number' && typeof prev?.atMs === 'number') {
    lastGapHours = (last.atMs - prev.atMs) / 3600000;
  }

  let verdict;
  if (reads === 0 && writes >= minSamples) verdict = 'wasted';
  else if (savedUnits > extraUnits) verdict = 'paying-off';
  else if (extraUnits > 3 * savedUnits) verdict = 'wasted_heavy';
  else verdict = 'mixed';

  return { verdict, extraUsd, savedUsd, lastGapHours, writes, reads, writeTok, readTok, priceModel: price ? price.model : null };
}

/**
 * 這一發相對上一發是「哪一種變化」——**視窗滑動、內容改寫，還是單純追加**。
 *
 * 為什麼要它（26-08-29，快取案第八種形狀，也是最壞的一種）：前面七種是診斷指錯位置，
 * 這一種是**診斷指出一個不存在的敵人**。實案——使用者的對話 21.7 萬字元塞不進上下文
 * 預算（8 萬減掉保留給輸出的 3 萬），酒館每發從最舊的丟，對話區起點每則往後滑。
 * 橋量到「這個 index 的內容跟上一發不同」就報「有東西在改這裡之前的內容」，
 * 三個工程師照這句話找了一小時的兇手，而那個位置根本不是同一則訊息。
 *
 * **從尾端對齊，不從頭**（外部工程凌敘在動手前攔下的陷阱）：新訊息加在尾巴、
 * 舊訊息從頭上丟，所以尾端穩定、頭端在動。從頭對齊的話，只要世界書條目這發激活、
 * 下發沒激活，前段長度就變了、位移量算錯，然後退回「有東西在改寫」——繞回假兇手。
 *
 * 同一套判定順便分兩種形狀：分界貼齊開頭＝滑動；分界落在中間＝真的有東西改寫
 * （那時面板可以直接把那一則指出來）。
 *
 * 回 { kind, dropped, appended, index, overlap }：
 *   kind: 'slide' | 'rewrite' | 'append' | 'unknown'
 */
export function analyzeShift(currentFps, previousFps, opts = {}) {
  const { minOverlap = 3 } = opts;
  const none = { kind: 'unknown', dropped: 0, appended: 0, index: null, overlap: 0 };
  if (!Array.isArray(currentFps) || !Array.isArray(previousFps)) return none;
  const cl = currentFps.length, pl = previousFps.length;
  if (cl === 0 || pl === 0) return none;

  // 從尾端往前比：新加的在尾巴，所以先找出「這一發尾端有幾則是全新的」。
  // 做法是拿 cur 的每一個尾段起點去對 prev 的尾端，取對得最長的那個。
  let best = { appended: 0, overlap: 0 };
  const maxAppend = Math.min(cl, 16);
  for (let n = 0; n <= maxAppend; n++) {
    let m = 0;
    while (m < cl - n && m < pl && currentFps[cl - n - 1 - m] === previousFps[pl - 1 - m]) m++;
    if (m > best.overlap) best = { appended: n, overlap: m };
  }

  const { appended, overlap } = best;
  if (overlap < minOverlap) return { ...none, appended, overlap };

  // 對齊之後：cur 的這段從 (cl-appended-overlap) 開始，prev 的從 (pl-overlap) 開始。
  const curHead = cl - appended - overlap;   // cur 在對齊段之前還剩幾則
  const prevHead = pl - overlap;             // prev 在對齊段之前還剩幾則
  const dropped = prevHead - curHead;

  // 分界貼齊頭段（cur 前面沒有殘留、或殘留的都對得上）＝單純滑動
  if (dropped > 0) {
    let headMatches = true;
    for (let i = 0; i < curHead; i++) {
      if (currentFps[i] !== previousFps[i]) { headMatches = false; break; }
    }
    // 頭段對得上（系統塊沒動）＋中間少了幾則 → 視窗滑動
    if (headMatches) return { kind: 'slide', dropped, appended, index: curHead, overlap };
    // 頭段也對不上 → 前面那段自己也變了，指出第一個對不上的位置
    let i = 0;
    while (i < curHead && currentFps[i] === previousFps[i]) i++;
    return { kind: 'rewrite', dropped, appended, index: i, overlap };
  }

  // 沒有丟東西：逐則比頭段，找第一個對不上的
  let i = 0;
  const headLen = Math.min(curHead, prevHead);
  while (i < headLen && currentFps[i] === previousFps[i]) i++;
  if (i < headLen) return { kind: 'rewrite', dropped: 0, appended, index: i, overlap };
  return { kind: 'append', dropped: 0, appended, index: null, overlap };
}

/**
 * 前綴分歧點：從頭逐則比，第一個對不上的 index。
 * 兩發都相同（純追加）→ 回較短那份的長度。
 * 沒有基準 → 回 null（呼叫端要走 fallback）。
 *
 * 為什麼從頭比而不是從尾對齊：快取是**前綴**比對，前綴的座標原點在頭不在尾。
 * 對話增長時尾部會位移，從尾對齊會把「多了一輪」誤讀成「全部都變了」。
 */
export function findDivergence(currentFps, previousFps) {
  if (!previousFps || previousFps.length === 0) return null;
  const n = Math.min(currentFps.length, previousFps.length);
  for (let i = 0; i < n; i++) {
    if (currentFps[i] !== previousFps[i]) return i;
  }
  return n;
}

/**
 * 結構掃描（列舉法的可實作版本）：找出深度注入層的**上緣**——header 之後第一個 system 出現的位置。
 * 斷點要放在整個注入層之前，所以要的是最前面那個，不是最靠尾那個。
 *
 * 為什麼不是讀酒館設定（霽野原規格的「掃世界書 @D／正則 minDepth／Horae 深度」）：
 *   橋看不見那些設定。但**注入層在 messages 陣列裡是看得見的**——它就是那一大群 system 小塊。
 *
 * 26-08-02 真實資料（Mini 的 147 則對話，量測第 3 發）驗過方向，兩個數字都是實測：
 *   headerEnd=21，header 之後第一個 system 在 91，注入層一路排到 146（共 50 個）；
 *   **header 之後、91 之前一個 system 都沒有**——對話前段是乾淨的。
 *   我第一版寫成「從尾往前找第一個 system」回傳 146，方向剛好相反；合成測資抓不到
 *   （假資料裡 system 只出現在 header），是真實資料當場打回來的。
 *
 * 限度（寫明，不當隱藏假設）：這招只看得到「新增型」機制（注入塊），看不到「改寫型」機制——
 *   蛇剝舊樓的 UpdateVariable 不新增訊息、只改內容。同一份真實資料：結構法給 91、量測法給 86，
 *   **差的那 5 則正好是蛇改寫的 assistant（@87、@89）**。所以它是 fallback 不是主力。
 *
 * @returns {number} 切片 index（穩定區＝slice(0, index)）；沒有 system 就回 messages.length（不設限）
 */
export function scanInjectionBoundary(messages, headerEnd = 0) {
  if (!Array.isArray(messages)) return 0;
  for (let i = Math.max(0, headerEnd); i < messages.length; i++) {
    if (messages[i] && messages[i].role === 'system') return i;
  }
  return messages.length;
}

/**
 * 決定斷點：回傳「前幾則算穩定區」的則數（切片用的 index，穩定區＝messages.slice(0, index)）。
 *
 * @param {object[]} messages        這一發的完整訊息陣列（含 header）
 * @param {string[]|null} prevFps    上一發的指紋陣列（沒有就 null）
 * @param {object} opts
 *   @param {number} opts.headerEnd     header 區結束位置——斷點不能落在它之前（那段已經在 systemPrompt 裡）
 *   @param {number} opts.safetyTurns   量到的分歧點再往前退幾則（霽野規格的「＋1」，預設 1）
 *   @param {number} opts.fallbackDepth 沒有基準時，距尾保留幾則不進穩定區（預設 8）
 *   @param {number} opts.minStableTurns 穩定區少於這個則數就別貼標記了（預設 4，太短沒省頭還多一次比對）
 * @returns {{index:number, source:string, why:string, divergence:number|null}}
 *   index=0 代表「這發不要拆塊」。
 */
export function decideBreakpoint(messages, prevFps, opts = {}) {
  const {
    headerEnd = 0,
    safetyTurns = 1,
    fallbackDepth = 8,
    minStableTurns = 4,
    warnGap = 5,          // 兩法差超過這個則數就在 why 裡示警（霽野 26-08-02 裁決）
  } = opts;

  const curFps = fingerprintTurns(messages);
  const divergence = findDivergence(curFps, prevFps);

  // 兩法各算一次，取較深者（＝index 較小者）。霽野 26-08-02 22:48 裁決：
  //   「列舉法會過度保守（宣稱會動但實際沒動→少吃一段快取），量測法會過度樂觀
  //     （這輪碰巧沒動→下輪碎一次），取較深者是兩害相權。」
  const structural = scanInjectionBoundary(messages, headerEnd);

  let index, source, why;

  if (divergence === null) {
    // 第一發沒有基準。**不能用固定則數**——26-08-02 真實量測打臉了原本的預設 8：
    // 注入層在陣列裡佔了距尾 60 則，距尾 8 則的斷點會落在注入層正中間，
    // 等於花 2 倍價（1h 快取寫）建一個下一輪必然讀不到的快取。改用結構掃描。
    index = Math.min(structural, Math.max(0, curFps.length - fallbackDepth));
    source = 'fallback';
    why = `沒有上一發可比（第一發或剛換聊天）；結構掃描到注入層上緣（最前面的 system）在 ${structural}，` +
          `距尾固定值給 ${curFps.length - fallbackDepth}，取較深者`;
  } else {
    // **有量到就信量到的**（26-08-27 改，CX-260827-01 第二刀）。
    //
    // 舊版是 `Math.min(measured, structural)`——霽野 26-08-02 22:48 裁「取較深者是兩害相權」。
    // 那個裁決在 Mini 的對話上看不出代價（她的對話前段乾淨，structural 很大，min 幾乎總是
    // 取到 measured）。26-08-27 拿三位外部使用者的症狀回頭量，代價出來了：對話前段只要有
    // **一則內容永遠不變的常駐 system**（世界書常駐條目／作者註記的形狀），structural 就被
    // 釘在那裡，穩定區從 97.3% 掉到 12.2%；那則 system 若出現在第 1 輪，直接變成 0%（不拆）。
    //
    // 兩害相權的前提是兩邊的害差不多，這裡不是：
    //   信 measured 的代價＝偶發機制某一發才現形時「那一發少命中」（不會壞掉，safetyTurns
    //     就是為它留的邊際——這句是本檔原本就寫著的）
    //   信 structural 的代價＝**永遠只有 12% 或 0%**
    //
    // measured 回答的是「這一發實際上哪裡變了」，structural 回答的是「哪裡**可能**會變」。
    // 事實優先於猜測；structural 退回它本來就該待的位置——第一發沒有基準時的 fallback。
    // 它的意見照樣記進 why、差距照樣示警，只是不再蓋掉量到的東西。
    const measured = divergence - safetyTurns;
    index = measured;
    source = 'measured';
    why = `量到第一個變動在 index ${divergence}（距尾第 ${curFps.length - divergence} 則）退 ${safetyTurns} 則＝${measured}；` +
          `結構掃描給 ${structural}（僅供對照，不蓋掉量測值）`;

    // 兩法差距大＝有機制沒被結構掃到（改寫型），或注入層形狀變了。
    // 這個警報本身就是儀器——今晚漏蛇、漏注入層都是這型，做成自動叫的，不靠人記得。
    const gap = Math.abs(measured - structural);
    if (gap > warnGap) {
      why += `｜⚠️ 兩法差 ${gap} 則（>${warnGap}）——可能有改寫型機制沒被結構掃到，或注入層形狀變了`;
    }
  }

  // 斷點不能落進 header——那段已經進了 systemPrompt，不在對話流裡
  if (index < headerEnd) {
    index = headerEnd;
    why += `；被 header 邊界頂到 ${headerEnd}`;
  }
  // 也不能超過訊息總數
  if (index > messages.length) index = messages.length;

  const stableTurns = index - headerEnd;
  if (stableTurns < minStableTurns) {
    // why 要**接在前面算出來的理由後面**，不能整個換掉——否則兩法差距的警告會被這一步吃掉。
    // （26-08-02 測試 F8 抓到：斷點被推得很前面時，剛好同時觸發「差距大」與「穩定區太短」，
    //   而後者把前者的警告蓋掉了——那正是最需要看到警告的情況。）
    return {
      index: 0,
      source: 'skip',
      why: `${why}；但穩定區只有 ${stableTurns} 則（< ${minStableTurns}），拆了不划算，這發不拆`,
      divergence,
    };
  }

  return { index, source, why, divergence };
}

/**
 * 斷點「黏住」（26-08-03 實測定案後補）。
 *
 * 為什麼需要這一層：**貼了 cache_control 的塊必須逐字一模一樣才會命中，前綴相同不算。**
 *   （spike-block-prefix_260803：同塊尾部追加零命中／穩定塊變大零命中／穩定塊不變命中 7,562）
 *   所以斷點如果跟著對話往前推進（每發 +2 則），穩定塊就每發都是新的＝每發重建、永遠讀不到上一發。
 *   標記貼得再準都沒用——這是 26-08-02 晚間拆塊上線後五發全部只命中系統包的真因。
 *
 * 策略：記住上次**實際用過**的斷點，預設不動它，只有兩種情況才跳：
 *   ① forced：會動區追上來了（舊斷點落進變動範圍）——不跳就會送出錯的穩定塊
 *   ② jump：可以多納入的量超過門檻——跳一次那發重建，之後每發多省一截，划算才跳
 *
 * 代價講明：跳的那一發必然不命中（在重建）。所以門檻不能太小，否則一直在重建。
 *
 * @param {{index:number, divergence:number|null}} decision decideBreakpoint 的結果
 * @param {{sticky:number|null}} state 呼叫端持有的狀態（會被就地更新）
 * @param {number} jumpGain 可多納入幾則才值得跳（預設 40）
 * @returns {{index:number, mode:'skip'|'new'|'forced'|'jump'|'held', gain?:number}}
 */
export function stickyBreakpoint(decision, state, jumpGain = 40) {
  // 26-09-02（審核 A5／A10）：**純函式**——不再寫 state.sticky，改回 nextSticky（建議的新值），
  // 由呼叫端決定何時寫。橋在請求成功後才提交；失敗那發（額度不足、斷線）算出來的 jump／forced 全部丟棄，
  // 不然下一發會黏在一個從未送到 API 的位置上。state 只讀 sticky 這一格。
  const cur = state && state.sticky != null ? state.sticky : null;
  const fresh = decision.index;
  if (!(fresh > 0)) return { index: 0, mode: 'skip', nextSticky: cur };

  if (cur == null) return { index: fresh, mode: 'new', nextSticky: fresh };

  // 會動區是否追上舊斷點：divergence＝第一個變動的位置，穩定塊是 0..sticky-1，
  // 所以 sticky == div 時穩定塊一字未變、不用跳；只有 sticky > div（變動點落進穩定塊）才 forced。
  // （26-09-02 審核 C12b：舊寫法 >= 在 sticky == div 時多重建一次）
  const div = decision.divergence;
  if (div !== null && cur > div) return { index: fresh, mode: 'forced', nextSticky: fresh };

  const gain = fresh - cur;
  if (gain >= jumpGain) return { index: fresh, mode: 'jump', gain, nextSticky: fresh };

  return { index: cur, mode: 'held', gain, nextSticky: cur };
}

/**
 * 把對話流按斷點切兩段——**唯一的不變式：兩段接起來要跟不拆時一字不差**。
 * 拆塊的意義是「在同樣的內容上多放一個斷點」，內容一旦被改動，快取全盤落空、
 * 而且症狀是「拆了反而沒省」，最難查（今天那條「純前綴比對」的直接推論）。
 *
 * @param {any[]} flow      對話流陣列（已去掉 header）
 * @param {number} cut      切點（flow 座標系，非 messages 座標系）
 * @returns {{stable:any[], moving:any[]}}
 */
export function splitFlow(flow, cut) {
  if (!Array.isArray(flow)) return { stable: [], moving: [] };
  const c = Math.max(0, Math.min(cut, flow.length));
  return { stable: flow.slice(0, c), moving: flow.slice(c) };
}


/**
 * 快取最小可快取長度（26-08-27 承曦｜CX-260827-01 根因修復）。
 *
 * 為什麼這一段存在：**貼了 cache_control 的塊如果短於模型的最小可快取長度，
 * API 不報錯、直接靜默不快取**（官方：cache_creation_input_tokens 就是 0）。
 * 舊版的把關條件是 decideBreakpoint 的 minStableTurns=4——**那是「則數」不是「份量」**。
 * 在「前幾則是短開場」的對話上，5 則可能只有 226 字元，照樣放行，於是
 * 「貼了 1h 標記」與「其餘幾萬字元不貼」同時成立，整包零有效快取點。
 *
 * 實案（26-08-27 一位使用者貼回來的終端機原文，本次修復的證據）：
 *   拆塊 #69：歷史 5/71 則進穩定塊（226 字元貼 1h 標記），其餘 46457 字元不貼
 * 三位外部使用者、三張不同角色卡，命中率一致落在 3-4%。
 *
 * 誠實邊界（這條課的形狀值得留著）：**門檻表 26-08-02 就寫在
 * `test/spike-cache-threshold_260802.mjs` 的檔頭註解裡**，連「橋現役跑的就是
 * opus-4-6＝4096」都寫了——而同一天寫的拆塊用則數把關。知識在檔案裡、沒接進判準，
 * 而且**在我自己的對話上永遠是綠的**（一則動輒幾百字，4 則早就過門檻）。
 * 這是「本機不會出錯、別人一定會出錯」那一欄：踩不到，所以不會自己發現。
 *
 * 出處：Anthropic prompt caching 文件的 Minimum cacheable prefix 表（查證 26-08-27）。
 * **這張表不是單調的**——新模型反而更低（Opus 5 =512），Opus 4.6／Haiku 4.5 是最高的 4096。
 * 模型改版時這張表要跟著更新；查不到的一律走表中最大值，不走寬鬆值。
 */
export const CACHE_MIN_TOKENS = {
  'claude-opus-5': 512,
  'claude-fable-5-1': 512,   // 26-09-02：同 Fable 5 家族，未另查到不同數字
  'claude-fable-5': 512,
  'claude-mythos-5': 512,
  'claude-opus-4-8': 1024,
  'claude-sonnet-5': 1024,
  'claude-sonnet-4-6': 1024,
  'claude-sonnet-4-5': 1024,
  'claude-opus-4-7': 2048,
  'claude-haiku-3-5': 2048,
  'claude-opus-4-6': 4096,
  'claude-opus-4-5': 4096,
  'claude-haiku-4-5': 4096,
};

/** 查不到就用表裡最嚴的那一檔——猜錯的代價是使用者安靜地多付錢，不是我們少省一點。 */
const CACHE_MIN_FALLBACK = Math.max(...Object.values(CACHE_MIN_TOKENS));

/**
 * 這顆模型的最小可快取 token 數。
 *
 * `[1m]` 是 Claude Code 的 context 變體尾綴，**不是另一顆模型**，比對前剝掉——
 * 正則錨定尾端，不用 contains（同族：26-08-24 霽園模型驗證哨的 [1m] 誤報，
 * 景和擋下來的那一格）。
 */
export function minCacheTokensFor(modelId) {
  if (typeof modelId !== 'string' || !modelId) return CACHE_MIN_FALLBACK;
  const canonical = modelId.replace(/\[1m\]$/, '');
  return CACHE_MIN_TOKENS[canonical] ?? CACHE_MIN_FALLBACK;
}

/**
 * 中文（CJK）一字算幾個 token——**按模型查表**（26-09-02 第二波 b ⑤，審核 C 第 8 條）。
 *
 * 為什麼要查表：係數是 tokenizer 相依的。Opus 4.7 起換了 tokenizer（Opus 4.7／4.8／5、Sonnet 5、
 * Fable 5／5.1、Mythos 都是這顆），同一段字約多 1×～1.35× 的 token；寫死一個數字對某些模型就是錯的。
 *
 * 出處（claude-api skill，bundled 2.1.258；26-09-02 查）：
 *   - SKILL.md「Claude Fable 5.1」段：same tokenizer as Opus 4.8 (introduced with Opus 4.7)…
 *     the Opus 4.7 tokenizer uses ~1×-1.35× as many tokens（相對 Opus 4.6／Sonnet／Haiku）
 *   - shared/model-migration.md「New tokenizer (~30% more tokens)」：Sonnet 5 uses the same new tokenizer
 *     as Opus 4.7/4.8. The same input text produces approximately 30% more tokens than on Sonnet 4.6
 *   - shared/model-migration.md「Tokenizer - unchanged from Opus 4.8」：roughly 1×-1.35×
 *     (varies by content and workload shape)
 *   **沒有任何一份給「CJK 每字幾 token」的數字**，只有整體倍率、而且註明隨內容形狀變。
 *
 * 所以這張表現在**全部是預設值 1.0**、結構先立好：估算必須偏低估（低估 ⟹ 估到夠就是真的夠），
 * 新 tokenizer 產的 token 只會更多，1.0 對它們仍是下界、不會把不夠的說成夠。要往上調（例如新家族 1.3）
 * 得先用 count_tokens 對中文 RP 樣本實測，拿到數字再填——猜一個往上的數字會讓門檻閘變寬鬆，那是錯的方向。
 * 值＝「一個 CJK 字算幾 token」的原始係數；安全折 TOKEN_ESTIMATE_SAFETY 另外打，所以有效係數＝1.0 × 0.9 ＝ 0.9（現行）。
 * 比對用前綴（startsWith），`[1m]` 尾綴先剝；**長的排前面**（fable-5-1 在 fable-5 之前）。
 */
export const CJK_TOKENS_PER_CHAR = {
  default: 1.0,
  // 舊 tokenizer（Opus 4.6 及更早、Sonnet 4.x、Haiku）——現行係數就是照這批量出來的
  'claude-opus-4-6': 1.0,
  'claude-opus-4-5': 1.0,
  'claude-sonnet-4-6': 1.0,
  'claude-sonnet-4-5': 1.0,
  'claude-haiku-4-5': 1.0,
  'claude-haiku-3-5': 1.0,
  // 新 tokenizer（Opus 4.7 起）——實際 token 更多（1×～1.35×），1.0 仍是下界；沒查到 CJK 每字數字，先不往上填
  'claude-opus-4-7': 1.0,
  'claude-opus-4-8': 1.0,
  'claude-opus-5': 1.0,
  'claude-sonnet-5': 1.0,
  'claude-fable-5-1': 1.0,
  'claude-fable-5': 1.0,
  'claude-mythos-5-1': 1.0,
  'claude-mythos-5': 1.0,
};

/** 整體安全折——估完再打九折，讓下界更硬。 */
export const TOKEN_ESTIMATE_SAFETY = 0.9;

/** 查某顆模型的 CJK 係數；查不到、沒給、型別不對都走 default。 */
export function cjkTokensPerChar(modelId) {
  if (typeof modelId !== 'string' || !modelId) return CJK_TOKENS_PER_CHAR.default;
  const id = modelId.trim().toLowerCase().replace(/\[1m\]$/, '');
  const keys = Object.keys(CJK_TOKENS_PER_CHAR).filter(k => k !== 'default').sort((a, b) => b.length - a.length);
  const hit = keys.find(k => id.startsWith(k));
  return hit ? CJK_TOKENS_PER_CHAR[hit] : CJK_TOKENS_PER_CHAR.default;
}

/**
 * 保守估 token 數——**一律往低估的方向**。
 *
 * 方向很重要：低估 ⟹「估到夠」就是「真的夠」。高估會讓無效標記溜過去，
 * 也就是這次要修的那個 bug 換一種形狀復發。
 *
 * 規則：CJK 一字算 cjkTokensPerChar(modelId) 個 token（預設 1；實際常略高於 1），其他字元算 1/4（實際約 1/4），
 * 最後整體再打 0.9 折當安全邊際。橋沒有 tokenizer，也不該為了這件事裝一個——
 * 我們要的不是精確值，是一個「不會把不夠的說成夠」的下界。
 * modelId 不給＝走預設係數（跟 26-09-02 之前的行為逐位相同）。
 */
export function estimateTokens(text, modelId) {
  if (typeof text !== 'string' || !text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x3040 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0x20000 && c <= 0x2fa1f)) cjk++;
  }
  const rest = [...text].length - cjk;
  return Math.floor((cjk * cjkTokensPerChar(modelId) + rest / 4) * TOKEN_ESTIMATE_SAFETY);
}

/**
 * 這塊文字貼上 cache_control 之後，在這顆模型上會不會真的生效。
 *
 * 26-09-02 第二波 b ④：**門檻算的是「到斷點為止的整個前綴」，不是塊自身**。
 * spike δ 實測（spike_多斷點_260902/報告.md 第二節 Q2）：784 token 的塊排在 11k 前綴後照樣建了快取——
 * API 看的是斷點前面累積了多少，塊邊界只決定 lookup 的位置。
 * prefixText＝排在這塊前面、橋自己看得到的那段（systemPrompt）；SDK 自己加的內建句不算進來，
 * 所以估出來的仍是下界（保守側）。不給就是 0，行為跟以前一樣。
 */
export function meetsCacheMinimum(text, modelId, prefixText = '') {
  return estimateTokens(prefixText, modelId) + estimateTokens(text, modelId) >= minCacheTokensFor(modelId);
}


/**
 * 系統提示有沒有在變（26-08-27 承曦｜CX-260827-01 第四刀）。
 *
 * 為什麼需要它：拆塊只管**對話那一段**，但送出去的順序是 system → messages，
 * **系統提示排在更前面**。它只要動一個字，後面整包作廢——拆塊拆得再準都沒有用，
 * 而症狀跟「拆塊沒生效」一模一樣（cacheRead 都是 0），在讀數上完全分不出來。
 *
 * 實案：v1.7.0 發布當天一位使用者回報 **讀快取 0／新建快取 277,109**——
 * 標記有貼、快取有建，只是下一則對不上。橋當時對這一層是瞎的：它從來沒有比對過
 * 「這一發的系統提示跟上一發一不一樣」，所以連「該不該懷疑這裡」都答不出來。
 *
 * 只存雜湊不存原文——使用者的角色卡與預設不落盤，這是紅線（同族：tracePrefix
 * 那段的隱私規則）。成本是一次 sha1，可以常設不必開環境變數。
 */
export function trackSystemPrompt(systemPrompt, state) {
  const text = typeof systemPrompt === 'string' ? systemPrompt : '';
  const hash = createHash('sha1').update(text).digest('hex').slice(0, 12);
  const prev = state.systemHash;
  // 26-09-01：分辨「一直在變」與「來回切換」。判準來自凌敘讀綾的實測——
  // 第 4 發 e2432655122a → 中間變成別的 → 第 7 發又回到 e2432655122a。
  // 落回看過的值＝那塊內容時有時無（例如世界書條目按關鍵字激活），
  // 不是每則重算（時間戳那型雜湊只會一直換、不會回頭）。兩種病修法不同。
  const seen = state.systemHashSeen || (state.systemHashSeen = []);
  const recurring = prev !== undefined && prev !== hash && seen.includes(hash);
  state.systemHash = hash;
  if (!seen.includes(hash)) {
    seen.push(hash);
    if (seen.length > 32) seen.shift();   // 這是每發都走的路徑，歷史要有上限
  }
  if (prev === undefined) return { first: true, changed: false, hash, recurring: false };
  return { first: false, changed: prev !== hash, hash, recurring };
}

// ── 組成拆分（26-09-02，CX-260902-01）────────────────────────────
//
// 規格是外部工程凌敘定的：報出「這一發的每一則是對話還是注入、多長、跟上一發一不一樣」。
// 為什麼要它：一位使用者的「擴充功能 7,074 token」在酒館面板上只有總數、內建子項全是 0——
// 那七千來自第三方擴充的注入，**只存在於送出的那一刻**，檔案裡看不到，只有橋看得到。
//
// 三格是橋原本缺的：
//   ① kind：traceTurns 只記 role 與長度，讀者分不出哪一則是誰塞的
//   ② vs 用指紋查表、**不用位置**——26-09-01 真實資料：世界書條目從 index 20 移到 22，
//      同位置比對會報後面 50 則全變，事實是 0 則變、50 則移位（內容一字未動，只是往後推）
//   ③ 彙總自洽：分項加總＝總數，面板那一行才不會說謊
//
// 隱私：這裡只回 role／kind／長度／指紋，**不回內容**。開頭片段由呼叫端在診斷模式才附。

// role=user 但長得像設定條目的開頭。酒館把預設的部分條目標成 user 送出（26-07-27 外部實況），
// 對話區裡這種 user 不是玩家發言。判錯的代價只在彙總的分母，不影響 vs，所以標問號而不硬判。
const SETTING_HEADS = ['[', '<', '#', '〔', '---', '//', 'CHILD BLOCK', 'GLOBAL BLOCK', '## Phase'];

/** 一則是什麼：sys（系統區）／dlg（對話）／inj（注入）／inj?（疑似注入，推測）／?（壞資料） */
export function kindOfTurn(msg, i, headerEnd = 0) {
  if (!msg) return '?';
  if (i < headerEnd) return 'sys';
  const r = msg.role;
  if (r === 'assistant') return 'dlg';
  if (r === 'system') return 'inj';
  if (r === 'user') {
    const text = textOfTurn(msg);
    if (text.includes('<user_input>')) return 'dlg';      // 酒館包住「當前輸入」的標籤，先判這格
    const head = text.trimStart();
    if (SETTING_HEADS.some(p => head.startsWith(p))) return 'inj?';
    return 'dlg';
  }
  return '?';
}

/**
 * 整串訊息的分類陣列（26-09-04，CX-260904-01）。基準要跟指紋、長度一起存這一份——
 * 重疊率對齊只看**對話則**（kind='dlg'），而分類算得出來的前提是拿得到 messages 與 headerEnd，
 * 下一發手上只剩基準，重算不了。
 */
export function kindsOfTurns(messages, headerEnd = 0) {
  return (messages || []).map((m, i) => kindOfTurn(m, i, headerEnd));
}

// ── 重疊率（26-09-04，CX-260904-01｜凌敘的視窗位移）──────────────────
//
// 為什麼要換掉「錨」這套：1.9.1 綁系統提示雜湊、1.9.2 綁對話流開頭兩則、1.9.3 綁第一則 user 訊息——
// 三個錨全長在對話流內容裡，而**位移的定義就是第一則換人**。酒館的
// `tokenBudget = openai_max_context − openai_max_tokens`（public/scripts/openai.js:3887-3893）
// 一旦不夠裝，每發從最舊的一頭砍掉一組 user+assistant；於是鑰匙**單調變化、永不重複**，
// 1.9.3 那個「記住最近 8 把鑰匙」的假設（鑰匙會在少數幾把之間來回跳）整個不成立——記 80 把也對不上。
//
// 改用內容自己說話：兩發的逐則指紋做偏移對齊，看**最長連續吻合**佔上一發對話則數多少。
// 為什麼是「最長連續」不是「集合交集」：交集會被「同一張卡的兩個不同聊天」騙——
// 那兩個聊天的開場白、常駐條目都一樣，交集看起來很大，但它們接不成一條連續的線。
//
// 為什麼只拿 kind='dlg' 對齊（規格沒寫的判斷，理由記在這）：注入層跟對話層**位移量不同**。
// 綾的形狀是對話尾端追加兩則、47 則注入層整層往後挪 2 格——拿整條對話流去對齊，
// 注入層那 47 則會用 offset=−2 贏過對話層那 19 則，算出來的位移量是注入層的，
// 而 sticky 要修的是斷點（在對話層）。offset 落錯號比不修更糟。
export const CONV_OVERLAP_MIN_RATIO = 0.5;   // 最長連續吻合 / 上一發對話則數，過這條才算同一個對話
export const CONV_OVERLAP_MIN_RUN = 2;       // 絕對下限：只吻合 1 則（同卡共用的開場白）不准算同一個對話
export const CONV_OVERLAP_MAX_OFFSET = 12;   // 偏移搜尋半徑上限（實測位移多在 1–4 格）

/** 偏移搜尋順序：0、1、−1、2、−2 …… 先近後遠、同分時偏向不位移。 */
function* offsetOrder(n) {
  yield 0;
  for (let k = 1; k <= n; k++) { yield k; yield -k; }
}

/**
 * 兩發的**對話則**做偏移對齊，回最佳位移與重疊率。
 *
 * @param {string[]|null} prevFps   上一發的逐則指紋
 * @param {string[]|null} prevKinds 上一發的逐則分類（kindsOfTurns 的結果，跟基準一起存）
 * @param {string[]} curFps         這一發的逐則指紋
 * @param {string[]} curKinds       這一發的逐則分類
 * @returns {{measurable:boolean, offset:number|null, dlgOffset:number|null, run:number, ratio:number,
 *            prevN:number, curN:number, scan:{offset:number,run:number}[]}}
 *   offset＝**messages 座標**的位移量：正數＝這一發從最舊的一頭砍掉幾則（上一發的第 p 則＝這一發的第 p−offset 則）。
 *   dlgOffset＝同一件事的「對話則序號」座標（診斷用）。measurable=false＝兩邊至少一邊沒有對話則，
 *   這種情況**兩個方向都不表態**（不救援也不否決），不拿量不到的東西當證據。
 */
export function alignDialogue(prevFps, prevKinds, curFps, curKinds, opts = {}) {
  const { maxOffset = CONV_OVERLAP_MAX_OFFSET } = opts;
  const none = { measurable: false, offset: null, dlgOffset: null, run: 0, ratio: 0, prevN: 0, curN: 0, scan: [] };
  if (![prevFps, prevKinds, curFps, curKinds].every(Array.isArray)) return none;
  const pick = (fps, kinds) => {
    const out = [];
    for (let i = 0; i < fps.length && i < kinds.length; i++) if (kinds[i] === 'dlg') out.push({ i, f: fps[i] });
    return out;
  };
  const P = pick(prevFps, prevKinds), C = pick(curFps, curKinds);
  if (!P.length || !C.length) return none;

  const scan = [];
  let best = { offset: 0, run: 0, at: -1 };
  for (const o of offsetOrder(Math.min(P.length, maxOffset))) {
    let run = 0, cur = 0, at = -1, start = -1;
    for (let k = 0; k < C.length; k++) {
      const p = k + o;
      if (p < 0 || p >= P.length) { cur = 0; start = -1; continue; }
      if (C[k].f === P[p].f) {
        if (cur === 0) start = k;
        cur++;
        if (cur > run) { run = cur; at = start; }
      } else { cur = 0; start = -1; }
    }
    scan.push({ offset: o, run });
    if (run > best.run) best = { offset: o, run, at };
  }
  // 位移量換算回 messages 座標：最佳連續段第一對的索引差。**不是直接用 dlgOffset**——
  // 對話則之間可能夾著注入則，序號差與索引差不是同一個數。
  const offset = best.run > 0 && best.at >= 0 ? P[best.at + best.offset].i - C[best.at].i : null;
  return {
    measurable: true,
    offset,
    dlgOffset: best.run > 0 ? best.offset : null,
    run: best.run,
    ratio: best.run / P.length,
    prevN: P.length,
    curN: C.length,
    scan,
  };
}

/**
 * 組成表：每一則 { i, role, kind, len, vs, prevIndex } ＋彙總＋這一發的指紋。
 *
 * vs：same（同位同內容）／moved（內容同、位置變，prevIndex 是上一發的位置）／new（上一發沒有：新的或改過）
 *     ／null（沒有上一發可比——第一發不瞎報）。
 * 對位規則：同指紋在上一發出現多次（兩則空白 assistant 那種）→ 取離自己最近的、用過的不重用。
 * gone：上一發有、這一發沒對到的則數（被換掉或被丟掉的）。
 *
 * @param {object[]} messages  這一發完整訊息陣列（含 header）
 * @param {number} headerEnd   系統區止於第幾則（parseMessages 算的，這裡不重算——判準只能有一份）
 * @param {string[]|null} prevFps 上一發的指紋陣列（fingerprintTurns 的結果）；沒有就 null
 * @param {object} opts fps＝這一發算好的指紋（不重算）；prevLens＝上一發的長度陣列（lengthsOfTurns），
 *                      有給才算得出 sameLenDiffContent（26-09-03 ②）；
 *                      offset＝這一發相對基準的位移量（alignDialogue 量的），落進 summary.dlg.offset（26-09-04 ②）
 */
export function composeTurns(messages, headerEnd = 0, prevFps = null, { fps: fpsIn, prevLens = null, offset = null } = {}) {
  const msgs = Array.isArray(messages) ? messages : [];
  // 呼叫端已算過這一發的指紋（evaluateBreakpoint）就直接用——每發兩次全量 sha1 是浪費
  const fps = Array.isArray(fpsIn) && fpsIn.length === msgs.length ? fpsIn : fingerprintTurns(msgs);
  const hasPrev = Array.isArray(prevFps) && prevFps.length > 0;

  const prevPos = new Map();
  if (hasPrev) prevFps.forEach((f, p) => {
    if (!prevPos.has(f)) prevPos.set(f, []);
    prevPos.get(f).push(p);
  });
  const used = new Set();

  const turns = msgs.map((m, i) => {
    const kind = kindOfTurn(m, i, headerEnd);
    const len = textOfTurn(m).length;
    let vs = null, prevIndex = null;
    if (hasPrev) {
      const cands = (prevPos.get(fps[i]) || []).filter(p => !used.has(p));
      if (cands.length) {
        let best = cands[0];
        for (const p of cands) if (Math.abs(p - i) < Math.abs(best - i)) best = p;
        used.add(best);
        prevIndex = best;
        vs = best === i ? 'same' : 'moved';
      } else {
        vs = 'new';
      }
    }
    return { i, role: (m && m.role) || '?', kind, len, vs, prevIndex };
  });

  const bucket = k => turns.filter(t => (k === 'inj' ? t.kind.startsWith('inj') : t.kind === k));
  const agg = (k, withVs) => {
    const xs = bucket(k);
    const o = { n: xs.length, chars: xs.reduce((n, t) => n + t.len, 0) };
    if (withVs) {
      o.changed = hasPrev ? xs.filter(t => t.vs === 'new').length : null;
      o.moved = hasPrev ? xs.filter(t => t.vs === 'moved').length : null;
    }
    return o;
  };

  const summary = {
    headerEnd,
    sys: agg('sys', true),
    dlg: agg('dlg', false),
    inj: agg('inj', true),
    gone: hasPrev ? prevFps.length - used.size : null,
  };

  // 位移量（26-09-04 ②，CX-260904-01）：正數＝這一發從最舊的一頭砍掉幾則；0＝沒位移；null＝沒有基準可比。
  // 為什麼要露這一格：凌敘 26-09-04 是自己拿兩發的 turns 做偏移對齊才量出「往前滾 2 格」的——
  // 那件事橋自己就知道，卻沒寫進任何一格，於是使用者只看得到「convKey 換了、convBase=none」，
  // 長得跟「換聊天」一模一樣。診斷不講位移量，人就會去查一個沒動過的系統區。
  summary.dlg.offset = hasPrev && typeof offset === 'number' ? offset : null;

  // 系統區的兩格細節（26-09-03，CX-260903-01 ②）。只放 sys——那是「一變整包快取全毀」的那一段，
  // 也是綾唯一需要指名道姓的地方；注入區跟著對話走，逐則指名沒有可操作性。
  //
  // changedIdx：changed 是則數，答不出「是哪幾則」——而建議句要點名（見 sysDriftAdvice）。
  //             判準跟 changed 同一條（vs === 'new'），兩處不准各算一次。
  // sameLenDiffContent：**同一個位置、長度一樣、內容雜湊不同**。
  //             這格是為綾 26-09-03 那個形狀開的：她的 idx 10 兩發都是 4130 字元、開頭卻不一樣——
  //             合併區塊裡多則共用同一個 order，排序不保證穩定，於是則數同、長度同、順序不同。
  //             舊的 changed／moved 對這型完全瞎：它跟「內容真的改了」在讀數上一模一樣，
  //             而使用者看到「長度沒變」會直覺認為「那就不是它」——診斷把人帶去查錯地方。
  //             這裡比的是**同位置**（prevFps[i] vs fps[i]），不是指紋查表：位置移動那型歸 moved 管。
  summary.sys.changedIdx = hasPrev ? turns.filter(t => t.kind === 'sys' && t.vs === 'new').map(t => t.i) : null;
  summary.sys.sameLenDiffContent = (hasPrev && Array.isArray(prevLens) && prevLens.length)
    ? turns.filter(t => t.kind === 'sys'
        && typeof prevFps[t.i] === 'string' && prevFps[t.i] !== fps[t.i]
        && prevLens[t.i] === t.len).map(t => t.i)
    : null;

  return { turns, summary, fps };
}

/** 連續漂移幾發才開口（26-09-03 ③）。1、2 發可能只是換了角色卡或剛改完設定，不值得指認。 */
export const SYS_DRIFT_STREAK_MIN = 3;

/**
 * 系統區連續漂移的建議句（26-09-03，CX-260903-01 ③）。回 null＝不出聲。
 *
 * **只由實測到的連續漂移觸發**——這條是外部工程凌敘 26-09-03 給的守門線，不是潔癖：
 * 使用者吟雪同樣有 2 條綠燈（關鍵字觸發條目）插在系統提示區、3,258 字元，
 * 但橋兩次量到的系統塊都是 9,322，一個 token 都沒差。
 * 所以「系統區有幾條綠燈／系統區多長／有幾則」這類**靜態特徵推論不出漂移**，
 * 拿它當觸發條件＝對沒病的人喊病，而診斷喊錯一次，下次真的喊了也沒人信。
 * 這支只吃兩個參數：連續漂了幾發、是哪幾則——兩個都是量出來的。
 *
 * 措辭上的一個坑（26-09-01 立、26-09-03 承曦裁決後定案）：面板原本有一句「把條目改成 @D 深度插入」，
 * 後來刪掉了，因為**深度注入本身也可能落回系統提示區**，那句會把人帶回同一個坑。
 * 但 26-09-01 刪那句的真正問題是「只給方向不給驗證法」——現在有驗證法了，不給下一步
 * 反而是把人丟在半路。所以下一步照給，**把驗證那一步寫進句子裡**：改完再玩一則回來看這句還在不在。
 *
 * 另一條（吟雪的教訓，26-09-03 承曦裁）：**用使用者看得到的字，不是我們自己的字**。
 * 「深度注入」是酒館世界書那一格的欄位名，她在面板上找得到；只寫「@D」她不知道要點哪裡。
 */
export function sysDriftAdvice(streak, idx) {
  if (!(typeof streak === 'number' && streak >= SYS_DRIFT_STREAK_MIN)) return null;
  if (!Array.isArray(idx) || idx.length === 0) return null;
  const 則 = idx.join('、');
  const 這幾則 = idx.length === 1 ? '這一則' : idx.length === 2 ? '這兩則' : '這幾則';
  return `系統提示第 ${則} 則連續 ${streak} 發每一發都在變。`
    + `它們排在整包內容的**最前面**，最前面一變，後面全部的快取跟著作廢——這一層拆塊救不了。`
    + `這型多半是世界書「關鍵字觸發」的條目（綠燈）全放在提示詞開頭，被酒館合併成同一大塊：`
    + `每回合被觸發的是哪幾條都不一樣，合出來的那塊就每發不一樣。`
    + `想修就得把${這幾則}背後的條目搬出系統提示區——`
    + `把插入位置從「提示詞開頭」改成插進對話裡（酒館的世界書裡那格叫「深度注入」或 @D），`
    + `或者把最常用的那幾條改成常駐、讓內容每發固定下來。`
    + `**改完再玩一則、回來看這句還在不在**：有些深度注入設定仍然會落回系統提示區，這句消失了才算真的搬走。`;
}

/** 面板／console 那一行。數字取自 summary，不另外算——兩處各算一次遲早各說各話。 */
export function composeLine(summary) {
  if (!summary) return '';
  const k = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const vsNote = (o) => (o.changed === null ? '' : `（${o.changed} 變${o.moved ? `、${o.moved} 移位` : ''}）`);
  return `組成：系統區 ${summary.sys.n} 則 ${k(summary.sys.chars)}${vsNote(summary.sys)}`
    + `｜對話 ${summary.dlg.n} 則 ${k(summary.dlg.chars)}`
    + `｜注入 ${summary.inj.n} 則 ${k(summary.inj.chars)}${vsNote(summary.inj)}`
    + (summary.gone ? `｜上一發少了 ${summary.gone} 則` : '');
}
