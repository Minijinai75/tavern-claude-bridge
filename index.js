const PLUGIN_ID = 'tavern-claude-bridge';
const API_BASE = `/api/plugins/${PLUGIN_ID}`;
const UI_PREFIX = 'tcb';
const SETTINGS_KEY = 'tavern_claude_bridge';
const LOCAL_VERSION = '1.9.2';
const GITHUB_RELEASE_API = 'https://api.github.com/repos/Minijinai75/tavern-claude-bridge/releases/latest';
let updateCache;

const DEFAULT_SETTINGS = {
  bridgePort: 5199,
  // Claude 原生思考摘要。預設關——詳細理由見 server 端 thinkingOption() 上方註解，
  // 簡版：它跟預設自己的 <thinking> 思考鏈搶同一條通道，開著反而讓思考中英不穩。
  sdkThinking: false,
  // 拆塊省快取。預設開（26-08-03 起）——真實流量實測一則 $2.3459 → $0.7149。
  // 後端也預設開，所以沒裝這個前端面板的人一樣受益；這格只是讓使用者關得掉。
  cacheSplit: true,
  // 診斷模式（26-09-02 第二波）。預設關——開著時後端會把每則送出內容的開頭 30 字寫進本機 turn-log.jsonl
  // （平常那份只記雜湊不記原文），用來對照「是哪一則害快取失效」。看完就該關，所以預設不勾。
  turnTrace: false,
  // 省更多快取＝系統提示走對話第一則（26-09-02 第二波 b ③，試驗中）。預設關——關的時候一切跟現在一樣。
  // 開了會多一個快取點（長對話省更多），代價是角色卡從 system 角色變 user 角色、語氣可能微妙地變，所以由使用者自己選。
  sysInFirstTurn: false,
};

function getCtx() {
  try { return globalThis.SillyTavern?.getContext?.() ?? null; }
  catch { return null; }
}

function getHeaders({ omitContentType = false } = {}) {
  const ctx = getCtx();
  const headers = ctx?.getRequestHeaders ? { ...ctx.getRequestHeaders() } : {};
  if (omitContentType) delete headers['Content-Type'];
  return headers;
}

function loadSettings() {
  const ctx = getCtx();
  if (!ctx) return DEFAULT_SETTINGS;
  const root = ctx.extensionSettings;
  if (!root) return DEFAULT_SETTINGS;
  root[SETTINGS_KEY] = root[SETTINGS_KEY] || {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (root[SETTINGS_KEY][k] === undefined) root[SETTINGS_KEY][k] = v;
  }
  return root[SETTINGS_KEY];
}

function isNewer(remote, local) {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

async function checkForUpdate() {
  if (updateCache !== undefined) return updateCache;
  try {
    const res = await fetch(GITHUB_RELEASE_API, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
    });
    if (!res.ok) { updateCache = null; return null; }
    const data = await res.json();
    const latest = (data.tag_name || '').replace(/^v/, '');
    if (latest && isNewer(latest, LOCAL_VERSION)) {
      updateCache = { version: latest, url: data.html_url };
    } else {
      updateCache = null;
    }
  } catch {
    updateCache = null;
  }
  return updateCache;
}

