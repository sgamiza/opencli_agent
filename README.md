# OpenCLI Agent

一个类 gemini-cli 风格的命令行 AI Agent，**AI API 通过 [OpenCLI](https://github.com/jackwener/opencli) 调用腾讯元宝（Yuanbao）**，不消耗任何 LLM token，零成本运行。

## 工作原理

```
用户输入
   │
   ▼
Agent (ReAct 循环)
   │  构建 prompt（含系统提示 + 对话历史 + 可用工具描述）
   ▼
opencli yuanbao ask "..."
   │  通过 Chrome 浏览器扩展自动化，发送消息到元宝网页端
   ▼
元宝 AI 响应
   │
   ├── 有 tool_call 块？→ 执行工具 → 将结果追加到 prompt → 继续循环
   │
   └── 无 tool_call → 输出最终回答
```

浏览器会话复用：opencli 保持 Chrome 登录态，多轮对话自动在同一个元宝会话窗口中继续，无需每次重新打开页面。

---

## 功能特性

- **多轮对话**：自动维护对话历史，在元宝同一窗口中连续对话
- **ReAct Agent 循环**：AI 可以自主调用工具、观察结果、继续推理，直到给出最终答案
- **内置工具集**：
  - `shell` — 执行任意 shell 命令
  - `read_file` — 读取文件内容（支持 offset/limit 分段读取）
  - `write_file` — 写入/创建文件（自动创建父目录）
  - `append_file` — 向文件末尾追加内容
  - `delete_file` — 删除文件或空目录
  - `list_dir` — 列出目录内容（支持递归）
  - `search_files` — 按文件名或文件内容搜索（自动尝试 ripgrep，fallback 纯 Node.js 实现）
  - `web_search` — 联网搜索（DuckDuckGo Lite，无需 API Key，自动走代理）
  - `web_fetch` — 抓取并解析网页内容为纯文本
- **元宝功能开关**：支持开关联网搜索（`--search`）和深度思考（`--think`）
- **交互式 REPL**：带彩色 UI 的交互终端，支持 `/new`、`/tools`、`/history` 等指令
- **单次模式**：直接传入消息参数，适合脚本调用
- **零 token 成本**：复用浏览器登录态，无需 API Key，不消耗 LLM 配额

---

## 技术栈与依赖

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js >= 21 |
| 语言 | TypeScript 5.5 |
| AI 调用 | [OpenCLI](https://github.com/jackwener/opencli) `opencli yuanbao ask` |
| 浏览器自动化 | Chrome + OpenCLI Browser Bridge 扩展 |
| AI 后端 | 腾讯元宝 (yuanbao.tencent.com) |
| 终端 UI | Node.js readline（内置），ANSI 颜色（原生） |
| 跨平台子进程 | [cross-spawn](https://github.com/nicolo-ribaudo/cross-spawn)（解决 Windows `.cmd` 包装器 + 参数分词问题） |

---

## 前置要求

1. **Node.js >= 21**
   ```bash
   node --version   # 需要 v21+
   ```

2. **安装 OpenCLI**
   ```bash
   npm install -g @jackwener/opencli
   ```

3. **安装 OpenCLI Browser Bridge 扩展**
   - 方式 A：从 Chrome 应用商店安装 **OpenCLI**
   - 方式 B：从 [GitHub Releases](https://github.com/jackwener/opencli/releases) 下载 zip，手动加载

4. **登录元宝**
   - 打开 Chrome，访问 https://yuanbao.tencent.com 并完成登录

5. **验证安装**
   ```bash
   opencli doctor
   opencli yuanbao ask "你好"
   ```

---

## 安装与运行

```bash
# 克隆或进入项目目录
cd opencli-agent

# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 运行
node dist/cli.js
```

或者全局链接（可选）：
```bash
npm link
opencli-agent
```

---

## 使用方法

### 交互模式（默认）

```bash
node dist/cli.js
```

启动后进入 REPL，输入消息直接发送：

```
╔══════════════════════════════════════════╗
║  OpenCLI Agent  powered by Yuanbao       ║
╚══════════════════════════════════════════╝

You › 帮我分析当前目录下有哪些文件
⚙ Tool: list_dir  {"path":"."}
✓ list_dir (15 lines)
⚙ Tool: read_file  {"path":"./package.json"}
✓ read_file (22 lines)

◆ Assistant
──────────────────────────────────────────
当前目录包含一个 Node.js 项目，主要文件如下...
──────────────────────────────────────────

You ›
```

### 单次模式

```bash
node dist/cli.js "什么是量子纠缠？"
node dist/cli.js --think "分步骤解释归并排序"
node dist/cli.js --no-tools "讲一个笑话"
```

### 命令行参数

| 参数 | 简写 | 说明 |
|------|------|------|
| `--no-tools` | `-T` | 关闭工具调用（纯聊天模式） |
| `--no-search` | | 关闭元宝联网搜索 |
| `--think` | `-t` | 开启元宝深度思考模式 |
| `--new` | `-n` | 先新建元宝会话再开始 |
| `--timeout <秒>` | | 响应超时时间（默认 120s） |
| `--help` | `-h` | 显示帮助 |

### 交互模式内置命令

| 命令 | 说明 |
|------|------|
| `/new` | 在浏览器中开启新元宝会话 |
| `/clear` | 清除本地对话历史（不影响浏览器） |
| `/history` | 查看当前对话历史 |
| `/tools` | 切换工具调用开/关 |
| `/think` | 切换深度思考开/关 |
| `/search` | 切换联网搜索开/关 |
| `/help` | 显示帮助 |
| `/exit` 或 `/quit` | 退出 |

---

## 项目文件结构

```
test70_openCliAgent/
├── src/
│   ├── cli.ts              # CLI 入口，REPL 交互，参数解析，终端 UI
│   ├── agent.ts            # Agent 核心：ReAct 循环，对话历史管理，prompt 构建
│   ├── yuanbao-client.ts   # OpenCLI yuanbao 命令封装（ask / new），重试、容错逻辑
│   ├── tools.ts            # 内置工具：文件 I/O、网络搜索/抓取、shell、工具解析器
│   └── render.ts           # 终端 Markdown 渲染器（无第三方依赖）
├── dist/                   # TypeScript 编译输出（自动生成）
├── package.json
├── tsconfig.json
└── README.md
```

---

## 工具调用协议

Agent 会在系统提示中告知元宝可用工具，并要求 AI 使用以下格式发出工具调用：

````
```tool_call
{
  "tool": "shell",
  "input": { "command": "ls -la" }
}
```
````

Agent 解析到此格式后，本地执行工具，将结果追加到 prompt，再次调用 `opencli yuanbao ask` 继续推理，直到 AI 给出不含 `tool_call` 的最终回答。

---

## 示例场景

```bash
# 代码调试
node dist/cli.js "帮我查看 src/agent.ts 里有没有潜在的 bug"

# 文件操作
node dist/cli.js "在当前目录创建一个 hello.py，里面写一个打印斐波那契数列的函数"

# 系统信息
node dist/cli.js "查看当前系统的 Node.js 版本和已安装的全局 npm 包"

# 深度思考模式
node dist/cli.js --think --no-tools "分析微服务架构的优缺点"

# 新会话
node dist/cli.js --new "我们从头开始，帮我规划一个 Web 项目"

# 联网搜索（AI 自动调用 web_search 工具）
node dist/cli.js "杭州今天的天气怎么样，明天需要带伞吗"
node dist/cli.js "搜索最新的 TypeScript 5.5 发布说明并总结新特性"

# 读取网页内容
node dist/cli.js "帮我读取 https://github.com/jackwener/opencli 的 README 并总结"

# 组合任务：搜索 + 写文件
node dist/cli.js "搜索杭州到北京的高铁信息，整理成表格保存到 trains.md"
```

---

## 故障排查

| 错误 | 原因 | 解决 |
|------|------|------|
| `opencli is not installed` | opencli 未安装或不在 PATH | `npm install -g @jackwener/opencli` |
| 退出码 69：Browser Bridge not connected | Chrome 扩展未运行 | 确保 Chrome 已打开且扩展已启用 |
| 退出码 77：Not logged in | 元宝登录态失效 | 在 Chrome 中访问 yuanbao.tencent.com 重新登录 |
| 响应为空或超时 | 网络慢或元宝响应慢 | 增加 `--timeout 240` |
| `Yuanbao composer was not found` | 元宝页面刚打开，React 组件还未完成渲染 | Agent 会自动等待并重试（最多 4 次，间隔 4/6/8/10 秒），通常无需手动干预 |
| 工具调用无限循环 | AI 反复调用工具 | 默认最多 10 轮，可在 `Agent` 构造函数中调整 `maxIterations` |
