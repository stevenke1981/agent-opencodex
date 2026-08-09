# Agent OpenCodex

Agent OpenCodex 是給 Agents、Codex、CI 與子代理使用的精簡型 LLM 路由閘道。它接收 OpenAI Responses API，轉換成 OpenAI Chat、原生 Responses、Anthropic Messages 或 Gemini `generateContent`，再把文字、推理摘要、工具呼叫、用量與終止狀態轉回 Responses JSON／SSE。

設計目標不是複製原專案所有人類操作介面，而是提供代理真正需要、可驗收、可回復、可由機器穩定操作的核心。

## 核心特色

- **零執行期相依**：只需要 Node.js 20.11 以上。
- **Agent-first**：非互動 CLI、JSON 輸出、穩定退出碼、同時相容新版與舊版的 stdio MCP 工具。
- **四種上游協定**：OpenAI Chat、OpenAI Responses、Anthropic、Gemini。
- **Responses 相容輸出**：支援非串流 JSON 與 SSE。
- **工具呼叫**：function/custom tool、Codex client-executed `tool_search`、MCP namespace 壓平與還原。
- **路由與復原**：`provider/model`、命名路由、重試、依序 failover。
- **長任務續接**：本機 `previous_response_id` 與 Codex remote compaction v1/v2。
- **安全預設**：只監聽本機；遠端監聽強制 bearer；API 金鑰只由環境變數讀取。
- **完整驗收**：JSON、JUnit、Markdown、服務日誌與 SHA-256 manifest。
- **離線測試**：內建四協定 mock provider，不需要真實 API 金鑰。

完整的上游分析與功能取捨請看 [ANALYSIS.md](./ANALYSIS.md)。

## 安裝

從原始碼目錄安裝：

```bash
npm install -g .
aocx version
```

若 Windows 強制 PowerShell 腳本簽章，可只對本次安裝程序略過，不修改系統執行原則：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

安裝或更新內附的 Codex skill，並建立時間戳回滾備份、逐檔驗證 SHA-256：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-skill.ps1 -Json
```

預設目的地是 `%USERPROFILE%\.codex\skills\agent-opencodex`。若既有安裝需要替換，JSON 結果會提供 `%USERPROFILE%\.codex\skill-backups` 下的 `backup` 路徑；備份位於 discovery root 外，避免出現重複 skill。舊目錄不會被原地刪除。

從發行套件安裝：

```bash
npm install -g ./agent-opencodex-0.1.0.tgz
aocx version
```

不全域安裝也可以直接執行：

```bash
node ./bin/aocx.mjs help
```

## 1. 建立設定

OpenRouter + DeepSeek 範例：

```bash
aocx init \
  --preset openrouter \
  --model deepseek/deepseek-v4-flash-latest \
  --config ~/.agent-opencodex/config.json \
  --json
```

設定 API 金鑰：

```bash
# Linux / macOS
export OPENROUTER_API_KEY="..."

# PowerShell
$env:OPENROUTER_API_KEY="..."
```

驗證設定與環境：

```bash
aocx validate --config ~/.agent-opencodex/config.json --json
aocx doctor --config ~/.agent-opencodex/config.json --json
```

`--probe` 只檢查供應商模型目錄是否可讀；`--inference` 會明確執行一次最小端到端生成，可能產生供應商用量，僅在確實要驗證真實推論時使用：

```bash
aocx doctor --config ~/.agent-opencodex/config.json --probe --inference --json
```

`init` 不會覆寫既有檔案，除非明確加入 `--force`。設定檔只保存環境變數名稱，不保存 API 金鑰。

## 2. 啟動閘道

```bash
aocx serve --config ~/.agent-opencodex/config.json
```

預設端點：

```text
GET  http://127.0.0.1:10101/healthz
GET  http://127.0.0.1:10101/readyz
GET  http://127.0.0.1:10101/v1/models
POST http://127.0.0.1:10101/v1/responses
POST http://127.0.0.1:10101/v1/responses/compact
```

## 3. 連接 Codex

產生設定片段：

```bash
aocx codex-config --config ~/.agent-opencodex/config.json
```

輸出範例：

```toml
model = "deepseek/deepseek-v4-flash-latest"
model_provider = "agent_opencodex"

