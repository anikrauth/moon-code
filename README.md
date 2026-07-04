# 🌙 Moon Code — The Terminal-Native Coding IDE That Thinks With You

**Moon Code** is an advanced coding agent IDE for macOS that combines the power of a full-featured Electron desktop application with a streaming, reactive AI agent — running directly in your workspace. It doesn't just generate code; it *works with you*, executing commands, editing files, searching your codebase, spawning parallel subagents, managing secrets, and rendering live UI directly in the chat.

---

## ✨ At a Glance

| What | How |
|---|---|
| **Agent loop** | Streaming LLM with full tool calling — one conversation turn can chain dozens of tool calls autonomously |
| **File operations** | Read, write, edit, search, glob — all from the agent with workspace containment |
| **Subagents** | Parallel child agents with their own tool access for multi-tasking |
| **Skills system** | Plug-in working practices — bundled catalog + local `.moon/skills/` + marketplace + URL installation |
| **MCP (Model Context Protocol)** | Connect any MCP server — filesystem, GitHub, fetch, puppeteer, databases — the agent gets their tools automatically |
| **Session persistence** | Every chat turn auto-saves with full history, workspace, and token usage — browse and resume later |
| **Multi-model profiles** | Unlimited model configs — OpenAI, Anthropic, OpenRouter, Zhipu GLM, Cloudflare, any OpenAI-compatible provider — with per-profile context window and output token overrides |
| **Live UI rendering** | The agent outputs structured JSON UI specs that render inline as Stack, Text, List, Table, and CodeBlock |
| **Token-aware compaction** | Automatic conversation summarization when approaching context limits — configurable by model |
| **Slash commands** | `/clear`, `/compact`, `/usage`, `/model`, `/skills`, `/sessions`, `/mcp`, `/settings`, `/debug`, `/help`, plus dynamic skill commands |
| **OS-level encryption** | API keys and MCP secrets are encrypted via `safeStorage` (macOS Keychain) |
| **Permission system** | Every tool call requests user permission with "allow once" or "always allow" options per session |
| **Rich input toolbar** | Model switcher, skill badges, MCP connection count, context window indicator, file attachment affordance |
| **Context usage tracking** | Real-time context window fullness, session token counters, estimated session cost per model pricing table |

---

## 🧠 Architecture

Moon Code is built on four layers:

### 1. Electron Main Process (`src/main/`)
The backbone — all I/O, secrets, tool execution, and agent orchestration happen here, organized Feature-Sliced-Design style: `main.ts` bootstraps the app and wires each `app/ipc/register*Ipc.ts` module, which imports only from its matching `features/<domain>/` slice.

| Path | Purpose |
|---|---|
| `main.ts` | Electron app lifecycle, window management, service instantiation, calls each `registerXIpc` |
| `app/ipc/register*Ipc.ts` | One file per IPC domain (config, sessions, skills, mcp, agent, git, memory, workspace, dialog) — thin `ipcMain.handle/on` registration |
| `app/ipc/ipcUtils.ts` | Shared generic helpers: atomic `mkdirExclusive`, promise-chain `withLock` |
| `features/agent/` | The agent loop, split by concern: `historyCompaction.ts`, `toolRouter.ts` (tool schemas/execution + subagent spawn), `systemPrompt.ts`, `agentLoop.ts` (streaming), `index.ts` (public API) |
| `features/config/configStore.ts` | Durable config with OS-level encrypted API keys and MCP secrets, multi-profile management |
| `features/sessions/sessionStore.ts` | Atomic JSON persistence for conversation sessions with index tracking |
| `features/mcp/mcpManager.ts` | MCP client lifecycle — stdio and HTTP transports, tool discovery, secret injection, reconnection |
| `features/skills/skillScanner.ts` | Scans `.moon/skills/` project and `~/.moon/skills/` personal directories for SKILL.md files with YAML frontmatter |
| `features/skills/skillInstaller.ts` | Installs skills from `owner/repo` package specs, disk, URL, or marketplace |
| `features/search/searchTools.ts` | Blazing-fast glob and grep search — walks workspace tree, respects `.gitignore`-like filters, binary detection, max size limits |
| `features/git/gitService.ts` | Git snapshot/checkout/commit via `execFile` |
| `features/memory/memoryStore.ts` | MOON.md instruction files with `@import` resolution, learned-fact memory |
| `features/workspace/workspaceInit.ts` | First-open `.moon` scaffolding, agent-config discovery with symlink-escape guarding |
| `features/status/statusLine.ts` | Terminal status line with spinner, elapsed time, token counter, and Esc-key interrupt (for CLI mode) |
| `features/diff/diffStats.ts` | Line-level add/delete diff stats for file changes |

