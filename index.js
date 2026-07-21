const PLUGIN_ID = 'tavern-claude-bridge';
const API_BASE = `/api/plugins/${PLUGIN_ID}`;
const UI_PREFIX = 'tcb';
const SETTINGS_KEY = 'tavern_claude_bridge';

const DEFAULT_SETTINGS = {
  bridgePort: 5199,
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
        <div class="${UI_PREFIX}-models" id="${UI_PREFIX}-models"></div>
        <div class="${UI_PREFIX}-actions">
          <button id="${UI_PREFIX}-refresh" class="menu_button" type="button">
            <i class="fa-solid fa-rotate"></i> 重新偵測
          </button>
        </div>
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

  async function refresh() {
    statusTextEl.textContent = '偵測中…';
    dotEl.className = `${UI_PREFIX}-dot ${UI_PREFIX}-pending`;
    infoEl.textContent = '';
    modelsEl.textContent = '';

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

    if (b.busy) {
      infoEl.textContent = '正在處理請求…';
    } else {
      infoEl.textContent = `已處理 ${b.requestCount} 個請求`;
    }

    if (b.models && b.models.length) {
      modelsEl.textContent = `可用模型：${b.models.join(' / ')}`;
    }
  }

  refreshBtn.addEventListener('click', refresh);
  refresh();
}

export async function init() {
  buildPanel();
  console.log(`[${PLUGIN_ID}] Frontend initialized.`);
}