async function probePlugin() {
  try {
    const res = await fetch(`${API_BASE}/status`, {
      method: 'GET',
      headers: getHeaders({ omitContentType: true }),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function buildPanel() {
  const container = document.getElementById('extensions_settings2')
    || document.getElementById('extensions_settings');
  if (!container) {
    console.error(`[${PLUGIN_ID}] Settings container not found`);
    return;
  }

  const settings = loadSettings();

  const drawer = document.createElement('div');
  drawer.className = 'inline-drawer';
  drawer.innerHTML = `
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Claude Bridge</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="${UI_PREFIX}-panel">
        <div class="${UI_PREFIX}-status">
          <span class="${UI_PREFIX}-dot" id="${UI_PREFIX}-dot"></span>
          <span id="${UI_PREFIX}-status-text">偵測中…</span>
        </div>
        <div class="${UI_PREFIX}-info" id="${UI_PREFIX}-info"></div>
        <div class="${UI_PREFIX}-update" id="${UI_PREFIX}-update"></div>
        <div class="${UI_PREFIX}-models" id="${UI_PREFIX}-models"></div>
        <div class="${UI_PREFIX}-cache" id="${UI_PREFIX}-cache"></div>
        <div class="${UI_PREFIX}-option">
          <label class="checkbox_label">
            <input type="checkbox" id="${UI_PREFIX}-split">
            <span>拆塊省快取（建議開著）</span>
          </label>
          <small id="${UI_PREFIX}-split-note">快取＝讓 Claude 記住上一則已經讀過的東西，下一則只重算新的部分、少付錢。打勾後，橋會把對話裡「已經不會再變」的那一大段單獨圈起來記住，下一則就不用整包重算。實測一則從 $2.35 降到 $0.71。改設定、切換角色卡都會重建一次；世界書分兩種：關鍵字觸發的條目每次開關都會重建，常駐條目改內容才重建一次——這些都是正常的。覺得回覆怪怪的就先關掉，橋會退回原本的送法。</small>
        </div>
        <div class="${UI_PREFIX}-option">
          <label class="checkbox_label">
            <input type="checkbox" id="${UI_PREFIX}-thinking">
            <span>使用 Claude 原生思考摘要</span>
          </label>
          <small>預設關閉。你的預設如果自己會要求角色輸出思考（例如正文開頭的 <code>&lt;thinking&gt;</code> 區塊），請保持關閉——兩者會搶同一條通道，開著會讓思考變成中英混雜、偶爾整輪空白回覆。用素卡、想看 Claude 自己的推理摘要再打開。</small>
        </div>
        <div class="${UI_PREFIX}-option">
          <label class="checkbox_label">
            <input type="checkbox" id="${UI_PREFIX}-sysfirst">
            <span>省更多快取（試驗中，預設關）</span>
          </label>
          <div class="${UI_PREFIX}-cache-warn" id="${UI_PREFIX}-sysfirst-warn" hidden></div>
          <small id="${UI_PREFIX}-sysfirst-note">打勾後，角色卡跟系統提示會改放進對話的第一則一起送出。這樣橋可以多釘一個快取點，長對話省下來的錢會明顯多一截。代價：模型看角色卡的方式可能有一點不一樣，語氣可能微妙地變。想試就開、覺得怪就關，隨時可以切回來。</small>
        </div>
        <div class="${UI_PREFIX}-option">
          <label class="checkbox_label">
            <input type="checkbox" id="${UI_PREFIX}-trace">
            <span>診斷模式（平常不用開）</span>
          </label>
          <div class="${UI_PREFIX}-cache-warn" id="${UI_PREFIX}-trace-warn" hidden></div>
          <small id="${UI_PREFIX}-trace-note">打勾之後，你每送出一則，橋就把那一則開頭的 30 個字記進你自己電腦裡的 <code>turn-log.jsonl</code>（在 SillyTavern 的 plugins/tavern-claude-bridge 資料夾），用來對照「到底是哪一則害快取失效」。只會存在你的電腦，不會傳給任何人。查完記得關掉，免得一直累積。</small>
        </div>
        <div class="${UI_PREFIX}-actions">
          <button id="${UI_PREFIX}-refresh" class="menu_button" type="button">
            <i class="fa-solid fa-rotate"></i> 重新偵測
          </button>
          <button id="${UI_PREFIX}-selftest" class="menu_button" type="button">
            <i class="fa-solid fa-stethoscope"></i> 自我健檢
          </button>
        </div>
        <div class="${UI_PREFIX}-info" id="${UI_PREFIX}-selftest-out"></div>
        <div class="${UI_PREFIX}-guide">
          <details>
            <summary>連線設定指引</summary>
            <ol>
              <li>到「AI 回覆設定」（右上角齒輪旁的 AI 按鈕）</li>
              <li>「聊天補全」分頁 → 來源選「Custom (OpenAI-compatible)」</li>
              <li>Custom Endpoint 填入：<code id="${UI_PREFIX}-endpoint">http://127.0.0.1:${settings.bridgePort}/v1</code></li>
              <li>API Key 隨便填一個字（bridge 不驗證，但欄位不能空）</li>
              <li>點「連線」，從 Model 下拉選單選模型</li>
            </ol>
          </details>
        </div>
        <div class="${UI_PREFIX}-disclaimer">
          ⚠️ 本擴充使用你自己的 Claude 訂閱額度。未獲 Anthropic 官方背書，使用風險自知。
        </div>
      </div>
    </div>
  `;
  container.append(drawer);

  const dotEl = drawer.querySelector(`#${UI_PREFIX}-dot`);
  const statusTextEl = drawer.querySelector(`#${UI_PREFIX}-status-text`);
  const infoEl = drawer.querySelector(`#${UI_PREFIX}-info`);
  const modelsEl = drawer.querySelector(`#${UI_PREFIX}-models`);
  const refreshBtn = drawer.querySelector(`#${UI_PREFIX}-refresh`);
  const thinkingEl = drawer.querySelector(`#${UI_PREFIX}-thinking`);
  const splitEl = drawer.querySelector(`#${UI_PREFIX}-split`);
  const splitNoteEl = drawer.querySelector(`#${UI_PREFIX}-split-note`);
  const cacheEl = drawer.querySelector(`#${UI_PREFIX}-cache`);

  // 自我健檢：在 SillyTavern 這個進程裡實打一發，分辨「環境問題」與「設定問題」。
  // 立案理由（26-07-29 外部使用者實案）：對方的酒館整晚回空白，自己做排除法才確認
  // 「同一份 SDK 在自己程式裡正常、透過酒館全失敗」，最後查出是登入憑證沒更新成功。
  // 那份排除本來就該由這支橋自己回答——它跑在那個進程裡，最有資格說「我在這裡叫不叫得動」。
  const selftestBtn = drawer.querySelector(`#${UI_PREFIX}-selftest`);
  const selftestOut = drawer.querySelector(`#${UI_PREFIX}-selftest-out`);
  if (selftestBtn && selftestOut) {
    selftestBtn.addEventListener('click', async () => {
      selftestBtn.disabled = true;
      selftestOut.textContent = '正在實打一發 Haiku…（會用掉一點點額度）';
      try {
        const res = await fetch(`${API_BASE}/selftest`, {
          method: 'POST', headers: getHeaders(), body: '{}',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const r = await res.json();
        selftestOut.textContent = r.ok
          ? `✅ ${r.message}${r.reply ? `（模型回：${r.reply}）` : ''}`
          : `${r.message}\n診斷：blocks=[${(r.blocks || []).join(',') || '無'}]`
            + ` subtype=${r.subtype ?? 'n/a'} is_error=${r.is_error ?? 'n/a'}`;
      } catch (e) {
        // 不靜默——這顆按鈕的存在意義就是「不要讓失敗長得像沒發生」
        selftestOut.textContent = `❌ 健檢請求本身失敗：${e.message}（plugin 可能沒載入，或 SillyTavern 需要重啟）`;
      } finally {
        selftestBtn.disabled = false;
      }
    });
  }

  if (thinkingEl) {
    thinkingEl.checked = !!settings.sdkThinking;
    thinkingEl.addEventListener('change', () => {
      settings.sdkThinking = thinkingEl.checked;
      getCtx()?.saveSettingsDebounced?.();
      syncConfig();
    });
  }

  if (splitEl) {
    splitEl.checked = !!settings.cacheSplit;
    splitEl.addEventListener('change', () => {
      settings.cacheSplit = splitEl.checked;
      getCtx()?.saveSettingsDebounced?.();
      syncConfig();
    });
  }

  // 診斷模式：走法跟拆塊那格一模一樣（存設定 → 整份推給 /config）。
  // 後端認不認得 trace 欄，由 syncConfig 拿回應驗、在這格底下叫（見 顯示診斷欄支援狀態）。
  const traceEl = drawer.querySelector(`#${UI_PREFIX}-trace`);
  if (traceEl) {
    traceEl.checked = !!settings.turnTrace;
    traceEl.addEventListener('change', () => {
      settings.turnTrace = traceEl.checked;
      getCtx()?.saveSettingsDebounced?.();
      syncConfig();
    });
  }

  // 省更多快取（系統提示走對話第一則，26-09-02 第二波 b ③）：走法跟診斷模式那格一模一樣。
  // 後端認不認得 sysInFirstTurn 欄，由 syncConfig 拿回應驗、在這格底下叫（見 顯示多斷點欄支援狀態）。
  const sysFirstEl = drawer.querySelector(`#${UI_PREFIX}-sysfirst`);
  if (sysFirstEl) {
    sysFirstEl.checked = !!settings.sysInFirstTurn;
    sysFirstEl.addEventListener('change', () => {
      settings.sysInFirstTurn = sysFirstEl.checked;
      getCtx()?.saveSettingsDebounced?.();
      syncConfig();
    });
  }

  // 快取效果數據卡。設計約束：這塊會被使用者截圖或複製出來回報，
  // 所以每個數字都要自己解釋，而且要分清楚哪些是實測（花費、token 數）、
  // 哪些是換算（幾倍）——不分的話，回報回來的數字沒有人分得出哪個能當證據。
  const 千分位 = n => (n || 0).toLocaleString('en-US');
  // 「省更多快取」開著且真的拆到時，後端會給兩個快取點座標（lastSplitS1／lastSplitS2）；沒給就整段不印（關閉／舊版橋）
  const 快取點座標 = c => (typeof c.lastSplitS2 === 'number'
    ? (typeof c.lastSplitS1 === 'number' ? `｜快取點 2 個：第 ${c.lastSplitS1}／${c.lastSplitS2} 則` : `｜快取點 1 個：第 ${c.lastSplitS2} 則`)
    : '');

  // 系統提示漂移的說法，按後端分型（26-09-02 審核 C9）：
  //   lastSystemRecurring === true  → 有東西時有時無（關鍵字觸發條目那型）
  //   lastSystemRecurring === false → 每則都是新值（時間戳那型）
  //   沒有這格（舊版橋／還沒量到）→ 通用文案
  // **舊版那句「挪去對話尾端、條目用 @D 深度插入」的建議已刪**——26-09-01 實測 @D 本身也會落進系統區，會把人帶回同一個坑。
  const 漂移文案 = (c) => {
    const 開頭 = '你的系統提示每則都在變（角色卡＋預設組出來的那一大段）。'
      + '它排在對話前面，一變整包快取就作廢——拆塊救不了這種。';
    if (c.lastSystemRecurring === true) {
      return 開頭 + '形狀是「有東西時有時無」：多半是世界書的關鍵字觸發條目（綠燈）——這則被觸發、下則沒有，'
        + '系統提示就跟著變。把常用的那幾條改成常駐、或把觸發條件收窄，變動就會少。';
    }
    if (c.lastSystemRecurring === false) {
      return 開頭 + '形狀是「每則都是新值」：多半是時間戳（每則自動帶進去的現在時間）、隨機數，'
        + '這類每次都會自動換值的巨集（{{time}} 那種雙大括號的東西）。'
        + '找出系統提示裡會跟著時間或亂數變的那一段，拿掉或固定住。';
    }
    return 開頭 + '常見來源：世界書的關鍵字觸發條目（綠燈）、擴充或腳本每則重新插進來的內容、時間戳（每則自動帶進去的現在時間）。';
  };
  const 漂移短句 = (c) => c.lastSystemRecurring === true ? '有東西時有時無（關鍵字觸發條目那型）'
    : c.lastSystemRecurring === false ? '每則都是新值（時間戳那型）'
    : '型態未分（舊版橋或樣本不足）';

  function renderCache(b) {
    if (!cacheEl) return;
    cacheEl.textContent = '';
    const c = b && b.cache;
    if (!c || !c.requests) {
      cacheEl.textContent = '💰 省錢紀錄：還沒有數據——玩一則，再按上面的「重新偵測」就會出現。';
      return;
    }

    // ── 第一行只講一件事：這一則比上一則便宜多少 ────────────────────
    // 26-08-03 改版（第一版被實際使用者回報看不懂）。第一版的主角是累計倍數，
    // 而累計倍數有兩個毛病：①它要人腦內換算「幾倍」是什麼意思 ②開頭的建立費會拖它很久，
    // 剛裝上的人玩三五則永遠只看到「回本中」——最需要被說服的時刻，畫面在幫倒忙。
    // 改成單則對照：實測時大家就是拿「$2.48 → $0.68」這樣看懂的，那就照那樣印。
    // token 數與倍數沒有刪掉，收進下面的摺疊區——它們是回報用的證據，不是給人讀的第一句。
    const 元 = n => `$${(n || 0).toFixed(2)}`;
    const 額度 = n => Number.isInteger(n) ? String(n) : n.toFixed(1);
    const 標題 = document.createElement('div');
    標題.className = `${UI_PREFIX}-cache-headline`;

    if (c.requests === 1) {
      標題.textContent = `這一則花了 ${元(c.lastCostUsd)}`;
      cacheEl.appendChild(標題);
      cacheEl.append('快取剛建立起來，第三則開始才看得出省多少。');
    } else if (c.savedPct != null && c.savedPct > 0) {
      標題.textContent = `這一則花了 ${元(c.lastCostUsd)}，上一則 ${元(c.prevCostUsd)} → 省了 ${c.savedPct}%`;
      cacheEl.appendChild(標題);
    } else {
      // 負的也照實講，並解釋為什麼——蓋掉它就變報喜不報憂，
      // 下次使用者看到怪數字會不知道那是正常的
      標題.textContent = `這一則花了 ${元(c.lastCostUsd)}，上一則 ${元(c.prevCostUsd)}`;
      cacheEl.appendChild(標題);
      cacheEl.append('這則比上一則貴，是因為快取正在建立（或剛才重建了一次）。'
        + '改設定、改世界書、換角色卡都會重建，下一則就會回到省錢狀態。');
    }

    cacheEl.append(`\n玩了 ${c.requests} 則，總共 ${元(c.costUsd)}（重開 SillyTavern 會歸零）`);

    // 5 小時額度（26-09-02 第二波）：後端從 SDK 撈到就給 lastQuota5hPct（數字）；
    // 沒撈到是 null、舊版橋沒這格是 undefined——兩種都**整行不出現**，不印「額度：不明」湊數。
    // 放第一層不收摺疊：額度見底是玩到一半突然斷掉的那種事，得在第一眼就看到。
    if (typeof c.lastQuota5hPct === 'number' && Number.isFinite(c.lastQuota5hPct)) {
      cacheEl.append(`\n這一則之後，5 小時額度用了 ${額度(c.lastQuota5hPct)}%（Claude 訂閱每 5 小時一輪的額度，用滿要等它重置）`);
    }

    // 拆塊開著卻沒生效——**放第一層，不收摺疊**（26-08-27，v1.7.0）。
    // 這次的 bug 活了很久不是因為難查，是因為它安靜：面板照樣寫「拆塊：開著」，
    // 唯一線索是摺疊區裡那行「N 則裡有 M 則拆到塊」，沒有人會去展開它。
    // 修掉根因不等於下次不會有別的原因讓它失效，所以留一個會自己叫的東西。
    if (c.splitWarning) {
      const 警 = document.createElement('div');
      警.className = `${UI_PREFIX}-cache-warn`;
      警.textContent = `⚠️ ${c.splitWarning.text}`;
      cacheEl.appendChild(警);
    }

    // 系統提示漂移**獨立判斷、不包在 splitWarning 裡**（26-09-02 審核 C9）——
    // 它跟「拆塊沒生效」是兩件事：拆塊率健康、但 systemPrompt 每發都變的時候，
    // cacheRead 只剩系統包、對話流全毀，舊寫法卻因為 splitWarning 為 null 整段不顯示。
    // 26-08-27 實案：使用者想貼診斷給我，在終端機翻兩次都找不到那行（會被輸出捲走）。
    // 診斷的成本不該由使用者付，所以搬到面板上。
    if (c.lastSystemDrift) {
      const 漂 = document.createElement('div');
      漂.className = `${UI_PREFIX}-cache-warn`;
      漂.textContent = `⚠️ ${漂移文案(c)}`;
      cacheEl.appendChild(漂);
    }

    // ── 細節收進摺疊：回報用的證據，不是給人讀的第一句 ──────────────
    const 細節 = document.createElement('details');
    const 摘要 = document.createElement('summary');
    摘要.textContent = '詳細數據（回報給我們的時候用這個）';
    // 「注入」「移位」對玩酒館的人沒解釋（26-09-02 審核 C12c）——滑鼠停在標題上就看得到
    摘要.title = '注入＝世界書／擴充插進對話裡的內容；移位＝內容沒變、只是位置往後挪';
    細節.appendChild(摘要);

    // 快取到底幫你省了還是多花了——**報數字不報賺賠，等於沒說**（26-08-29 第九種形狀）。
    // 判定由後端 cacheRoi 算（連續兩發間隔＋這發有沒有讀到），這裡只負責講人話。
    // 金額為 null（後端查不到這個模型的價目）時只印 token、不印 US$（26-09-02 審核 C10b）。
    const 快取划算嗎 = (roi) => {
      if (!roi || roi.verdict === 'unknown') return '';
      const 錢 = (n) => `US$${Number(n).toFixed(4)}`;
      const 無價 = roi.extraUsd == null || roi.savedUsd == null;
      const 多付 = 無價
        ? `新建 ${千分位(roi.writeTok)} tokens 的兩倍價差（這個模型沒有價目表，不換算成 US$）`
        : `約 ${錢(roi.extraUsd)}`;
      const 省下 = 無價
        ? `讀到 ${千分位(roi.readTok)} tokens 的折價`
        : `約 ${錢(roi.savedUsd)}`;
      if (roi.verdict === 'wasted') {
        const 間隔 = typeof roi.lastGapHours === 'number' && roi.lastGapHours >= 1
          ? `距上一則隔了 ${roi.lastGapHours.toFixed(1)} 小時，上次的快取早就過期了。`
          : '';
        return `⚠️ 這段期間的快取沒有回本：${間隔}`
          + `新建快取付的是一般輸入的兩倍價，而這 ${roi.writes} 發建立的快取一次都沒讀到，`
          + `等於多付了${多付}。`
          + `如果你通常隔幾小時才玩一則，快取在你身上是淨成本——這不是設定錯，是玩法跟快取的有效期對不上。`;
      }
      // 有讀到、但多付是省下的三倍以上（26-09-02 審核 C10a）——舊版把這種也叫「打平附近」
      if (roi.verdict === 'wasted_heavy') {
        return `⚠️ 這段期間的快取多付遠大於省下：讀到快取只省了${省下}，新建卻多付了${多付}——多付是省下的三倍以上。`
          + `多半是一直在重建、很少讀到（間隔太長，或每發都有東西在變）。`
          + `如果你通常隔幾小時才玩一則，快取在你身上接近淨成本——這不是設定錯，是玩法跟快取的有效期對不上。`;
      }
      if (roi.verdict === 'paying-off') {
        return `✅ 快取有回本：這段期間讀到快取省下${省下}，`
          + `扣掉新建多付的${多付}仍然是划算的。`;
      }
      return `快取目前打平附近：省下${省下}、新建多付${多付}。`;
    };

    const 倍 = c.savedRatio;
    const 內文 = document.createElement('div');
    內文.className = `${UI_PREFIX}-cache-note`;
    內文.textContent = [
      `拆塊：${b.split ? '開著' : '關著'}${b.splitLocked ? '（被啟動參數鎖住）' : ''}`
        + `｜${c.requests} 則裡有 ${c.splitApplied} 則真的有拆`
        + 快取點座標(c),
      `輸入 token（計費用的字數單位）：讀到快取 ${千分位(c.cacheRead)}／新建快取 ${千分位(c.cacheWrite)}／未快取 ${千分位(c.input)}`,
      // 26-09-02 組成表（CX-260902-01）：這一發送了什麼——系統區／對話／注入各多少、跟上一發比幾則變幾則移位。
      // 字串由後端組（cacheSummary.lastCompLine），這裡只印，不另算；前面補一句白話（26-09-02 審核 C12c）。
      c.lastCompLine
        ? `這一則送了什麼：${c.lastCompLine}\n（注入＝世界書／擴充插進對話裡的內容；移位＝內容沒變、只是位置往後挪）`
        : '',
      // 那筆「新建」的錢有沒有收回來（26-08-29）。只報數字的話，「新建快取 50,000」
      // 看起來像做了好事——實際上新建是一般輸入的兩倍價，隔幾小時才玩一則的人一次都收不回。
      快取划算嗎(c.cacheRoi),
      倍 ? `累計換算：沒有快取的話要付 ${倍} 倍（含開頭的建立費，所以剛開始會小於 1）` : '',
      '註：花費與 token 數是實測值；「幾倍」是換算——讀快取算 1/10 價、新建快取算 2 倍價、'
        + '未快取算 1 倍，只算輸入側（輸出不受快取影響）。',
    ].filter(Boolean).join('\n');
    細節.appendChild(內文);
    cacheEl.appendChild(細節);

    const btn = document.createElement('button');
    btn.className = 'menu_button';
    btn.type = 'button';
    btn.textContent = '📋 複製這段數據';
    // 複製出去的版本，第一句就是結論——讀它的人手上沒有畫面、沒有上下文，只有這段文字。
    // 順序跟面板一致：先單則對照（人看得懂的），再細節（我們對帳用的）。
    const 純文字 = [
      `Claude Bridge v${LOCAL_VERSION} 快取數據`,
      c.requests === 1
        ? `這一則 $${(c.lastCostUsd || 0).toFixed(4)}（快取剛建立，第三則起才看得出省多少）`
        : c.savedPct != null && c.savedPct > 0
          ? `這一則 $${(c.lastCostUsd || 0).toFixed(4)}，上一則 $${(c.prevCostUsd || 0).toFixed(4)} → 省了 ${c.savedPct}%`
          : `這一則 $${(c.lastCostUsd || 0).toFixed(4)}，上一則 $${(c.prevCostUsd || 0).toFixed(4)}（快取正在建立或剛重建）`,
      `玩了 ${c.requests} 則，總共 $${(c.costUsd || 0).toFixed(4)}`,
      typeof c.lastQuota5hPct === 'number' && Number.isFinite(c.lastQuota5hPct)
        ? `這一則之後，5 小時額度用了 ${額度(c.lastQuota5hPct)}%` : '',
      `拆塊：${b.split ? '開' : '關'}${b.splitLocked ? '（被啟動參數鎖住）' : ''}`
        + `｜${c.requests} 則裡有 ${c.splitApplied} 則真的有拆`
        + 快取點座標(c),
      `讀快取 ${c.cacheRead}／新建快取 ${c.cacheWrite}／未快取 ${c.input} tokens`,
      倍 ? `累計換算 ${倍} 倍（含開頭建立費，剛開始會小於 1）` : '累計換算：資料不足',
      // 診斷四行（26-09-02 審核 C10c）：按鈕說「回報給我們的時候用這個」，最需要回報的診斷以前全不在剪貼簿裡。
      c.splitWarning ? `⚠️ 拆塊警告：${c.splitWarning.text}` : '',
      c.lastSystemDrift ? `⚠️ 系統提示漂移：${漂移短句(c)}` : '',
      c.cacheRoi && c.cacheRoi.verdict !== 'unknown'
        ? `快取回本判定：${c.cacheRoi.verdict}`
          + (c.cacheRoi.extraUsd == null || c.cacheRoi.savedUsd == null
            ? `（新建 ${c.cacheRoi.writeTok} tok／讀到 ${c.cacheRoi.readTok} tok；此模型沒有價目，不換算 US$）`
            : `（省下 US$${Number(c.cacheRoi.savedUsd).toFixed(4)}、新建多付 US$${Number(c.cacheRoi.extraUsd).toFixed(4)}）`)
        : '',
      c.lastCompLine ? `這一則送了什麼：${c.lastCompLine}` : '',
    ].filter(Boolean).join('\n');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(純文字);
        btn.textContent = '✅ 複製好了';
        setTimeout(() => { btn.textContent = '📋 複製這段數據'; }, 2500);
      } catch (err) {
        // 不靜默降級：手機從區網 IP 連酒館＝非安全來源，瀏覽器會直接擋剪貼簿。
        // 擋了就把文字攤開讓他自己選取——按了沒反應是最糟的結果。
        console.warn(`[${PLUGIN_ID}] 剪貼簿被擋，改用手動選取：`, err);
        const ta = document.createElement('textarea');
        ta.value = 純文字;
        ta.rows = 6;
        ta.style.width = '100%';
        cacheEl.appendChild(ta);
        ta.select();
        btn.textContent = '瀏覽器擋了複製，請手動選取上面那段';
      }
    });
    cacheEl.appendChild(btn);
  }

  async function refresh() {
    statusTextEl.textContent = '偵測中…';
    dotEl.className = `${UI_PREFIX}-dot ${UI_PREFIX}-pending`;
    infoEl.textContent = '';
    modelsEl.textContent = '';
    if (cacheEl) cacheEl.textContent = '';

    const result = await probePlugin();

    if (!result) {
      dotEl.className = `${UI_PREFIX}-dot ${UI_PREFIX}-off`;
      statusTextEl.textContent = 'Server plugin 未啟用';
      infoEl.textContent =
        '請確認：\n' +
        '1. server/ 資料夾已複製到 SillyTavern 的 plugins/ 目錄\n' +
        '2. 已在 plugin 目錄執行 npm install\n' +
        '3. config.yaml 已設 enableServerPlugins: true\n' +
        '4. 已重啟 SillyTavern';
      return;
    }

    // 前端更新了、server plugin 沒換——**這是最常見的更新失敗，而且完全無聲**
    // （26-08-27 實案：使用者更新完跑了一則，才發現診斷根本沒出來，白花額度）。
    // 面板換的是這個檔，橋的本體要跑 install.ps1 才會換，兩邊版本一比就抓得到。
    if (result.version && result.version !== LOCAL_VERSION) {
      const 版 = document.createElement('div');
      版.className = `${UI_PREFIX}-cache-warn`;
      版.textContent = `⚠️ 前端是 ${LOCAL_VERSION}，但橋的本體還是 ${result.version}——`
        + '更新只做了一半。請重跑 install.ps1，然後重開 SillyTavern。'
        + '（面板更新只換前端；橋的本體在 plugins 資料夾，要跑腳本才會換，而它是啟動時載入的。）';
      infoEl.appendChild(版);
    }

    if (!result.sdkAvailable) {
      dotEl.className = `${UI_PREFIX}-dot ${UI_PREFIX}-warn`;
      statusTextEl.textContent = 'SDK 未載入';
      infoEl.textContent = '請在 plugins/tavern-claude-bridge/ 執行 npm install，然後重啟 SillyTavern。';
      return;
    }

    if (!result.bridge || !result.bridge.running) {
      dotEl.className = `${UI_PREFIX}-dot ${UI_PREFIX}-warn`;
      statusTextEl.textContent = 'Bridge 未啟動';
      infoEl.textContent = `Port ${settings.bridgePort} 可能被佔用。查看 SillyTavern console 了解詳情。`;
      return;
    }

    dotEl.className = `${UI_PREFIX}-dot ${UI_PREFIX}-on`;
    const b = result.bridge;
    statusTextEl.textContent = `運行中 — port ${b.port}`;

    // 拆塊被啟動參數鎖住（TCB_SPLIT=0）時，把那格關成不可點並說明原因。
    // 沒有這段的話，使用者會看到勾選框是開的、以為拆塊在跑，其實被壓著——
    // 又是一次「失敗長得跟成功一樣」，而且這次是我們自己畫的畫面在騙人。
    if (splitEl && b.splitLocked) {
      splitEl.checked = false;
      splitEl.disabled = true;
      if (splitNoteEl) {
        splitNoteEl.textContent =
          '這次的 SillyTavern 是帶著 TCB_SPLIT=0 這個啟動參數開的（出問題時用的逃生門），拆塊被鎖住、面板改不動。'
          + '要放回來就用平常的方式重開 SillyTavern。';
      }
    }

    if (b.busy) {
      infoEl.textContent = '正在處理請求…';
    } else {
      infoEl.textContent = `已處理 ${b.requestCount} 個請求`;
    }

    if (b.models && b.models.length) {
      modelsEl.textContent = `可用模型：${b.models.join(' / ')}`;
    }

    renderCache(b);
  }

  refreshBtn.addEventListener('click', refresh);
  refresh();

  const updateEl = drawer.querySelector(`#${UI_PREFIX}-update`);
  checkForUpdate().then(update => {
    if (!update) return;
    updateEl.append(`🔔 有新版 v${update.version} — `);
    const link = document.createElement('a');
    link.href = update.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '查看更新';
    updateEl.appendChild(link);
    updateEl.append('｜重跑 install.ps1 更新');
  });
}

// Auto＝照酒館原生語義「不傳送推理耗費等級」，交給模型自己拿捏（思考本身不受影響，仍是開的）
const EFFORT_MAP = { auto: 'auto', min: 'low', low: 'low', medium: 'medium', high: 'high', max: 'max' };

// 一次送齊整份設定（effort＋原生思考開關）。26-07-27 從 syncEffort 擴寫：
// 後端的設定是記憶體變數、重啟即回預設，所以每次前端有動作就把整份現況推過去，
// 不做「只推有變的那個」——省不了多少，卻會讓兩邊在重啟後靜靜地不一致。
async function syncConfig() {
  const el = document.getElementById('openai_reasoning_effort');
  const effort = el ? (EFFORT_MAP[el.value] || 'auto') : 'auto';
  const settings = loadSettings();
  try {
    // 走 ST 的 plugin router（同源）——直連 127.0.0.1:5199 會被瀏覽器 CORS 擋掉
    const res = await fetch(`${API_BASE}/config`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        effort,
        thinking: !!settings.sdkThinking,
        split: !!settings.cacheSplit,
        trace: !!settings.turnTrace,
        sysInFirstTurn: !!settings.sysInFirstTurn,
      }),
    });
    if (!res.ok) { console.warn(`[${PLUGIN_ID}] 設定同步失敗：HTTP ${res.status}`); return null; }
    // 後端回的是整份現況（currentConfig）。拿它驗診斷欄有沒有被認得——舊版橋會把 trace 靜靜忽略。
    const cfg = await res.json().catch(() => null);
    顯示診斷欄支援狀態(cfg);
    顯示多斷點欄支援狀態(cfg);
    return cfg;
  } catch (err) {
    console.warn(`[${PLUGIN_ID}] 設定同步失敗：`, err);
    return null;
  }
}