### 2. Preload Bridge (`src/preload/preload.ts`)
Securely exposes IPC methods to the renderer via `contextBridge.exposeInMainWorld`. Every `electron.*` call in the UI maps to a validated IPC handler.

### 3. React Renderer (`src/renderer/`)
A fully native macOS window (hidden title bar, draggable background, blur effects), organized Feature-Sliced-Design style — panels have zero sideways imports between each other, everything flows through `App.tsx`'s state:

| Path | Role |
|---|---|
| `App.tsx` | Composition root: workspace selection, chat messages, permission modals, agent event stream, session management, status indicators, context warning banner, slash commands |
| `widgets/top-bar/TopBar.tsx` | Title bar, workspace selector, branch indicator |
| `widgets/task-sidebar/TaskSidebar.tsx` | Session list, new task, open workspace, skills/settings entry points |
| `widgets/right-panel/RightPanel.tsx` | Git status/commit, goal, and live progress-checklist sections |
| `widgets/overlay-modal/OverlayModal.tsx` | Generic modal wrapper used by every panel below |
| `features/chat-input/RichInput.tsx` | Multi-line textarea with auto-resize, slash-command autocomplete, toolbar with model switcher, skill badges, MCP connection count, context chip, send/stop buttons |
| `features/tool-chips/ToolChips.tsx` | Tool call/result chip rendering + turn summary cards |
| `features/skills-panel/SkillsPanel.tsx` | Catalog of built-in working practices, discovered local skills, marketplace skills, create/install/URL-import buttons |
| `features/mcp-panel/McpPanel.tsx` | Server CRUD, connect/disconnect, built-in presets (Filesystem, GitHub, Memory, Fetch, Puppeteer, Sequential Thinking, custom) |
| `features/settings-panel/SettingsPanel.tsx` | Multi-provider model profile management with per-profile overrides for context window and max output tokens |
| `features/usage-panel/UsagePanel.tsx` | Real-time context window bar, session token counters, estimated cost calculation |
| `features/permission-request/PermissionRequest.tsx` | Tool-call permission approval dialog |
| `entities/chat-message/Markdown.tsx` + `parseAssistantContent.ts` | Streaming markdown rendering + JSONL UI-spec compilation for messages |
| `entities/ui-spec/uiRegistry.tsx` | Registers React components for `@json-render/react` rendering of agent-generated UI specs with syntax highlighting via highlight.js |

### 4. Shared Modules (`src/shared/`)

| Path | Purpose |
|---|---|
| `config/uiCatalog.ts` | Zod-validated component catalog for `@json-render/core` — defines Stack, Text, List, Table, CodeBlock |
| `lib/modelLimits.ts` | Per-model context window, output caps, capability flags (tools/vision), and pricing table for 25+ model variants |
| `lib/markdownBlocks.ts` | Streaming markdown block-splitting utilities |
| `lib/renderUiSpec.ts` | SpecStream JSONL validation/parsing |
| `config/skillMarketplace.ts` | Bundled marketplace skills: Define Goal, Security Best Practices, CLI Creator |
| `types/skillTypes.ts` | TypeScript interfaces for discovered skills and bundled skills |

---

## 🔄 The Agent Loop (How the Brain Works)

```
User prompt
    │
    ▼
History compaction check ──── If context >75% of budget, summarize
    │
    ▼
Project memory loaded (MOON.md)
    │
    ▼
System prompt assembled (identity + project memory + active skills + discovered skills catalog + UI spec rules)
    │
    ▼
Tool set created ──── run_command, read_file, write_file, edit_file, list_dir,
│                       glob_search, grep_search, skill, spawn_agent, + MCP tools
│
▼
streamText() ──── Streaming LLM call via AI SDK
    │
    ├── text-delta → streams into chat message (character by character)
    ├── tool_call  → creates tool activity cards in the UI
    │                  └── tool result → appended to tool card (collapsible)
    ├── finish-step → captures per-step usage metrics
    ├── finish     → captures total turn usage, triggers session save
    └── error      → surfaces to user with cancellation support
```

