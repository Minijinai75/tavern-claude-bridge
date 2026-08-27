const PLUGIN_ID = 'tavern-claude-bridge';
const API_BASE = `/api/plugins/${PLUGIN_ID}`;
const UI_PREFIX = 'tcb';
const SETTINGS_KEY = 'tavern_claude_bridge';
const LOCAL_VERSION = '1.7.3';
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
          <small id="${UI_PREFIX}-split-note">把對話裡「已經不會再變」的那一大段獨立標記起來快取，下一則就不用整包重算。實測一則從 $2.35 降到 $0.71。改設定、改世界書、切換角色卡都會讓它重建一次，那是正常的。覺得回覆怪怪的就先關掉，橋會退回原本的送法。</small>
        </div>
        <div class="${UI_PREFIX}-option">
          <label class="checkbox_label">
            <input type="checkbox" id="${UI_PREFIX}-thinking">
            <span>使用 Claude 原生思考摘要</span>
          </label>
          <small>預設關閉。你的預設如果自己會要求角色輸出思考（例如正文開頭的 <code>&lt;thinking&gt;</code> 區塊），請保持關閉——兩者會搶同一條通道，開著會讓思考變成中英混雜、偶爾整輪空白回覆。用素卡、想看 Claude 自己的推理摘要再打開。</small>
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

  // 快取效果數據卡。設計約束：這塊會被使用者截圖或複製出來回報，
  // 所以每個數字都要自己解釋，而且要分清楚哪些是實測（花費、token 數）、
  // 哪些是換算（幾倍）——不分的話，回報回來的數字沒有人分得出哪個能當證據。
  const 千分位 = n => (n || 0).toLocaleString('en-US');

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

    // 拆塊開著卻沒生效——**放第一層，不收摺疊**（26-08-27，v1.7.0）。
    // 這次的 bug 活了很久不是因為難查，是因為它安靜：面板照樣寫「拆塊：開著」，
    // 唯一線索是摺疊區裡那行「N 則裡有 M 則拆到塊」，沒有人會去展開它。
    // 修掉根因不等於下次不會有別的原因讓它失效，所以留一個會自己叫的東西。
    if (c.splitWarning) {
      const 警 = document.createElement('div');
      警.className = `${UI_PREFIX}-cache-warn`;
      警.textContent = `⚠️ ${c.splitWarning.text}`;
      cacheEl.appendChild(警);

      // 系統提示漂移單獨再講一次——它跟「拆塊沒生效」是兩件事，而且它是拆塊救不了的那種。
      // 26-08-27 實案：使用者想貼診斷給我，在終端機翻兩次都找不到那行（會被輸出捲走）。
      // 診斷的成本不該由使用者付，所以搬到面板上。
      if (c.lastSystemDrift) {
        const 漂 = document.createElement('div');
        漂.className = `${UI_PREFIX}-cache-warn`;
        漂.textContent = '⚠️ 你的系統提示每則都在變（角色卡＋預設組出來的那一大段）。'
          + '它排在對話前面，一變整包快取就作廢——**拆塊救不了這種**。'
          + '常見來源：世界書的關鍵字觸發條目（綠燈）、每則重算的注入、時間戳。'
          + '修法是把那些東西挪到對話尾端的會動區（世界書條目改成 @D 深度插入）。';
        cacheEl.appendChild(漂);
      }
    }

    // ── 細節收進摺疊：回報用的證據，不是給人讀的第一句 ──────────────
    const 細節 = document.createElement('details');
    const 摘要 = document.createElement('summary');
    摘要.textContent = '詳細數據（回報給我們的時候用這個）';
    細節.appendChild(摘要);

    const 倍 = c.savedRatio;
    const 內文 = document.createElement('div');
    內文.className = `${UI_PREFIX}-cache-note`;
    內文.textContent = [
      `拆塊：${b.split ? '開著' : '關著'}${b.splitLocked ? '（被啟動參數鎖住）' : ''}`
        + `｜${c.requests} 則裡有 ${c.splitApplied} 則拆到塊`,
      `輸入 token：讀到快取 ${千分位(c.cacheRead)}／新建快取 ${千分位(c.cacheWrite)}／未快取 ${千分位(c.input)}`,
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
      `拆塊：${b.split ? '開' : '關'}${b.splitLocked ? '（被啟動參數鎖住）' : ''}`
        + `｜${c.requests} 則裡有 ${c.splitApplied} 則拆到塊`,
      `讀快取 ${c.cacheRead}／新建快取 ${c.cacheWrite}／未快取 ${c.input} tokens`,
      倍 ? `累計換算 ${倍} 倍（含開頭建立費，剛開始會小於 1）` : '累計換算：資料不足',
    ].join('\n');
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
          '這扇 SillyTavern 是用 TCB_SPLIT=0 啟動的（逃生門），拆塊被鎖住、面板改不動。'
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
      body: JSON.stringify({ effort, thinking: !!settings.sdkThinking, split: !!settings.cacheSplit }),
    });
    if (!res.ok) console.warn(`[${PLUGIN_ID}] 設定同步失敗：HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[${PLUGIN_ID}] 設定同步失敗：`, err);
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