[model_providers.agent_opencodex]
name = "Agent OpenCodex"
base_url = "http://127.0.0.1:10101/v1"
wire_api = "responses"
supports_websockets = false
```

工具**不會自動修改** `~/.codex/config.toml`。它只輸出可審查的片段；也可使用 `--output <path>` 寫入指定的新檔案。

## 4. 讓 Agent 透過 MCP 操作

啟動 stdio MCP server：

```bash
aocx mcp
```

提供的工具：

- `aocx_validate_config`
- `aocx_doctor`
- `aocx_route`
- `aocx_render_codex_config`
- `aocx_verify`
- `aocx_health`

Codex 的 MCP 設定範例：

```toml
[mcp_servers.agent_opencodex]
command = "aocx"
args = ["mcp"]
```

MCP 同時支援兩個世代：

- **2026-07-28 新版無狀態協定**：`server/discover`、每次請求的 `_meta` 版本／客戶端能力、`resultType`、工具目錄快取提示與每個結果的 server identity。
- **2025 世代相容模式**：保留 `initialize`／`notifications/initialized`，讓尚未升級的 Codex、IDE 或代理宿主仍可連線。

兩種模式共用同一組工具與安全邊界，不依賴連線階段保存會話狀態。

## Codex 工具協定

一般 function 與 custom tool 會轉成各供應商的函式工具格式。MCP namespace 工具在上游會壓平成 `namespace__name`，回到 Responses 時再還原成 `name` 加 `namespace`；多輪工具結果回放也保留相同對應。

大型工具目錄可使用 Codex client-executed tool search：

```json
{
  "type": "tool_search",
  "execution": "client",
  "description": "搜尋目前可用工具",
  "parameters": {
    "type": "object",
    "properties": { "query": { "type": "string" } },
    "required": ["query"]
  }
}
```

模型選擇搜尋時，閘道回傳 `type: "tool_search_call"`，其中 `arguments` 是 JSON 物件且不偽裝成一般 function call。Codex 執行搜尋後可在下一輪送回：

```json
{
  "type": "tool_search_output",
  "call_id": "call_...",
  "execution": "client",
  "status": "completed",
  "tools": []
}
```

這個 call/output 配對同時支援 generic adapter 與 native Responses adapter，並列入離線端到端驗收。MCP 另以真正的 stdio 子程序驗證新版 discovery、工具清單、`aocx_verify` 執行及舊版 initialize。

## 路由設定

```json
{
  "defaults": {
    "provider": "openrouter",
    "model": "deepseek/deepseek-v4-flash-latest"
  },
  "routes": {
    "coding-fast": [
      { "provider": "openrouter", "model": "deepseek/deepseek-v4-flash-latest" },
      { "provider": "ollama", "model": "qwen3-coder" }
    ]
  }
}
```

模型選擇器有三種：

- `deepseek/deepseek-v4-flash-latest`：使用預設 provider。
- `openrouter/deepseek/deepseek-v4-flash-latest`：明確指定 provider。
- `coding-fast`：使用命名路由中的候選順序。

呼叫範例：

```bash
curl http://127.0.0.1:10101/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"coding-fast","input":"修復測試","stream":false}'
```

只有在上游尚未開始回傳輸出前，系統才會切換下一個候選者，避免把兩個模型的內容混在同一個回應。

## 長對話與 compaction

### 本機續接

完成的 Responses 回應會在記憶體中保存有限時間。下一次可傳入：

```json
{
  "model": "coding-fast",
  "previous_response_id": "resp_...",
  "input": "繼續完成剩餘工作"
}
```

狀態不寫入磁碟，程序重啟後失效，並受 `continuation.maxEntries` 與 `continuation.ttlMs` 限制。

### Remote compaction v2

Codex 可在一般 `/v1/responses` 輸入最後加入：

```json
{ "type": "compaction_trigger" }
```

Agent OpenCodex 會讓路由模型產生交接摘要，再回傳**唯一一個** `type: "compaction"` 的輸出項，不混入一般 assistant message。摘要使用透明的 `aocx1:` envelope；回放時會解碼成一般上下文。也能讀取上游 OpenCodex 的 `ocx1:` envelope，方便遷移。

### Remote compaction v1

`POST /v1/responses/compact` 會回傳：

```json
{
  "output": [
    { "type": "message", "role": "user", "content": [] }
  ]
}
```

輸出是替代歷史：保留最近的使用者訊息，最後附上摘要。這個端點不保存摘要到磁碟。

## 驗收

執行完整離線驗收：

```bash
npm test
npm run accept
npm run pack:check
```

或直接：

```bash
aocx verify \
  --spec ./examples/acceptance.smoke.json \
  --report-dir ./artifacts/acceptance \
  --json