Key design decisions:
- **Tool outputs are capped** at 30,000 characters by default with intelligent head/middle/tail truncation
- **Workspace containment** — all file operations are validated against the workspace root; path traversal attacks are blocked
- **Subagents** get their own tool set (minus `spawn_agent` to prevent infinite recursion) plus the same project memory and skills context
- **History compaction** uses a separate LLM call to summarize old messages, preserving file paths, decisions, and unresolved tasks — with a guard against infinite loops via `Math.max(2, ...)` floor

---

## 🛠️ Tools the Agent Can Use

| Tool | What It Does | Safety |
|---|---|---|
| `run_command` | Executes any bash command with 60s timeout | Permission-gated + workspace CWD |
| `read_file` | Reads file contents with offset/limit, caps at 50k chars | Workspace-escaped paths blocked |
| `write_file` | Creates new files + parent directories | Permission-gated + workspace containment |
| `edit_file` | Replace exact string match (requires exactly 1 occurrence) | Permission-gated + workspace containment |
| `list_dir` | Lists directory contents, max 500 entries | Workspace-escaped paths blocked |
| `glob_search` | Fast glob matching (newest-first), max 200 matches | Respects `node_modules`, `.git`, binary detection |
| `grep_search` | Regex search with glob file-filter, max 200 matches | Skips binary files, files >1MB |
| `skill` | Loads full SKILL.md instructions on demand | Progressive disclosure — only IDs shown upfront |
| `spawn_agent` | Parallel subagent with own tools, tasks, and context | No subagent-within-subagent |
| `mcp__*` | Every discovered MCP server tool | Namespace-collision detection and auto-disambiguation |

---

## 🧩 Skills System

Skills are reusable working practices that the agent follows. Three tiers:

### Built-in Catalog (always available)
Toggle 8 skills on/off from the UI — Code Review, TDD, Systematic Debugging, Refactoring, Git Discipline, Documentation, Plan First, Concise Output.

### Local Skills (`.moon/skills/`)
Drop a `SKILL.md` with YAML frontmatter into your project's `.moon/skills/` directory or `~/.moon/skills/` globally. The agent discovers them automatically and loads them on demand via the `skill` tool.

```markdown
---
name: my-workflow
description: "My custom review workflow"
user-invocable: true
---
# my-workflow

Always run the linter first, then check for type errors...
```

### Marketplace + URL Installation
- **Bundled**: Define Goal, Security Best Practices, CLI Creator
- **From Disk**: Select any SKILL.md file or directory
- **From URL**: Paste any raw SKILL.md URL

Skills are **progressively disclosed** — the agent only sees `id + description` in the system prompt and loads full instructions via the `skill` tool when it decides to use one.

---

## 🌐 MCP (Model Context Protocol)

Moon Code is a full MCP client supporting both transport types:

| Transport | Configuration |
|---|---|
| **stdio** | Local command + args + environment variables |
| **http** | Remote URL + custom headers |

**Built-in presets** (one-click add): Filesystem, GitHub, Memory, Fetch, Puppeteer, Sequential Thinking.

When you connect an MCP server, every tool it exposes is automatically injected into the agent's tool set with `mcp__{ServerName}__{ToolName}` naming. Collision detection and automatic disambiguation handle duplicate names.

Secrets (env vars, headers) are encrypted via macOS safeStorage and decrypted only at connection time.

---

## 💾 Session Persistence

Every turn auto-saves to `{userData}/sessions/` with:
- Full message history and raw conversation history
- Workspace path
- Token usage (input, output, cached, turns, context window info)
- Timestamps (created, updated)

Sessions are index-tracked (`index.json`) and browseable from the Sessions panel. Each session survives app restarts and can be resumed at any point.

---

## ⚙️ Model Profiles

Unlimited named profiles, each with:

