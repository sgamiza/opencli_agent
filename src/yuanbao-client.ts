/**
 * YuanbaoClient — wraps `opencli yuanbao` CLI commands.
 *
 * Conversation continuity relies on the fact that opencli reuses the same
 * Chrome/Chromium session. Calling `ask` multiple times without `new` will
 * continue in the same Yuanbao chat window.
 *
 * Why cross-spawn?
 * ─────────────────
 * On Windows, npm global binaries are `.cmd` batch files. Node's built-in
 * spawnSync with `shell: true` concatenates all args with spaces before
 * handing off to cmd.exe, which means a prompt like "你好 世界" becomes two
 * separate positional arguments and opencli throws "too many arguments".
 * cross-spawn fixes this by:
 *   1. Detecting `.cmd` wrappers and routing through cmd.exe properly.
 *   2. Using `shell: false` semantics so each array element stays as one arg.
 */

import crossSpawn from 'cross-spawn';

export interface AskOptions {
  /** Max seconds to wait for a response (default: 120) */
  timeout?: number;
  /** Enable internet search (default: true) */
  search?: boolean;
  /** Enable deep thinking mode (default: false) */
  think?: boolean;
  /**
   * Browser Bridge profile alias or contextId to use.
   * Required when multiple Chrome profiles have the opencli extension active.
   * Run `opencli profile list` to see available profiles, then pass the alias
   * or contextId here (or set OPENCLI_PROFILE env var as a permanent default).
   */
  profile?: string;
}

export interface AskResult {
  ok: boolean;
  text: string;
  error?: string;
}

export interface NewChatResult {
  ok: boolean;
  error?: string;
}

