/**
 * Agent core — implements a ReAct (Reason + Act) loop.
 *
 * KEY DESIGN PRINCIPLE
 * ────────────────────
 * opencli yuanbao ask reuses the same Chrome browser tab across calls.
 * This means Yuanbao NATIVELY maintains conversation context between calls —
 * we must NOT inject conversation history into the prompt ourselves, because
 * that causes Yuanbao to respond to the injected history text rather than the
 * actual user question.
 *
 * What we send to Yuanbao each turn:
 *   • Turn 1 (tools off):  just the user message
 *   • Turn 1 (tools on):   user message + brief one-time tool instructions
 *   • Turn N (tools on):   user message only (AI already knows about tools)
 *   • After tool exec:     compact tool results + "please continue"
 */

import { ask, newChat, type AskOptions } from './yuanbao-client.js';
import {
  executeTool,
  parseToolCalls,
  hasToolCalls,
  TOOL_DEFINITIONS,
  type ToolCall,
  type ToolResult,
} from './tools.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface Message {
  role: 'user' | 'assistant' | 'tool_result';
  content: string;
}

export interface AgentOptions {
  /** Whether to enable internet search in Yuanbao (default: true) */
  search?: boolean;
  /** Whether to enable deep thinking mode (default: false) */
  think?: boolean;
  /** Whether tools are enabled (default: true) */
  toolsEnabled?: boolean;
  /** Max ReAct loop iterations to prevent infinite loops (default: 10) */
  maxIterations?: number;
  /** Response timeout in seconds (default: 120) */
  timeout?: number;
  /**
   * Browser Bridge profile alias to use when multiple Chrome profiles are connected.
   * Run `opencli profile list` to see options.
   */
  profile?: string;
  /** Called when a tool call is about to be executed */
  onToolCall?: (call: ToolCall) => void;
  /** Called when a tool result is received */
  onToolResult?: (result: ToolResult) => void;
  /** Called with streaming-style progress text */
  onProgress?: (text: string) => void;
}

export interface AgentResponse {
  ok: boolean;
  text: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  iterations: number;
  error?: string;
}

// ─── Prompt builders ───────────────────────────────────────────────────────────

/**
 * One-time tool instructions appended to the FIRST message when tools are
 * enabled. Kept compact to minimise noise in the conversation.
 */
function buildToolInstructions(): string {
  const toolList = TOOL_DEFINITIONS.map(
    (t) => `  • ${t.name} — ${t.description.split('.')[0]}`,
  ).join('\n');

  return `
(You have local tools available. Use them when needed by including a JSON block like this in your response:
\`\`\`tool_call
{"tool": "shell", "input": {"command": "ls"}}
\`\`\`
Available tools:
${toolList}

Rules: only call tools when necessary; give your final answer without any tool_call block once you have enough info.)`.trim();
}

/**
 * Build the text that gets sent to Yuanbao for the first iteration of a turn.
 *
 * Design goals:
 *  1. Keep messages short — don't inject full history (confuses Yuanbao).
 *  2. Add a ONE-LINE context breadcrumb from the last user message on
 *     non-first turns. This ensures Yuanbao retains context even if the
 *     browser session was disrupted by a transient error / page navigation.
 *  3. Append tool instructions only on the very first turn.
 */
function buildUserPrompt(
  userMessage: string,
  toolsEnabled: boolean,
  isFirstTurn: boolean,
  lastUserMessage?: string,      // the previous user message (for context breadcrumb)
): string {
  const parts: string[] = [];

  // Context breadcrumb — one line to anchor Yuanbao if browser state was reset
  if (!isFirstTurn && lastUserMessage) {
    const preview = lastUserMessage.split('\n')[0].slice(0, 120);
    parts.push(`[上文：${preview}]`);
    parts.push('');
  }

  parts.push(userMessage);

  // Tool instructions: once, at the very beginning of the session
  if (toolsEnabled && isFirstTurn) {
    parts.push('');
    parts.push(buildToolInstructions());
  }

  return parts.join('\n');
}

/**
 * Build the follow-up prompt sent after tool execution.
 * Kept compact to avoid polluting the context window.
 */
