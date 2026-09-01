# OpenCLI Agent

A command-line AI agent in the style of Gemini CLI. **The AI API is Tencent Yuanbao via [OpenCLI](https://github.com/jackwener/opencli)**, so it uses no LLM tokens and runs at zero cost.

## How it works

```
User input
   │
   ▼
Agent (ReAct loop)
   │  Build prompt (system + history + available tools)
   ▼
opencli yuanbao ask "..."
   │  Chrome extension automation sends the message to the Yuanbao web UI
   ▼
Yuanbao AI response
   │
   ├── tool_call block? → run the tool → append result to prompt → loop
   │
   └── no tool_call → print the final answer
```

Browser session reuse: OpenCLI keeps the Chrome login. Multi-turn chat continues in the same Yuanbao window; the page is not reopened every time.

---

## Features

- **Multi-turn chat:** keep conversation history and continue in the same Yuanbao window
- **ReAct agent loop:** the AI can call tools, observe results, and keep reasoning until a final answer
- **Built-in tools:**
  - `shell` — run any shell command
  - `read_file` — read a file (offset/limit for slices)
  - `write_file` — write/create a file (creates parent dirs)
  - `append_file` — append to a file
  - `delete_file` — delete a file or empty directory
  - `list_dir` — list a directory (optional recursive)
  - `search_files` — search by filename or contents (ripgrep first, Node.js fallback)
  - `web_search` — web search (DuckDuckGo Lite, no API key, uses proxy automatically)
  - `web_fetch` — fetch a page and parse it to plain text
- **Yuanbao toggles:** web search (`--search`) and deep thinking (`--think`)
- **Interactive REPL:** colored terminal UI with `/new`, `/tools`, `/history`, and more
- **One-shot mode:** pass a message argument, suitable for scripts
- **Zero token cost:** reuse the browser login; no API key; no LLM quota

---

## Tech stack and dependencies

| Layer | Tech |
|------|------|
| Runtime | Node.js >= 21 |
| Language | TypeScript 5.5 |
| AI calls | [OpenCLI](https://github.com/jackwener/opencli) `opencli yuanbao ask` |
| Browser automation | Chrome + OpenCLI Browser Bridge extension |
| AI backend | Tencent Yuanbao (yuanbao.tencent.com) |
| Terminal UI | Node.js readline (built-in), native ANSI colors |
| Cross-platform subprocess | [cross-spawn](https://github.com/nicolo-ribaudo/cross-spawn) (Windows `.cmd` wrappers + argument splitting) |

---

## Prerequisites

1. **Node.js >= 21**
   ```bash
   node --version   # need v21+
   ```

2. **Install OpenCLI**
   ```bash
   npm install -g @jackwener/opencli
   ```

3. **Install the OpenCLI Browser Bridge extension**
   - Option A: install **OpenCLI** from the Chrome Web Store
   - Option B: download the zip from [GitHub Releases](https://github.com/jackwener/opencli/releases) and load it unpacked

4. **Log into Yuanbao**
   - Open Chrome, visit https://yuanbao.tencent.com, and complete login

5. **Verify**
   ```bash
   opencli doctor
   opencli yuanbao ask "hello"
   ```

---

## Install and run

```bash
# Clone or enter the project directory
cd opencli-agent

# Install dependencies
npm install

# Compile TypeScript
npm run build

# Run
node dist/cli.js
```

Or link globally (optional):

```bash
npm link
opencli-agent
```

---

## Usage

### Interactive mode (default)

```bash
node dist/cli.js
```

You enter a REPL. Type a message to send:

```
╔══════════════════════════════════════════╗
║  OpenCLI Agent  powered by Yuanbao       ║
╚══════════════════════════════════════════╝

You › list the files in the current directory
⚙ Tool: list_dir  {"path":"."}
✓ list_dir (15 lines)
⚙ Tool: read_file  {"path":"./package.json"}
✓ read_file (22 lines)

◆ Assistant
──────────────────────────────────────────
This directory is a Node.js project. Main files include...
──────────────────────────────────────────

You ›
```

### One-shot mode

```bash
node dist/cli.js "What is quantum entanglement?"
node dist/cli.js --think "Explain merge sort step by step"
node dist/cli.js --no-tools "Tell a joke"
```

### CLI flags

| Flag | Short | Description |
|------|------|------|
| `--no-tools` | `-T` | Disable tool calls (chat only) |
| `--no-search` | | Disable Yuanbao web search |
| `--think` | `-t` | Enable Yuanbao deep thinking |
| `--new` | `-n` | Start a new Yuanbao session first |
| `--timeout <seconds>` | | Response timeout (default 120s) |
| `--help` | `-h` | Show help |

### REPL commands

| Command | Description |
|------|------|
| `/new` | Open a new Yuanbao session in the browser |
| `/clear` | Clear local history (browser unchanged) |
| `/history` | Show current conversation history |
| `/tools` | Toggle tool calls |
| `/think` | Toggle deep thinking |
| `/search` | Toggle web search |
| `/help` | Show help |
| `/exit` or `/quit` | Quit |

---

## File structure

```
.
├── src/
│   ├── cli.ts              # CLI entry, REPL, arg parse, terminal UI
│   ├── agent.ts            # Agent core: ReAct loop, history, prompt
│   ├── yuanbao-client.ts   # OpenCLI yuanbao wrapper (ask / new), retries
│   ├── tools.ts            # Built-in tools: file I/O, search/fetch, shell, parser
│   └── render.ts           # Terminal Markdown renderer (no third-party deps)
├── dist/                   # TypeScript build output (generated)
├── package.json
├── tsconfig.json
└── README.md
```

---

## Tool-call protocol

The agent tells Yuanbao about available tools in the system prompt and asks the AI to emit calls in this format:

````
```tool_call
{
  "tool": "shell",
  "input": { "command": "ls -la" }
}
```
````

After parsing this, the agent runs the tool locally, appends the result to the prompt, and calls `opencli yuanbao ask` again until the AI returns a final answer with no `tool_call`.

---

## Example tasks

```bash
# Code review
node dist/cli.js "Look for potential bugs in src/agent.ts"

# File operations
node dist/cli.js "Create hello.py in the current directory with a Fibonacci printer"

# System info
node dist/cli.js "Show the current Node.js version and globally installed npm packages"

# Deep thinking
node dist/cli.js --think --no-tools "Analyze pros and cons of a microservice architecture"

# New session
node dist/cli.js --new "Start from scratch and help me plan a web project"

# Web search (AI calls web_search)
node dist/cli.js "What is the weather in Hangzhou today? Should I bring an umbrella tomorrow?"
node dist/cli.js "Search the latest TypeScript 5.5 release notes and summarize new features"

# Fetch a page
node dist/cli.js "Read https://github.com/jackwener/opencli README and summarize it"

# Combined: search + write file
node dist/cli.js "Search Hangzhou-to-Beijing high-speed rail info, make a table, save to trains.md"
```

---

## Troubleshooting

| Error | Cause | Fix |
|------|------|------|
| `opencli is not installed` | opencli missing or not on PATH | `npm install -g @jackwener/opencli` |
| Exit code 69: Browser Bridge not connected | Chrome extension not running | Keep Chrome open with the extension enabled |
| Exit code 77: Not logged in | Yuanbao login expired | Visit yuanbao.tencent.com in Chrome and log in again |
| Empty response or timeout | Slow network or slow Yuanbao | Increase `--timeout 240` |
| `Yuanbao composer was not found` | Yuanbao page just opened; React not finished rendering | Agent waits and retries (up to 4 times, 4/6/8/10 s); usually no manual step |
| Infinite tool-call loop | AI keeps calling tools | Default max 10 rounds; adjust `maxIterations` in the `Agent` constructor |
