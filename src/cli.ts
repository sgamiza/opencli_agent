#!/usr/bin/env node
/**
 * OpenCLI Agent — interactive CLI entry point.
 *
 * Usage:
 *   node dist/cli.js             # Interactive chat mode
 *   node dist/cli.js "message"   # One-shot mode
 *   node dist/cli.js --no-tools  # Disable tool use
 *   node dist/cli.js --think     # Enable Yuanbao deep thinking
 *   node dist/cli.js --no-search # Disable Yuanbao internet search
 *   node dist/cli.js --new       # Start fresh conversation before chatting
 */

import * as readline from 'readline';
import { Agent } from './agent.js';
import { checkOpenCliInstalled, newChat, listProfiles, useProfile } from './yuanbao-client.js';
import { renderMarkdown } from './render.js';
import type { ToolCall, ToolResult } from './tools.js';

// ─── ANSI color helpers ───────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
  bgBlue: '\x1b[44m',
  bgGray: '\x1b[100m',
};

function color(text: string, ...codes: string[]): string {
  if (!process.stdout.isTTY) return text;
  return `${codes.join('')}${text}${C.reset}`;
}

// ─── CLI argument parsing ─────────────────────────────────────────────────────

interface CliArgs {
  message: string | null;
  toolsEnabled: boolean;
  search: boolean;
  think: boolean;
  startNew: boolean;
  timeout: number;
  profile: string | undefined;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const result: CliArgs = {
    message: null,
    toolsEnabled: true,
    search: true,
    think: false,
    startNew: false,
    timeout: 120,
    profile: undefined,
    help: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--no-tools':
      case '-T':
        result.toolsEnabled = false;
        break;
      case '--no-search':
        result.search = false;
        break;
      case '--think':
      case '-t':
        result.think = true;
        break;
      case '--new':
      case '-n':
        result.startNew = true;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      case '--timeout': {
        const next = args[++i];
        result.timeout = parseInt(next, 10) || 120;
        break;
      }
      case '--profile':
      case '-p': {
        result.profile = args[++i];
        break;
      }
      default:
        if (!arg.startsWith('-')) {
          positional.push(arg);
        }
    }
  }

  if (positional.length > 0) {
    result.message = positional.join(' ');
  }

  return result;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

const BANNER = `
${color('╔══════════════════════════════════════════╗', C.cyan)}
${color('║', C.cyan)}  ${color('OpenCLI Agent', C.bold + C.white)}  ${color('powered by Yuanbao', C.gray)}   ${color('║', C.cyan)}
${color('╚══════════════════════════════════════════╝', C.cyan)}
`;

function printHelp(): void {
  console.log(BANNER);
  console.log(`${color('USAGE', C.bold + C.yellow)}
  opencli-agent [message] [options]

${color('OPTIONS', C.bold + C.yellow)}
  --no-tools, -T      Disable tool use (pure chat mode)
  --no-search         Disable Yuanbao internet search
  --think, -t         Enable Yuanbao deep thinking mode
  --new, -n           Start a new Yuanbao conversation first
  --profile, -p <n>   Browser Bridge profile alias (required when multiple Chrome
                      profiles have the opencli extension active)
  --timeout <sec>     Response timeout in seconds (default: 120)
  --help, -h          Show this help

${color('INTERACTIVE COMMANDS', C.bold + C.yellow)}
  /new                Start a new conversation
  /clear              Clear conversation history (keep browser session)
  /history            Show conversation history
  /profiles           List connected Browser Bridge profiles
  /profile <name>     Switch to a different profile (persists via opencli profile use)
  /tools              Toggle tool use on/off
  /think              Toggle deep thinking on/off
  /search             Toggle internet search on/off
  /help               Show this help
  /exit, /quit        Exit the agent
  Ctrl+C              Exit

${color('EXAMPLES', C.bold + C.yellow)}
  opencli-agent                              # Interactive chat
  opencli-agent "What is the weather today?" # One-shot question
  opencli-agent --think "Explain quantum entanglement"
  opencli-agent --no-tools "Tell me a joke"
  opencli-agent --new "Start fresh and help me debug"
`);
}

function printToolCall(call: ToolCall): void {
  process.stdout.write(
    `\n${color('⚙', C.yellow)} ${color(`Tool: ${call.tool}`, C.bold + C.yellow)} `,
  );
  const inputPreview = JSON.stringify(call.input, null, 0);
  const preview = inputPreview.length > 80 ? inputPreview.slice(0, 77) + '...' : inputPreview;
  process.stdout.write(`${color(preview, C.gray)}\n`);
}