| Field | Description |
|---|---|
| Name | Human-readable label |
| Provider | OpenAI, Anthropic, OpenRouter, Zhipu GLM, Cloudflare Workers AI, Custom |
| Model | Any model ID string |
| Base URL | Override endpoint (for proxies, self-hosted, etc.) |
| API Key | Encrypted via OS safeStorage |
| Context Window Override | Override the built-in model table |
| Max Output Tokens Override | Override the built-in model table |

The model table knows 25+ model variants including GPT-4o family, GPT-4.1 family, o3/o4-mini, Claude 3/3.5/4 families, DeepSeek, Gemini 1.5/2, Llama 3.x, Qwen, GLM-4, with pricing data for cost estimation.

---

## 📊 UI Spec System (SpecStream)

The agent doesn't just output plain text — it outputs structured JSONL (JSON Patch operations) that the renderer compiles into live UI components:

```
{"op":"add","path":"/root","value":"main"}
{"op":"add","path":"/elements/main","value":{"type":"Stack","props":{},"children":["greeting","features"]}}
{"op":"add","path":"/elements/greeting","value":{"type":"Text","props":{"content":"Hello World"},"children":[]}}
{"op":"add","path":"/elements/features","value":{"type":"List","props":{"items":["Feature A","Feature B"],"ordered":false},"children":[]}}
```

Components: **Stack** (vertical container), **Text**, **List** (bulleted/numbered), **Table**, **CodeBlock** (with syntax highlighting).

The spec is streamed progressively — state patches interleave with element patches so the UI fills in as it arrives. A `SpecErrorBoundary` catches render-time failures gracefully, falling back to raw text.

---

## 🔐 Security

- **API keys** encrypted via `safeStorage.encryptString()` (macOS Keychain)
- **MCP secrets** encrypted identically
- **Workspace containment** — all file paths validated against workspace root
- **Permission system** — every tool call requires user approval with "once" or "always allow" per session
- **Tool output caps** prevent runaway output from consuming context
- **Binary detection** in search tools skips non-text files
- **No symlink following** in search tools (prevents traversal attacks)
- **Context budget enforcement** — automatic compaction prevents context overflow

---

## 🚀 Getting Started

```bash
# Install dependencies
npm install

# Development (Vite dev server + Electron)
npm run dev

# Build for distribution
npm run build

# Run tests
npm test
```

---

## 📁 Project Structure

Feature-Sliced Design: each process (`main`, `renderer`) nests `app → features/widgets → entities` layers inside its own tree; a layer only imports from itself or a layer below.

```
moon-code/
├── src/
│   ├── main/                      # Electron main process
│   │   ├── main.ts                # App lifecycle, window, service wiring, calls registerXIpc
│   │   ├── app/ipc/               # Thin per-domain ipcMain.handle/on registration
│   │   │   ├── register{Config,Sessions,Skills,Mcp,Agent,Git,Memory,Workspace,Dialog}Ipc.ts
│   │   │   └── ipcUtils.ts        # mkdirExclusive (TOCTOU-safe), withLock (promise-chain)
│   │   └── features/
│   │       ├── agent/             # historyCompaction, toolRouter, systemPrompt, agentLoop, index
│   │       ├── config/configStore.ts
│   │       ├── sessions/sessionStore.ts
│   │       ├── mcp/mcpManager.ts
│   │       ├── skills/{skillScanner,skillInstaller}.ts
│   │       ├── search/searchTools.ts
│   │       ├── git/gitService.ts
│   │       ├── memory/memoryStore.ts
│   │       ├── workspace/workspaceInit.ts
│   │       ├── status/statusLine.ts
│   │       └── diff/diffStats.ts
│   ├── renderer/                  # React frontend
│   │   ├── App.tsx                # Composition root: chat, permissions, session/git/skills state
│   │   ├── index.tsx
│   │   ├── widgets/                # Layout-shell pieces
│   │   │   ├── top-bar/TopBar.tsx
│   │   │   ├── task-sidebar/TaskSidebar.tsx
│   │   │   ├── right-panel/RightPanel.tsx
│   │   │   └── overlay-modal/OverlayModal.tsx
│   │   ├── features/                # Self-contained interactive panels
│   │   │   ├── chat-input/RichInput.tsx
│   │   │   ├── tool-chips/ToolChips.tsx
│   │   │   ├── skills-panel/SkillsPanel.tsx
│   │   │   ├── mcp-panel/McpPanel.tsx
│   │   │   ├── settings-panel/SettingsPanel.tsx
│   │   │   ├── usage-panel/UsagePanel.tsx
│   │   │   └── permission-request/PermissionRequest.tsx
│   │   ├── entities/                 # Pure display/data-shape, no side effects
│   │   │   ├── chat-message/{Markdown,parseAssistantContent}.ts(x)
│   │   │   └── ui-spec/uiRegistry.tsx
│   │   └── index.css                 # All styles (dark theme, glassmorphism)
│   ├── preload/
│   │   └── preload.ts  # Secure IPC bridge
│   └── shared/                    # Framework-agnostic, importable by main + renderer
│       ├── lib/{modelLimits,markdownBlocks,renderUiSpec}.ts
│       ├── types/skillTypes.ts
│       └── config/{uiCatalog,skillMarketplace}.ts
├── marketplace-skills/  # Bundled skill SKILL.md files
├── docs/superpowers/   # Design docs and implementation plans
└── test/               # Comprehensive test suite
```