export interface ProfileInfo {
  /** Raw contextId or alias returned by opencli */
  id: string;
  /** Human-readable label shown in `opencli profile list` output */
  label: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Spawn `opencli` with the given args, properly handling the Windows .cmd
 * wrapper. Each element in `args` is passed as a distinct argument — no shell
 * word-splitting occurs regardless of spaces or special characters in values.
 */
function spawnOpencli(
  args: string[],
  timeoutMs: number,
  profile?: string,
): ReturnType<typeof crossSpawn.sync> {
  // Prepend --profile before the subcommand when specified.
  // opencli expects: opencli --profile <name> yuanbao ask ...
  const fullArgs = profile ? ['--profile', profile, ...args] : args;

  return crossSpawn.sync('opencli', fullArgs, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * Build an actionable error message from an opencli non-zero exit.
 */
function buildErrorMessage(exitCode: number | null, rawOutput: string): string {
  const base = rawOutput.trim();

  switch (exitCode) {
    case 69: {
      // EX_UNAVAILABLE — could be "not connected" OR "multiple profiles"
      const isMultiProfile =
        base.includes('Multiple Browser Bridge profiles') ||
        base.includes('multiple') ||
        base.includes('profiles are connected');

      if (isMultiProfile) {
        return (
          `${base}\n\n` +
          `Fix: run \`opencli profile list\` to see connected profiles, then either:\n` +
          `  • Start the agent with  --profile <name>\n` +
          `  • Set a permanent default with  opencli profile use <name>\n` +
          `  • Or set the env var  OPENCLI_PROFILE=<name>`
        );
      }
      return (
        `${base}\n\n` +
        `Fix: make sure Chrome is running and the OpenCLI Browser Bridge extension is installed and enabled.\n` +
        `Run \`opencli doctor\` to diagnose connection issues.`
      );
    }
    case 77:
      return (
        `${base}\n\n` +
        `Fix: open https://yuanbao.tencent.com in Chrome and log in, then retry.`
      );
    default:
      // CDP "Promise was collected" or other transient browser errors
      if (
        base.includes('Promise was collected') ||
        base.includes('"Promise was collected"')
      ) {
        return (
          `${base}\n\n` +
          `This is a transient browser automation error (the Yuanbao page navigated ` +
          `while opencli was waiting). Your message was likely NOT sent.\n` +
          `Please try sending your message again.`
        );
      }
      return base;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if opencli is installed and accessible.
 */
export function checkOpenCliInstalled(): boolean {
  try {
    const result = spawnOpencli(['--version'], 5_000);
    return (
      result.status === 0 ||
      String(result.stdout).includes('opencli') ||
      String(result.stderr).includes('opencli')
    );
  } catch {
    return false;
  }
}

/**
 * List connected Browser Bridge profiles.
 * Returns both the raw text output and a parsed array of profiles.
 *
 * Note: `opencli profile list` works even when multiple profiles are connected
 * (it is the meta-command that does not require a profile to be pre-selected).
 */
export function listProfiles(): {
  ok: boolean;
  output: string;
  profiles: ProfileInfo[];
  error?: string;
} {
  try {
    const result = spawnOpencli(['profile', 'list'], 10_000);
    const output = String(result.stdout || result.stderr || '').trim();
    const profiles = parseProfileListOutput(output);
    return { ok: result.status === 0, output, profiles };
  } catch (err) {
    return { ok: false, output: '', profiles: [], error: String(err) };
  }
}

/**
 * Parse the text output of `opencli profile list` into a structured array.
 *
 * Example output:
 *   Connected Browser Bridge profiles
 *     y2rw92n4 — connected v1.0.5
 *     j9ptmwkt — connected v1.0.5
 */
function parseProfileListOutput(output: string): ProfileInfo[] {
  const profiles: ProfileInfo[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase().startsWith('connected browser')) continue;
    // Match lines like: "y2rw92n4 — connected v1.0.5"
    // or with an alias: "work (y2rw92n4) — connected v1.0.5"
    const match = trimmed.match(/^(\S+)/);
    if (match) {
      profiles.push({ id: match[1], label: trimmed });
    }
  }
  return profiles;
}

/**
 * Set the default profile for future opencli calls (persists across sessions).
 * Equivalent to `opencli profile use <name>`.
 */
export function useProfile(name: string): { ok: boolean; error?: string } {
  try {
    const result = spawnOpencli(['profile', 'use', name], 10_000);
    if (result.status !== 0) {
      return {
        ok: false,
        error: String(result.stderr || result.stdout || '').trim(),
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Start a new Yuanbao chat session.
 * Navigates to a fresh conversation in the browser.
 */
export function newChat(profile?: string): NewChatResult {
  try {
    const result = spawnOpencli(['yuanbao', 'new'], 30_000, profile);

    if (result.status !== 0) {
      const errorMsg = buildErrorMessage(
        result.status,
        String(result.stderr || result.stdout || 'Unknown error from opencli yuanbao new'),
      );
      return { ok: false, error: errorMsg };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── Response validation ──────────────────────────────────────────────────────

/**
 * Yuanbao UI phrases / patterns that should never appear in a real AI response.
 * If found, opencli captured page chrome or a loading state instead of the reply.
 */
const UI_GARBAGE_PHRASES = [
  '点击全选以下消息',
  '点击全选',
  '有问题，尽管问，shift+enter换行',
  '下载元宝电脑版',
  '立即创建团队',
  '扫码默认已阅读',
  '重新回答',
];

// Yuanbao loading/spinner image URLs (only images, no real content)
const LOADING_IMAGE_RE = /^!\[.*?\]\(https?:\/\/static\.yuanbao\.tencent\.com[^)]*\)\s*$/;

function isGarbageResponse(text: string): boolean {
  const trimmed = text.trim();
  // Only an image markdown with no other text → loading state
  if (LOADING_IMAGE_RE.test(trimmed)) return true;
  // Response consists entirely of image tags (multiple loading images)
  if (trimmed && trimmed.replace(/!\[.*?\]\([^)]+\)/g, '').trim() === '') return true;

  for (const phrase of UI_GARBAGE_PHRASES) {
    if (text.includes(phrase)) return true;
  }
  return false;
}

// ─── Retry helpers ────────────────────────────────────────────────────────────

/**
 * Errors that are worth retrying — these are transient browser-automation
 * issues where the message was NOT submitted yet (safe to retry).
 */
function isRetryableError(rawOutput: string): boolean {
  // Composer not yet visible — page still loading
  if (
    rawOutput.includes('composer was not found') ||
    rawOutput.includes('Yuanbao composer was not found') ||
    (rawOutput.includes('composer') && rawOutput.includes('not found'))
  ) return true;

  // CDP "Promise was collected" — browser navigated mid-operation.
  // This typically fires BEFORE the message is submitted (navigation
  // interrupted the pre-send phase), so retrying is safe.
  if (
    rawOutput.includes('Promise was collected') ||
    rawOutput.includes('"Promise was collected"')
  ) return true;

  return false;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Public ask ───────────────────────────────────────────────────────────────

/**
 * Send a prompt to the Yuanbao chat and wait for the response.
 * Continues in the current conversation unless `newChat()` was called first.
 *
 * Automatically retries when the page compositor is not yet ready (e.g. right
 * after the browser opens a new Yuanbao tab and the React components are still
 * mounting). Retries up to MAX_RETRIES times with exponential back-off.
 */
export async function ask(
  prompt: string,
  options: AskOptions = {},
  onRetry?: (attempt: number, waitSec: number) => void,
): Promise<AskResult> {
  const { timeout = 120, search = true, think = false, profile } = options;

  const MAX_RETRIES = 4;
  // Back-off delays in seconds: 4, 6, 8, 10
  const RETRY_DELAYS = [4, 6, 8, 10];

  const args = [
    'yuanbao',
    'ask',
    prompt,
    '--timeout', String(timeout),
    '--search',  String(search),
    '--think',   String(think),
    '--format',  'json',
  ];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = spawnOpencli(args, (timeout + 30) * 1_000, profile);

    if (result.status === 0) {
      const rawOutput = String(result.stdout || '').trim();
      const text = parseYuanbaoJsonOutput(rawOutput);

      // Guard: if the parsed text looks like Yuanbao UI chrome rather than an
      // actual AI reply, treat it as a transient failure and retry.
      if (isGarbageResponse(text)) {
        if (attempt >= MAX_RETRIES) {
          return {
            ok: false,
            text: '',
            error:
              'Yuanbao returned page UI text instead of an AI response.\n' +
              'The page may still be loading or the AI response DOM selector ' +
              'has changed in a recent Yuanbao update.\n\n' +
              'Tips:\n' +
              '  • Wait a few seconds and send your message again\n' +
              '  • Type /new to start a fresh Yuanbao conversation\n' +
              '  • Make sure yuanbao.tencent.com is fully loaded in Chrome',
          };
        }
        const waitSec = RETRY_DELAYS[attempt] ?? 10;
        onRetry?.(attempt + 1, waitSec);
        await sleep(waitSec * 1_000);
        continue;
      }

      return { ok: true, text };
    }

    const rawOutput = String(result.stderr || result.stdout || '').trim();

    // Only retry on "composer not found" — all other errors surface immediately.
    if (!isRetryableError(rawOutput) || attempt >= MAX_RETRIES) {
      return { ok: false, text: '', error: buildErrorMessage(result.status, rawOutput) };
    }

    const waitSec = RETRY_DELAYS[attempt] ?? 10;
    onRetry?.(attempt + 1, waitSec);
    await sleep(waitSec * 1_000);
  }

  // Should never reach here, but satisfy TypeScript.
  return { ok: false, text: '', error: 'Max retries exceeded' };
}

// ─── Output parser ────────────────────────────────────────────────────────────

/**
 * Extract the assistant's reply from opencli yuanbao ask output.
 *
 * opencli can return several formats depending on flags and version:
 *
 *   JSON (--format json):
 *     [{"Role":"User","Text":"..."},{"Role":"Assistant","Text":"..."}]
 *
 *   Plain / table (default or fallback):
 *     Role: User
 *     Text: ...
 *
 *     Role: Assistant
 *     Text: ...
 *
 * We try JSON first; fall back to plain-text extraction; fall back to raw.
 */
function parseYuanbaoJsonOutput(raw: string): string {
  if (!raw) return '';

  // ── 1. Try JSON format ──────────────────────────────────────────────────────
  try {
    // The JSON array may be preceded by debug/verbose lines.
    // Find the LAST occurrence of a JSON array in the output.
    const jsonMatch = raw.match(/(\[[\s\S]*?\])\s*$/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]) as Array<{ Role: string; Text: string }>;
      const assistantMessages = parsed.filter(
        (m) => m.Role?.toLowerCase() === 'assistant' && m.Text,
      );
      if (assistantMessages.length > 0) {
        return assistantMessages[assistantMessages.length - 1].Text.trim();
      }
    }
  } catch {
    // not valid JSON — try next format
  }

  // ── 2. Try plain/table format ───────────────────────────────────────────────
  // Match "Role: Assistant\nText: <content up to next Role: block or end>"
  const plainMatches = [...raw.matchAll(/Role:\s*Assistant\s*\nText:\s*([\s\S]*?)(?=\n\s*Role:|$)/gi)];
  if (plainMatches.length > 0) {
    return plainMatches[plainMatches.length - 1][1].trim();
  }

  // ── 3. Raw fallback ─────────────────────────────────────────────────────────
  return raw;
}