function printToolResult(result: ToolResult): void {
  if (result.error) {
    process.stdout.write(
      `${color('✗', C.red)} ${color(`${result.tool} error:`, C.red)} ${color(result.error.slice(0, 200), C.gray)}\n`,
    );
  } else {
    const lines = result.output.split('\n').length;
    process.stdout.write(
      `${color('✓', C.green)} ${color(`${result.tool}`, C.green)} ${color(`(${lines} lines)`, C.gray)}\n`,
    );
  }
}

function printAssistant(text: string): void {
  console.log('\n' + color('◆ Assistant', C.bold + C.cyan));
  console.log(color('─'.repeat(50), C.gray));
  console.log(renderMarkdown(text));
  console.log(color('─'.repeat(50), C.gray));
}

function printError(msg: string): void {
  console.error(`\n${color('✗ Error:', C.bold + C.red)} ${msg}\n`);
}

function printInfo(msg: string): void {
  console.log(`${color('ℹ', C.blue)} ${color(msg, C.gray)}`);
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

class Spinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private idx = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private text: string;
  private isTTY = process.stdout.isTTY;

  constructor(text = 'Thinking...') {
    this.text = text;
  }

  start(text?: string): void {
    if (text) this.text = text;
    if (!this.isTTY) {
      process.stdout.write(`${this.text}\n`);
      return;
    }
    this.timer = setInterval(() => {
      process.stdout.write(`\r${color(this.frames[this.idx % this.frames.length], C.cyan)} ${color(this.text, C.gray)}`);
      this.idx++;
    }, 80);
  }

  update(text: string): void {
    this.text = text;
  }

  stop(finalText?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.isTTY) {
      process.stdout.write('\r\x1b[K'); // Clear the line
    }
    if (finalText) {
      process.stdout.write(finalText + '\n');
    }
  }
}

// ─── Profile selector ─────────────────────────────────────────────────────────

/**
 * If multiple Browser Bridge profiles are connected and none is pre-selected,
 * prompt the user to pick one interactively before entering the REPL.
 * Returns the chosen profile id/alias, or undefined if none / single profile.
 */
async function promptProfileSelection(): Promise<string | undefined> {
  const { profiles, ok } = listProfiles();

  if (!ok || profiles.length <= 1) {
    // 0 = no profiles (let opencli report the error later)
    // 1 = single profile, opencli picks it automatically
    return undefined;
  }

  console.log(BANNER);
  console.log(color('⚠  Multiple Browser Bridge profiles detected.', C.bold + C.yellow));
  console.log(color('   Pick one to use for this session:\n', C.gray));

  profiles.forEach((p, i) => {
    console.log(`  ${color(String(i + 1), C.bold + C.cyan)}  ${p.label}`);
  });
  console.log();

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = () => {
      rl.question(
        color(`Enter number (1–${profiles.length}) or profile id: `, C.bold + C.blue),
        (answer) => {
          const trimmed = answer.trim();

          // Accept numeric choice
          const num = parseInt(trimmed, 10);
          if (!isNaN(num) && num >= 1 && num <= profiles.length) {
            rl.close();
            const chosen = profiles[num - 1].id;
            console.log(color(`\nUsing profile: ${chosen}\n`, C.gray));
            return resolve(chosen);
          }

          // Accept direct id/alias
          const byId = profiles.find((p) => p.id === trimmed);
          if (byId) {
            rl.close();
            console.log(color(`\nUsing profile: ${byId.id}\n`, C.gray));
            return resolve(byId.id);
          }

          console.log(color(`  Invalid choice — please enter a number between 1 and ${profiles.length}.`, C.red));
          ask();
        },
      );
    };
    ask();
  });
}

/**
 * Detect if an error message indicates a multi-profile conflict.
 */
function isMultiProfileError(errorText: string): boolean {
  return (
    errorText.includes('Multiple Browser Bridge profiles') ||
    (errorText.includes('BROWSER_CONNECT') && errorText.includes('profiles'))
  );
}

/**
 * When a multi-profile error occurs mid-session, interactively guide the user
 * to pick a profile. Returns the chosen profile or undefined if not resolved.
 */