// 診斷模式那格要靠後端 /config 回 trace 欄才算真的開了（26-09-02 第二波）。
// 前端更新了、橋的本體沒換時，勾選框打勾、檔案卻沒在寫——又是一次「失敗長得跟成功一樣」，
// 而且這次連錯誤訊息都沒有。所以每次同步都拿回應驗：使用者想開、後端卻沒回這欄，就在那格底下叫；
// 措辭跟上面「前端／橋版本不同」的提示同款（同一個病：更新只做了一半）。
function 顯示診斷欄支援狀態(cfg) {
  const warn = document.getElementById(`${UI_PREFIX}-trace-warn`);
  const box = document.getElementById(`${UI_PREFIX}-trace`);
  if (!warn || !box) return;
  const 想開 = !!box.checked;
  const 後端認得 = !!cfg && typeof cfg === 'object' && typeof cfg.trace === 'boolean';
  if (想開 && !後端認得) {
    warn.textContent = '⚠️ 橋的本體版本太舊，還不認得診斷模式——這個勾現在沒有作用。'
      + '請重跑 install.ps1、重開 SillyTavern，再回來勾一次。';
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
}

// 省更多快取那格同款（26-09-02 第二波 b ③）：使用者想開、後端 /config 卻沒回 sysInFirstTurn 欄＝橋的本體還是舊版，
// 勾了沒作用——在那格底下叫，措辭跟診斷模式那格一樣（同一個病：更新只做了一半）。
function 顯示多斷點欄支援狀態(cfg) {
  const warn = document.getElementById(`${UI_PREFIX}-sysfirst-warn`);
  const box = document.getElementById(`${UI_PREFIX}-sysfirst`);
  if (!warn || !box) return;
  const 想開 = !!box.checked;
  const 後端認得 = !!cfg && typeof cfg === 'object' && typeof cfg.sysInFirstTurn === 'boolean';
  if (想開 && !後端認得) {
    warn.textContent = '⚠️ 橋的本體版本太舊，還不認得「省更多快取」——這個勾現在沒有作用。'
      + '請重跑 install.ps1、重開 SillyTavern，再回來勾一次。';
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
}

export async function init() {
  buildPanel();
  syncConfig();

  // 使用者手動切下拉
  const el = document.getElementById('openai_reasoning_effort');
  if (el) el.addEventListener('change', syncConfig);

  // 換預設檔時酒館是用程式改值，不會觸發 change——另外掛事件補上
  const ctx = getCtx();
  const presetChanged = ctx?.eventTypes?.OAI_PRESET_CHANGED_AFTER;
  if (ctx?.eventSource && presetChanged) {
    ctx.eventSource.on(presetChanged, syncConfig);
  }

  console.log(`[${PLUGIN_ID}] Frontend initialized.`);
}
