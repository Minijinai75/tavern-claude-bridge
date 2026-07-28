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
| `claude-opus-5[1m]` | Opus 5（1M context） |
| `claude-opus-5` | Opus 5 |
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
- **使用 Claude 原生思考摘要**（v1.2.0 起，**預設關閉**）：詳見下面「兩種思考」
- **連線設定指引**：忘記設定步驟可以展開看

### 兩種思考，只能挑一種（v1.2.0 重要）

「思考」在酒館裡只有一條顯示通道，但有兩種東西會搶它：

1. **你的預設自己要求角色輸出的思考** —— 例如要求正文開頭寫一段 `<thinking>…</thinking>`，酒館會自動把它解析出來、摺疊顯示
2. **Claude 原生的思考摘要** —— 也就是面板上這個開關

**兩個同時開，它們會搶同一條通道**：有時你的思考鏈搶到、有時被模型的原生推理蓋掉（而原生推理是英文的），結果就是思考忽中忽英、格式不穩，而且正文裡的 `<thinking>` 常常只剩一個空標籤。更麻煩的是模型有機會把一整輪都花在原生思考上、正文一個字都沒生，酒館就收到**空白回覆**。

所以規則很簡單：

- **你的預設會自己產思考**（大多數 RP 預設都會）→ **保持關閉**，你照樣看得到思考，而且是你自己設計的那種
- **用素卡、沒有思考鏈設計、想看 Claude 自己怎麼想** → 打開它

v1.2.0 之前這個是寫死開啟的、沒得選，上面那些症狀因此無解。

---

## 已知限制

### Claude Code 通道的限制（走同通道的反代也一樣）

- **溫度滑桿沒有效果**：Claude Code 通道不支援 temperature / top_p，酒館裡的溫度設定不會生效
- **不支援預填回覆**（prefill）：無法強制回覆以特定文字開頭
- **token 統計不準**：Claude Code 在訂閱模式下不回報準確的 token 數字，酒館裡顯示的數字是前端自己估算的，僅供參考

### Bridge 本身的限制

- **一次只跑一則，新的會擠掉舊的**：你按「重新生成」時，前一則會自動讓位、新的立刻開始（v1.1.1 起。在那之前是回 429 擋住你）。被讓位的那則會在背景收個尾才真的停，額度上會多算一點點
- **回應速度**：平均約 10 秒，比直連 API 慢（因為每次都要啟動 Claude Code 子程序）。**建議把酒館的「即時串流」打開**——關掉的話要等整段生成完才會一次吐出來，長對話很容易撞到酒館的等待上限
- **原生思考內容為摘要版**：面板上的「使用 Claude 原生思考摘要」打開後，透過 SDK 取得的是摘要版而非完整版，且需要在酒館的 AI 回覆設定裡開啟「Include Reasoning」才會顯示。**預設是關的**，理由見上面「兩種思考，只能挑一種」
- **圖片只帶最後一則**：開啟酒館的「傳送內嵌媒體」後可以傳圖給模型看（v1.1.2 起）。為了控制 token 成本，只有**最新那則訊息**裡的圖會送出去，歷史訊息裡的舊圖不會重複帶
- **只吃內嵌圖片，不抓外部網址**：貼進酒館的圖（會轉成 data URL）沒問題；純網址的圖片會被略過——bridge 不會替你去下載別人伺服器上的東西
- **單次請求上限 4MB**：圖片太大或對話太長可能超過，超過會直接回報錯誤（不會靜默失敗）

### 推理耗費（Reasoning Effort）

酒館「AI 回覆設定」裡的**推理耗費**下拉會即時同步給 bridge：

| 選項 | 送給模型 | 思考 |
|---|---|---|
| Auto | 不指定，模型自己拿捏 | 開著 |
| Minimum / Low | low | 開著 |
| Medium | medium | 開著 |
| High | high | 開著 |
| Maximum | max | 開著 |

**「Auto」是不指定思考量，不是關閉思考**——思維鏈照常運作。同一列的 **Verbosity** 對本擴充無效（那是酒館給 OpenAI 模型用的）。

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

### 模型不照預設的格式輸出／思考中英混雜／偶爾整輪空白

先照順序檢查這三個，前兩個是外部使用者實際踩過的：

1. **面板的「使用 Claude 原生思考摘要」是不是開著？** 你的預設如果自己會產思考鏈，這個開著會讓兩者搶同一條通道——關掉（v1.2.0 起預設就是關的）。詳見上面「兩種思考，只能挑一種」
2. **酒館的「提示詞後處理」（Prompt Post-Processing）是不是選了「半嚴格」或「嚴格」？** 那兩個模式會在送出前把第一則以外的系統訊息強制改成使用者訊息，你的角色卡會被拆散。接 Claude 的人很容易選它（因為官方 API 要求角色嚴格交替），**但本擴充不需要，請設成「無」**
3. **升到 v1.2.0**。在那之前 bridge 會把所有系統訊息不分位置搬到最前面，導致世界書的深度注入、作者註記、放在對話之後的格式指令全部失去位置效力——**用了很多世界書深度注入的重度使用者受影響最深**

還可以直接看證據：啟動酒館的那個終端機視窗，每次請求會印一行含 `sys=3421字/2則 msgs=14`（v1.1.3 起）。`sys=0字/0則` 就代表你的角色卡根本沒送到模型那裡。

### 每一則都是空白（不是偶爾，是全部）

**先按面板上的「自我健檢」**（v1.3.0 起）。它會在 SillyTavern 這個進程裡實打一發最便宜的模型，直接告訴你「橋在這裡叫不叫得動 Claude」——這一步能立刻分開兩種完全不同的問題：

- **健檢通了** → 環境沒問題，往設定方向查（上一節那三點）
- **健檢不通** → 環境問題，不要再調設定了，往下看

最常見的環境問題是**登入憑證過期或沒更新成功**。它的樣子很好認，終端機那行會是：

```
blocks=[無] subtype=success is_error=true usage=n/a cost=$0.0000
```

`blocks=[無]` 加上沒有 usage、沒有扣費，代表這一則**根本沒真的生成就結束了**——不是模型寫一半斷掉，是它壓根沒開始。這種情況**按重新生成一百次也沒用**。解法：

1. 到終端機執行 `claude login` 重新登入
2. **重啟 SillyTavern**（憑證是啟動時載入的，不重啟不會生效）
3. 再按一次「自我健檢」確認

> 這個病例來自一位使用者 26-07-29 的回報。她自己做了很漂亮的排除——CLI 直接叫模型正常、自己寫程式呼叫同一份 SDK 正常、參數逐一比對正常，**只有透過酒館全部失敗，連最便宜的模型都失敗**——才確認問題在進程環境而不是設定。「自我健檢」這顆按鈕就是為了讓下一個人不必再花一晚做這件事。

---

## 授權

AGPL-3.0