async function handleProfileErrorInteractive(
  rl: readline.Interface,
  currentProfile: string | undefined,
): Promise<string | undefined> {
  const { profiles, ok, output } = listProfiles();

  if (!ok || profiles.length === 0) {
    printError('Could not list profiles. Run `opencli profile list` in your terminal.');
    return currentProfile;
  }

  console.log(color('\n── Available Browser Bridge Profiles ──', C.bold + C.yellow));
  profiles.forEach((p, i) => {
    console.log(`  ${color(String(i + 1), C.bold + C.cyan)}  ${p.label}`);
  });
  console.log();
  printInfo('Type /profile <name> to switch, or pick now:');

  return new Promise((resolve) => {
    rl.question(
      color(`Profile number/id (Enter to skip): `, C.bold + C.blue),
      (answer) => {
        const trimmed = answer.trim();
        if (!trimmed) return resolve(currentProfile);

        const num = parseInt(trimmed, 10);
        if (!isNaN(num) && num >= 1 && num <= profiles.length) {
          const chosen = profiles[num - 1].id;
          printInfo(`Profile set to "${chosen}" for this session.`);
          return resolve(chosen);
        }
        const byId = profiles.find((p) => p.id === trimmed);
        if (byId) {
          printInfo(`Profile set to "${byId.id}" for this session.`);
          return resolve(byId.id);
        }
        printInfo('No change — use /profile <name> to switch at any time.');
        return resolve(currentProfile);
      },
    );
  });
}

// ─── Interactive REPL ─────────────────────────────────────────────────────────

async function interactiveMode(agent: Agent, initialArgs: CliArgs): Promise<void> {
  console.log(BANNER);

  const flags = [];
  if (!initialArgs.toolsEnabled) flags.push('tools: off');
  if (initialArgs.think) flags.push('deep think: on');
  if (!initialArgs.search) flags.push('search: off');
  if (initialArgs.profile) flags.push(`profile: ${initialArgs.profile}`);

  if (flags.length > 0) {
    printInfo(`Active options: ${flags.join(', ')}`);
  }

  printInfo('Type /help for commands. Type your message and press Enter to chat.');
  printInfo('Tip: type /new to start a fresh Yuanbao conversation.');
  console.log();

  let toolsEnabled = initialArgs.toolsEnabled;
  let thinkEnabled = initialArgs.think;
  let searchEnabled = initialArgs.search;
  let activeProfile = initialArgs.profile;

  // Mutable reference so onProgress can always reach the current spinner.
  let activeSpinner: Spinner | null = null;

  // Recreate agent if settings change
  const makeAgent = () =>
    new Agent({
      search: searchEnabled,
      think: thinkEnabled,
      toolsEnabled,
      timeout: initialArgs.timeout,
      profile: activeProfile,
      onToolCall: printToolCall,
      onToolResult: printToolResult,
      onProgress: (text) => activeSpinner?.update(text),
    });

  let currentAgent = agent;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: color('You › ', C.bold + C.blue),
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // Handle slash commands
    if (input.startsWith('/')) {
      const [cmd, ...rest] = input.slice(1).split(' ');
      const arg = rest.join(' ');

      switch (cmd.toLowerCase()) {
        case 'new': {
          rl.pause();
          const spinner = new Spinner('Starting new conversation...');
          spinner.start();
          const result = await currentAgent.newConversation();
          spinner.stop();
          if (result.ok) {
            printInfo('New conversation started.');
          } else {
            printError(`Could not start new conversation: ${result.error}`);
          }
          break;
        }
        case 'clear':
          currentAgent.clearHistory();
          printInfo('Conversation history cleared (browser session preserved).');
          break;
        case 'history': {
          const history = currentAgent.getHistory();
          if (history.length === 0) {
            printInfo('No conversation history yet.');
          } else {
            console.log(color('\n── Conversation History ──', C.bold + C.yellow));
            for (const msg of history) {
              const roleLabel = msg.role === 'user' ? color('User', C.blue) : color('Assistant', C.cyan);
              const preview = msg.content.slice(0, 200) + (msg.content.length > 200 ? '...' : '');
              console.log(`${roleLabel}: ${color(preview, C.gray)}`);
            }
            console.log();
          }
          break;
        }
        case 'profiles': {
          const pr = listProfiles();
          if (pr.output) {
            console.log(color('\n── Connected Browser Bridge Profiles ──', C.bold + C.yellow));
            console.log(pr.output);
            console.log(color(`Active profile: ${activeProfile ?? '(default / auto)'}`, C.gray));
            console.log();
          } else {
            printError(pr.error ?? 'Could not list profiles.');
          }
          break;
        }
        case 'profile': {
          if (!arg) {
            printError('Usage: /profile <name>  — run /profiles to list available profiles.');
            break;
          }
          rl.pause();
          const setResult = useProfile(arg);
          rl.resume();
          if (setResult.ok) {
            activeProfile = arg;
            currentAgent = makeAgent();
            printInfo(`Profile set to "${arg}" (persists via opencli profile use).`);
          } else {
            printError(`Could not set profile "${arg}": ${setResult.error}`);
          }
          break;
        }
        case 'tools':
          toolsEnabled = !toolsEnabled;
          currentAgent = makeAgent();
          printInfo(`Tool use ${toolsEnabled ? 'enabled' : 'disabled'}.`);
          break;
        case 'think':
          thinkEnabled = !thinkEnabled;
          currentAgent = makeAgent();
          printInfo(`Deep thinking ${thinkEnabled ? 'enabled' : 'disabled'}.`);
          break;
        case 'search':
          searchEnabled = !searchEnabled;
          currentAgent = makeAgent();
          printInfo(`Internet search ${searchEnabled ? 'enabled' : 'disabled'}.`);
          break;
        case 'help':
          printHelp();
          break;
        case 'exit':
        case 'quit':
          console.log(color('\nGoodbye!\n', C.gray));
          rl.close();
          process.exit(0);
          break;
        default:
          printError(`Unknown command: /${cmd}. Type /help for available commands.`);
      }

      rl.prompt();
      return;
    }

    // Regular message
    rl.pause();
    const spinner = new Spinner('Thinking...');
    activeSpinner = spinner;
    spinner.start();

    try {
      const response = await currentAgent.chat(input);
      activeSpinner = null;
      spinner.stop();

      if (!response.ok) {
        const errorText = response.error ?? 'Unknown error from Yuanbao.';

        if (isMultiProfileError(errorText)) {
          // Guide user through interactive profile selection
          printError('Profile conflict detected. Please select a Browser Bridge profile:');
          const chosen = await handleProfileErrorInteractive(rl, activeProfile);
          if (chosen && chosen !== activeProfile) {
            activeProfile = chosen;
            currentAgent = makeAgent();
            printInfo(`Retrying with profile "${chosen}"...`);
            // Retry the same message with the new profile
            const retrySpinner = new Spinner('Retrying...');
            retrySpinner.start();
            const retry = await currentAgent.chat(input);
            retrySpinner.stop();
            if (retry.ok) {
              printAssistant(retry.text);
            } else {
              printError(retry.error ?? 'Retry failed.');
            }
          } else {
            printError(errorText);
          }
        } else {
          printError(errorText);
        }
      } else {
        if (response.iterations > 1 || response.toolCalls.length > 0) {
          printInfo(
            `Completed in ${response.iterations} iteration(s), ${response.toolCalls.length} tool call(s).`,
          );
        }
        printAssistant(response.text);
      }
    } catch (err) {
      activeSpinner = null;
      spinner.stop();
      printError(String(err));
    }

    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(color('\nGoodbye!\n', C.gray));
    process.exit(0);
  });
}