function buildToolResultPrompt(results: ToolResult[]): string {
  const MAX_OUTPUT = 3_000;

  const parts = results.map((r) => {
    if (r.error) {
      return `[${r.tool}] ERROR:\n${r.error.slice(0, 500)}`;
    }
    const out = r.output.length > MAX_OUTPUT
      ? r.output.slice(0, MAX_OUTPUT) + `\n...[truncated, ${r.output.length - MAX_OUTPUT} chars omitted]`
      : r.output;
    return `[${r.tool}] OUTPUT:\n${out}`;
  });

  return `Tool results:\n\n${parts.join('\n\n---\n\n')}\n\nPlease continue.`;
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export class Agent {
  /** Local display history — NOT sent to Yuanbao (browser keeps context). */
  private history: Message[] = [];

  private options: Required<
    Pick<AgentOptions, 'search' | 'think' | 'toolsEnabled' | 'maxIterations' | 'timeout'>
  > & { profile: string | undefined };

  private callbacks: Pick<AgentOptions, 'onToolCall' | 'onToolResult' | 'onProgress'>;

  constructor(options: AgentOptions = {}) {
    this.options = {
      search: options.search ?? true,
      think: options.think ?? false,
      toolsEnabled: options.toolsEnabled ?? true,
      maxIterations: options.maxIterations ?? 10,
      timeout: options.timeout ?? 120,
      profile: options.profile,
    };
    this.callbacks = {
      onToolCall: options.onToolCall,
      onToolResult: options.onToolResult,
      onProgress: options.onProgress,
    };
  }

  /** Reset local display history (browser session context is unaffected). */
  clearHistory(): void {
    this.history = [];
  }

  /** Start a brand-new Yuanbao conversation in the browser and clear local history. */
  async newConversation(): Promise<{ ok: boolean; error?: string }> {
    this.clearHistory();
    return newChat(this.options.profile);
  }

  /** Get local conversation history (for display purposes). */
  getHistory(): Message[] {
    return [...this.history];
  }

  /**
   * Send a user message and run the full ReAct loop until completion.
   *
   * On each iteration we send a SHORT message to Yuanbao — never injecting
   * history, because the browser tab already holds the full conversation.
   */
  async chat(userMessage: string): Promise<AgentResponse> {
    const allToolCalls: ToolCall[] = [];
    const allToolResults: ToolResult[] = [];
    let iterations = 0;
    let lastAssistantText = '';

    const isFirstTurn = this.history.length === 0;
    const askOptions: AskOptions = {
      timeout: this.options.timeout,
      search: this.options.search,
      think: this.options.think,
      profile: this.options.profile,
    };

    // Retrieve the last user message for context breadcrumbing
    const lastUserMessage = this.history
      .slice()
      .reverse()
      .find((m) => m.role === 'user')?.content;

    while (iterations < this.options.maxIterations) {
      iterations++;

      // What we actually send to Yuanbao this iteration
      let prompt: string;

      if (iterations === 1) {
        prompt = buildUserPrompt(
          userMessage,
          this.options.toolsEnabled,
          isFirstTurn,
          lastUserMessage,
        );
      } else {
        // Subsequent calls: compact tool results only
        prompt = buildToolResultPrompt(allToolResults.slice(-10));
      }

      this.callbacks.onProgress?.(`Asking Yuanbao (iteration ${iterations})...`);

      const result = await ask(prompt, askOptions, (attempt, waitSec) => {
        this.callbacks.onProgress?.(
          `Yuanbao page still loading — waiting ${waitSec}s before retry ${attempt}...`,
        );
      });

      if (!result.ok) {
        return {
          ok: false,
          text: '',
          toolCalls: allToolCalls,
          toolResults: allToolResults,
          iterations,
          error: result.error,
        };
      }

      lastAssistantText = result.text;

      // Check for tool calls in the response
      if (this.options.toolsEnabled && hasToolCalls(result.text)) {
        const calls = parseToolCalls(result.text);

        if (calls.length > 0) {
          allToolCalls.push(...calls);

          for (const call of calls) {
            this.callbacks.onToolCall?.(call);
            const toolResult = executeTool(call);
            allToolResults.push(toolResult);
            this.callbacks.onToolResult?.(toolResult);
          }

          continue; // loop back to send tool results
        }
      }

      // No tool calls — this is the final answer
      break;
    }

    // Record in local display history
    this.history.push({ role: 'user', content: userMessage });
    this.history.push({ role: 'assistant', content: lastAssistantText });

    return {
      ok: true,
      text: lastAssistantText,
      toolCalls: allToolCalls,
      toolResults: allToolResults,
      iterations,
    };
  }
}

/** Convenience function — create an agent and send one message. */
export async function runAgent(
  userMessage: string,
  options?: AgentOptions,
): Promise<AgentResponse> {
  const agent = new Agent(options);
  return agent.chat(userMessage);
}
