# Claude Bridge — SillyTavern 擴充

用你自己的 Claude 訂閱額度，在 SillyTavern 裡跟角色聊天。

---

## ⚠️ 使用前請讀

1. **每個使用者用自己的 Claude 訂閱與額度**——本擴充不含任何帳號、金鑰、代理。
2. 走官方 Claude Agent SDK＋本機 Claude Code CLI 登入，不逆向、不偽裝 client。
3. **本擴充為第三方相容方案，未獲 Anthropic 官方背書。** 這條路比逆向 proxy 乾淨，但「訂閱額度接第三方介面」不在 Anthropic 官方文件的明確白名單裡——風險比逆向低得多，但不是零。你自己衡量。

---

## 這個擴充怎麼運作（白話版）

Claude Code 是 Anthropic 的官方命令列工具，你用 Claude 訂閱帳號登入它。這個擴充做的事情就是：讓酒館把對話丟給你電腦上已經登入好的 Claude Code，由它代替你去問 Claude，再把回覆傳回酒館。

所以流程是：**酒館 → 你電腦上的 Claude Code → Claude**。全程本機，不經過任何第三方伺服器。

---

## 你需要先準備

- **SillyTavern 1.18.0**（或更新版本）
- **Claude Code**（Anthropic 官方命令列工具，裝法看下面）
- **有效的 Claude 訂閱**（Pro / Max / Team 都可以）

### 安裝 Claude Code

如果你還沒裝過 Claude Code：