// ─── One-shot mode ────────────────────────────────────────────────────────────

async function oneShotMode(agent: Agent, message: string): Promise<void> {
  const spinner = new Spinner('Asking Yuanbao...');
  spinner.start();

  const response = await agent.chat(message);
  spinner.stop();

  if (!response.ok) {
    printError(response.error ?? 'Unknown error from Yuanbao.');
    process.exit(1);
  }

  console.log(response.text);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Verify opencli is installed
  if (!checkOpenCliInstalled()) {
    printError(
      'opencli is not installed or not found in PATH.\n' +
      'Install it with: npm install -g @jackwener/opencli\n' +
      'Then ensure Chrome is running with the OpenCLI Browser Bridge extension installed.',
    );
    process.exit(1);
  }

  // Auto-detect multi-profile conflict at startup (only in interactive mode, no --profile given)
  if (!args.message && !args.profile) {
    const autoProfile = await promptProfileSelection();
    if (autoProfile) {
      args.profile = autoProfile;
    }
  }

  // Optionally start a new Yuanbao conversation
  if (args.startNew) {
    printInfo('Starting new Yuanbao conversation...');
    const result = await newChat(args.profile);
    if (!result.ok) {
      printError(`Could not start new conversation: ${result.error}`);
      // Continue anyway — the existing session might still work
    } else {
      printInfo('New conversation started.');
    }
  }

  const agent = new Agent({
    search: args.search,
    think: args.think,
    toolsEnabled: args.toolsEnabled,
    timeout: args.timeout,
    profile: args.profile,
    onToolCall: printToolCall,
    onToolResult: printToolResult,
  });

  if (args.message) {
    await oneShotMode(agent, args.message);
  } else {
    await interactiveMode(agent, args);
  }
}

main().catch((err) => {
  console.error(color('Fatal error:', C.bold + C.red), String(err));
  process.exit(1);
});