```

輸出：

```text
artifacts/acceptance/
├── report.json
├── summary.md
├── junit.xml
├── manifest.json
└── logs/
    ├── mock.log
    └── gateway.log
```

正式 smoke suite 會實際啟動隔離的 mock 與 gateway，驗證健康狀態、模型目錄、JSON、SSE、function／namespace 工具、完整 `tool_search_call` → `tool_search_output` 閉環、故障轉移、四種上游協定、compaction v1/v2、來源語法與 `AGENTS.md`。`manifest.json` 記錄每個證據檔案的位元組數與 SHA-256。

驗收規格中的 command 使用參數陣列直接執行，**不經 shell**；但規格仍可啟動程式，所以只應執行可信任的本機規格。

## Provider 類型

### OpenAI-compatible Chat／OpenRouter／DeepSeek

```json
{
  "type": "openai-chat",
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKeyEnv": "OPENROUTER_API_KEY",
  "models": ["deepseek/deepseek-v4-flash-latest"]
}
```

### Native Responses

```json
{
  "type": "openai-responses",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY",
  "models": ["gpt-5.6-luna"]
}
```

### Anthropic

```json
{
  "type": "anthropic",
  "baseUrl": "https://api.anthropic.com/v1",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "models": ["claude-sonnet-4-6"],
  "anthropicVersion": "2023-06-01"
}
```

### Gemini

```json
{
  "type": "gemini",
  "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
  "apiKeyEnv": "GEMINI_API_KEY",
  "models": ["gemini-3-pro"]
}
```

### Ollama

Ollama 使用 OpenAI-compatible Chat：

```json
{
  "type": "openai-chat",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "models": ["qwen3-coder"]
}
```

## 遠端存取

本機預設不需要 client token。當 `server.host` 不是 loopback 時，設定驗證要求 bearer：

```json
{
  "server": {
    "host": "0.0.0.0",
    "clientAuth": {
      "mode": "bearer",
      "tokenEnv": "AGENT_OPENCODEX_CLIENT_KEY"
    }
  }
}
```

環境變數必須存在，遠端 token 至少 16 個字元。客戶端需送出：

```http
Authorization: Bearer <AGENT_OPENCODEX_CLIENT_KEY>
```

不要把公開監聽埠直接暴露到網際網路。建議放在 TLS reverse proxy、VPN 或 Cloudflare Tunnel 後方。若 provider 需要憑證，非 loopback 的 `http://` 上游預設會被拒絕；應改用 HTTPS，或在受控私有網路中明確設定 `allowInsecureHttp: true`。

## 明確不包含

這個精簡版不包含：

- Dashboard、GUI 與使用量圖表
- ChatGPT 帳號池、quota routing、OAuth、keyring
- 背景 service、啟動 shim、自動更新
- 自動修改 Codex config 或 catalog
- WebSocket Responses、Realtime、voice
- image/video generation relay
- web-search、vision sidecar
- Cursor protobuf 與多桌面客戶端相容層
- 加權帳號池或複雜政策引擎

這些功能不是「壞掉」，而是刻意排除，以縮小憑證面、安裝面與代理可變更的使用者狀態。

## 開發與完成標準

```bash
npm test
npm run accept
npm run pack:check
```

三項都通過後，才能宣告可交付。授權為 MIT；上游啟發與 independently implemented 說明請看 [NOTICE](./NOTICE)。
