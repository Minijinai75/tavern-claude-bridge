# SDK 提示內容取證

26-11-12 23:25｜狀態：第三輪已完成模型分流，27 項測試通過；Fable 5.2 與 Opus 5.5 訂閱真打各一發皆回「好」，尚未發版。下一步：交回整合審閱。0.3.322 的額外環境段與身分句仍存在，只有選 5.2 才使用它。

`sdk-wire-probe.mjs` 走副本的 `handleChatCompletions`、實際 SDK 與內建 CLI，將 `ANTHROPIC_BASE_URL` 指向只監聽 `127.0.0.1` 的假上游。上游存完整 HTTP body，再固定回「好」。橋與上游都用作業系統分配的空閒埠，不呼叫 `init()` 或使用 5199。

探針在載入橋和 SDK 前清空繼承環境，只保留啟動所需變數；以獨立 `CLAUDE_CONFIG_DIR` 提供假的訂閱帳戶、email、組織 UUID 與不可用的 OAuth token，不讀真 API key。停用非必要流量，外部 HTTP 代理指向本機關閉埠；本機請求繞過代理。輸出不含認證 header。所有模式都是本機模擬，沒有真打模式。

在 `server/tavern-claude-bridge/` 執行：

```powershell
npm install --no-audit --no-fund
node test/probes/sdk-wire-probe.mjs route node_modules/.sdk-wire-lab/runs/routed
node test/probes/sdk-wire-probe.mjs route node_modules/.sdk-wire-lab/runs/compat compat
npm test
```

第三參數可選 `disable-attachments`、`snapshot-off` 或 `safe-mode`，分別測 `CLAUDE_CODE_DISABLE_ATTACHMENTS=1`、custom prompt 的 `snapshot: false`、`extraArgs: { 'safe-mode': null }`。請各給不同輸出目錄以保留證據。

`route` 模式讓橋自己選 SDK，不覆寫新版 query 或 cwd；會跑 Opus 5.5、Fable 5.1、Fable 5.2，輸入相同的假角色設定與短句。`compat` 額外驗 5.2 串流／非串流、摘要開關、effort、非零 usage／快取數字及 HTTP 400 錯誤。CLI 對 400 可能自行拿掉部分參數重試，全部都只接本機假上游。`capture.json` 含版本、輸入、橋回應、所有上游 body；`request-N.body.txt` 是未重新序列化的 body。帳戶與 email 都是 `example.invalid` 測試值。不要把含 session 記錄的本機輸出目錄加入公開版控。

第一參數仍可給 SDK 安裝目錄，強制呼叫指定 SDK，搭配上面的歷史實驗模式使用；這種強制模式不驗證分流。

`test/fixtures/*.0.3.280.body.txt` 是 c7b0642 程式尚未修改時，本輪先行捕捉的基準。保留 JSON 原始排列與提示每個字，只把 metadata 裡每次新建的 device/session ID、每天改變的日期替換為標記。`wire-normalize.mjs` 不重新序列化 JSON；兩個舊模型整份規格化 body 必須逐字相等，不能只比角色卡片段。當天的 before/after 原始 system/messages 也已逐字對過（沒有日期規格化）。

本次結果：兩版都有固定 SDK 身分句、email 提醒與日期；0.3.322 另外送出環境說明與模型身分句，上一輪的三個候選開關都沒消掉。新版 cwd 改成 `os.tmpdir()/tavern-claude-bridge/sdk-next-cwd`，實測空目錄、不是 git repo，環境段不再出現 worktree／stash 說明。仍有官方工具固定附帶的平台、shell、OS、下載檔案提醒、模型身分句與日期。

5.2 的 max_tokens 由新版預設 128000 拉回 32000、Auto effort 由 medium 拉回 high；明確的環境設定保留。模型強制 adaptive，不能真的關閉思考；開關改為 summarized／omitted，並用 CLI 2.1.322 已取證的 `CLAUDE_CODE_THINKING_DISPLAY_UPDATES=0` 防止 omitted 被改成 updates。這個開關來自釘死版本的 CLI 實作，未在官方環境變數文件找到條目，未來升級仍須重驗。`context_management.edits=[{type:'clear_thinking_20251015',keep:'all'}]` 綁定 thinking，沒有 SDK 的獨立關閉選項，本輪保留它。

`npm test` 全部使用本機假上游或純本機檢查。它能證明接線、送出內容與解析，不能單獨證明真上游接受模型或提示純淨。第三輪另外獲准的兩發真打已完成，測試腳本不收進正式版，也不放進 npm test；後續不能把重跑本機測試當作再真打的授權。

參數來源：[官方 system prompt 文件](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts#turn-off-the-context-your-agent-replaces)、本機安裝包 `sdk.d.ts` 與 `claude.exe --help`。`--bare` 不讀訂閱 OAuth，依[官方說明](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)不適合本次訂閱橋需求，未拿它替代升級條件。