1. 安裝 Node.js（到 [nodejs.org](https://nodejs.org/) 下載 LTS 版本，一路下一步即可）
2. 打開終端機（Windows: PowerShell；Mac: Terminal）
3. 執行：`npm install -g @anthropic-ai/claude-code`
4. 執行：`claude login`
5. 照畫面指示完成訂閱登入

完成後執行 `claude --version` 確認有版本號出來就行。

---

## 安裝步驟

這個擴充有兩個部分，要分開裝：**前端面板**（酒館裡看到的 UI）和 **server plugin**（真正連接 Claude 的後台程式）。

### 第一步：安裝前端擴充

1. 打開 SillyTavern
2. 點左下角的「擴充」圖示（積木圖案）
3. 在「Install Extension」區塊，貼上安裝網址：

   ```
   https://github.com/Minijinai75/tavern-claude-bridge
   ```

4. 點「Install」

裝好後，擴充面板裡會出現「Claude Bridge」。

### 第二步：安裝 Server Plugin

前端擴充只是控制面板，真正連接 Claude 的 server plugin 還要另外裝。有兩種方式，推薦用一鍵安裝。

#### 方式 A：一鍵安裝（推薦）

> 腳本開源，跑之前歡迎打開看它做什麼。全程在你電腦上跑，不連網下載任何東西。

1. 打開 PowerShell
2. 用 `cd` 進到你的 SillyTavern 目錄（有 `server.js` 的那個資料夾）
3. 執行：
   ```
   powershell -ExecutionPolicy Bypass -File "data\default-user\extensions\tavern-claude-bridge\install.ps1"
   ```
4. 照畫面指示操作就好

裝好之後，跑 `install.ps1 -Verify` 可以快速檢查 bridge 是否正常運作。

搞定的話直接跳到第三步。

#### 方式 B：手動安裝

> 💡 裝完第一步之後，`plugins\` 資料夾裡**還不會有**這個擴充——這是正常的，ST 不允許擴充自己往 plugins 塞東西。這一步就是要你親手把檔案搬過去。

先找到你的 SillyTavern 安裝目錄——就是裡面有 `server.js` 那個資料夾，下面簡稱「ST 目錄」。

1. 在 ST 目錄裡，打開剛剛裝好的擴充資料夾：`data\default-user\extensions\tavern-claude-bridge\`
2. 裡面有個 `server` 資料夾，打開它，會看到一個叫 `tavern-claude-bridge` 的子資料夾
3. 把這個 `server\tavern-claude-bridge\` 子資料夾，**整個複製**到 ST 目錄的 `plugins\` 裡面

   > ⚠️ **最容易搬錯的一步**：有兩層資料夾都叫 `tavern-claude-bridge`（外層是前端、內層才是 server plugin），要搬的是**內層**——搬對的話，打開 `plugins\tavern-claude-bridge\` 會**直接看到 `index.mjs` 和 `package.json` 兩個檔案**；如果看到的是 `manifest.json`、`style.css` 這些，就是搬到外層了，砍掉重搬內層。搬錯層的症狀：下一步 `npm install` 只會顯示「audited 1 package」（正常應該裝一百多個套件）。

   複製完的結果應該長這樣：
   ```
   SillyTavern\
   ├── plugins\
   │   └── tavern-claude-bridge\    ← 你剛複製過來的
   │       ├── index.mjs
   │       └── package.json
   ├── server.js
   └── ...
   ```

4. 在 `plugins\tavern-claude-bridge\` 資料夾上面**按右鍵 →「在終端機中開啟」**（Windows 11）或「Open in Terminal」。如果你的系統沒有這個選項，打開 PowerShell，手動輸入：
   ```
   cd "你的ST目錄路徑\plugins\tavern-claude-bridge"
   ```
5. 執行：`npm install`
6. 用記事本打開 ST 目錄裡的 `config.yaml`，搜尋 `enableServerPlugins`，把後面的 `false` 改成 `true`：

   改之前：`enableServerPlugins: false`
   改之後：`enableServerPlugins: true`

7. **關掉 SillyTavern，重新啟動**

重啟後，看一下啟動酒館時跑出來的那個黑色文字視窗（就是一直在刷訊息的那個），如果看到這三行就代表成功：

```
[tavern-claude-bridge] SDK loaded.
[tavern-claude-bridge] Bridge running at http://127.0.0.1:5199
[tavern-claude-bridge] Plugin initialized.
```

### 第三步：在酒館裡連接

1. 到右上角的 AI 回覆設定（齒輪旁邊的 AI 圖示）
2. 切到「聊天補全」分頁
3. 來源選「Custom (OpenAI-compatible)」——這裡選 OpenAI 不是接 OpenAI，是因為 bridge 用 OpenAI 相容的格式溝通，所有「Custom」類都走這條
4. Custom Endpoint 填：`http://127.0.0.1:5199/v1`
5. API Key 隨便填一個字（bridge 不驗 key，但欄位不能空白）
6. 點「連線」
7. 從 Model 下拉選單選模型

可用的模型：

| 模型 ID | 對應 Claude 版本 |
|---|---|
| `claude-opus-4-6[1m]` | Opus 4.6（1M context） |
| `claude-opus-4-6` | Opus 4.6 |
| `claude-opus-4-8[1m]` | Opus 4.8（1M context） |
| `claude-fable-5` | Fable 5 |
| `claude-sonnet-5` | Sonnet 5 |
| `claude-sonnet-4-6` | Sonnet 4.6 |
| `claude-haiku-4-5` | Haiku 4.5 |

---

## 擴充面板

裝好後在「擴充」面板裡會有「Claude Bridge」的區塊，可以看到：

- **狀態燈**：綠色＝正常運作、橘色＝有問題、灰色跳動＝偵測中
- **已處理請求數**：bridge 啟動後處理了幾個請求
- **可用模型列表**
- **連線設定指引**：忘記設定步驟可以展開看

---

## 已知限制

- **溫度滑桿沒有效果**：Claude Code 不支援調整 temperature / top_p，所以酒館裡的溫度設定不會生效
- **不支援預填回覆**（prefill）：無法強制回覆以特定文字開頭
- **一次只能處理一個請求**：同時第二個請求會被擋住，等前一個完成就好
- **token 統計不準**：Claude Code 在訂閱模式下不回報 token 數字，酒館裡顯示的統計會是 0
- **回應速度**：平均約 10 秒，比直連 API 慢（因為每次都要啟動 Claude Code 子程序）
- **思考內容為摘要版**：bridge 支援顯示 Claude 的思考過程（在酒館裡顯示為「Reasoning」），但透過 SDK 取得的是摘要版而非完整版。需要在酒館的 AI 回覆設定裡開啟「Include Reasoning」才會顯示

---

## 疑難排解

### 面板顯示「Server plugin 未啟用」

- 確認 `plugins\tavern-claude-bridge\` 資料夾存在，裡面有 `index.mjs`
- 確認在那個資料夾跑過 `npm install`（裡面應該要有 `node_modules` 資料夾）
- 確認 `config.yaml` 裡 `enableServerPlugins: true`
- 重啟 SillyTavern

### 面板顯示「SDK 未載入」

- 到 `plugins\tavern-claude-bridge\` 資料夾跑 `npm install`
- 重啟 SillyTavern

### 面板顯示「Bridge 未啟動」

- Port 5199 可能被其他程式佔用。最簡單的辦法：重開機後再啟動酒館
- 看啟動酒館時的黑色文字視窗有沒有錯誤訊息

### 連線後按「生成」沒反應

- 確認 Custom Endpoint 是 `http://127.0.0.1:5199/v1`（結尾有 `/v1`）
- 確認 API Key 欄位不是空白（隨便填什麼都行）
- 確認 Claude Code 已登入（終端機跑 `claude --version` 確認有版本號）

### 回覆出現錯誤訊息

| 錯誤 | 意思 | 怎麼辦 |
|---|---|---|
| Claude Code 尚未登入 | 沒有有效的登入狀態 | 終端機跑 `claude login` 重新登入 |
| 額度已達上限 | 訂閱額度用完了 | 到 claude.ai Settings → Usage 查看額度 |
| Claude 伺服器忙碌中 | Anthropic 那邊過載 | 等幾分鐘再試 |
| 找不到 Claude Code CLI | Claude Code 沒裝或 PATH 沒設好 | 重裝：`npm install -g @anthropic-ai/claude-code` |

---

## 授權

AGPL-3.0