---

## 🧪 Test Suite

```
test/
├── config-store.test.js    # Config persistence + encryption
├── config-mcp.test.js      # MCP server config integration
├── session-store.test.js   # Atomic session R/W
├── usage.test.js           # Token tracking
├── mcp-manager.test.js     # MCP client lifecycle
├── mcp-agent.test.js       # MCP tool injection into agent
├── search-tools.test.js    # Glob + grep edge cases
├── containment.test.js     # Workspace path safety
├── output-caps.test.js     # Tool output truncation
├── streaming.test.js       # Streaming agent response
├── subagents.test.js       # Parallel subagent execution
├── compaction.test.js      # History compaction
├── cancel.test.js          # Cancellation handling
├── model-limits.test.js    # Model table resolution
├── force-compact.test.js   # Manual compaction
├── skills-prompt.test.js   # Skill injection into system prompt
├── fixtures/
│   └── echo-mcp-server.mjs # Test MCP server
└── helpers/
    └── fake-openai.js      # Mock OpenAI for testing
```

---

## 🧰 Technologies

| Layer | Technology |
|---|---|
| Desktop shell | **Electron 43** with hiddenInset title bar |
| Build | **Vite 8** + **TypeScript 6** |
| UI | **React 19** + Lucide icons + highlight.js |
| AI SDK | **Vercel AI SDK 7** (`ai`, `@ai-sdk/openai`) |
| MCP | `@modelcontextprotocol/sdk` (stdio + streamable HTTP) |
| UI Rendering | `@json-render/core` + `@json-render/react` (StreamSpec JSONL) |
| Schema | `zod` (input validation + UI component props) |
| Encryption | Electron `safeStorage` (macOS Keychain) |
| Styling | CSS custom properties, glassmorphism, backdrop-blur |

---

## ⌨️ Slash Commands

| Command | Action |
|---|---|
| `/clear` | Start a new chat |
| `/compact` | Force history compaction now |
| `/usage` | Show token usage, limits, and estimated cost |
| `/context` | Show context window fullness |
| `/model <name>` | Switch to a model profile (fuzzy match) |
| `/skills` | Open skills panel |
| `/sessions` | Open saved sessions |
| `/mcp` | Open MCP servers panel |
| `/settings` | Open settings |
| `/debug` | Diagnostic info dump |
| `/help` | List all commands |
| `/<skill-id>` | Invoke any discovered skill directly |

---

## 💡 Why Moon Code?

Because coding with an agent shouldn't mean context loss, opaque behavior, or vendor lock-in.

- **You stay in control** — every operation is permission-gated, every token is counted, every cost is visible
- **Your tools come with you** — MCP servers, custom skills, model profiles, encrypted secrets
- **Your context never overflows** — automatic compaction keeps the conversation flowing
- **Your data stays local** — workspace containment, local-only execution, OS-level encryption
- **Your workflow adapts** — discoverable skills, extensible tool set, multi-model support

Moon Code isn't just an AI chat window. It's a full agentic development environment that thinks with you, works in your workspace, and grows with your practices.
