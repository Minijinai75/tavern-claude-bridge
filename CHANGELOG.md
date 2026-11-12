# 版本紀錄

## v1.9.15 — 26-11-12

更新時間：26-11-12 23:23。狀態：本機副本 27 項測試通過，訂閱真打 Fable 5.2、Opus 5.5 各一發，兩發都回「好」，尚未發版。下一步：交回整合審閱；版號維持 1.9.15。

- 模型清單加入 `claude-fable-5-2`。
- 新舊兩版 SDK 一起裝：其他模型照舊用 0.3.280，只有選 Fable 5.2 才載入 0.3.322。Opus 5.5、Fable 5.1 的提示原文與參數已用本機假上游逐字對過。
- **5.2 的官方工具會在每則多附環境說明與「You are powered by the model named Fable 5.2…」身分句，目前關不掉。** 已改用專用空資料夾，去掉 Git 工作區資訊；仍可能影響角色扮演。其他模型不受影響。
- 5.2 的預設輸出上限拉回原本的 32,000 tokens，Auto 的 effort 維持原本的 high。5.2 本身強制開啟思考，面板開關控制的是是否顯示摘要；關閉時送 `omitted`，開啟時送 `summarized`。新版自動加的保留思考區塊參數仍保留。
- 接住新版只放在最終 result 的串流錯誤，讓畫面讀得到原文。思考段、usage、快取讀寫與壽命也驗過串流／非串流兩條路。
- 安裝器會複製 lockfile、檢查 npm 是否成功，以及兩份 SDK 的實際版本。README 補上後台更新步驟。
- 價目、最小快取長度與中文 token 估算表都將 5.2 放在 5.1、5 前面，避免前綴比對誤用舊型號。
- 官方單價（每百萬 token）：輸入 US$8、輸出 US$40、快取讀取 US$0.20；5 分鐘寫入 US$10、1 小時寫入 US$16。橋沿用 1 小時快取與 2 倍寫入倍率；最小可快取長度 512 tokens。中文估算係數沿用保守值 1.0，並非官方 tokenizer 測量值。
- 前端面板、擴充 manifest 與 server package 版號同步為 1.9.15。
- 補上 `npm test` 離線回歸測試，驗價格、快取門檻、費用估算、模型清單與舊型號。

來源：[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)、[models overview](https://platform.claude.com/docs/en/models/overview)、[prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#cache-limitations)。
