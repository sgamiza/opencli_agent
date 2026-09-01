/**
 * Built-in tools available to the agent.
 *
 * The AI is prompted to emit tool calls in a structured JSON block.
 * This module implements the tool execution layer.
 *
 * Tool groups:
 *   File I/O  — read_file, write_file, append_file, delete_file, list_dir, search_files
 *   Web       — web_search, web_fetch
 *   Shell     — shell
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

// ─── Tool definitions ─────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool: string;
  output: string;
  error?: string;
}

// ─── Available tools ─────────────────────────────────────────────────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ── Shell ──────────────────────────────────────────────────────────────────
  {
    name: 'shell',
    description:
      'Run a shell command and return its stdout/stderr. ' +
      'Use for running scripts, git, npm/pip, system commands, etc.',
    parameters: {
      command: { type: 'string', description: 'The shell command to execute', required: true },
      cwd:     { type: 'string', description: 'Working directory (optional)' },
    },
  },

  // ── File I/O ───────────────────────────────────────────────────────────────
  {
    name: 'read_file',
    description: 'Read the full contents of a file and return it as text.',
    parameters: {
      path:   { type: 'string', description: 'Absolute or relative file path', required: true },
      offset: { type: 'number', description: 'Line number to start reading from (1-based, optional)' },
      limit:  { type: 'number', description: 'Max number of lines to read (optional)' },
    },
  },
  {
    name: 'write_file',
    description: 'Write (or overwrite) a file. Creates the file and any missing parent directories.',
    parameters: {
      path:    { type: 'string', description: 'File path to write', required: true },
      content: { type: 'string', description: 'Content to write', required: true },
    },
  },
  {
    name: 'append_file',
    description: 'Append text to the end of a file. Creates the file if it does not exist.',
    parameters: {
      path:    { type: 'string', description: 'File path to append to', required: true },
      content: { type: 'string', description: 'Content to append', required: true },
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file or an empty directory.',
    parameters: {
      path: { type: 'string', description: 'Path to the file or directory to delete', required: true },
    },
  },
  {
    name: 'list_dir',
    description: 'List files and directories in a folder with sizes.',
    parameters: {
      path:      { type: 'string', description: 'Directory path (defaults to current directory)' },
      recursive: { type: 'boolean', description: 'If true, list all files recursively (default: false)' },
    },
  },
  {
    name: 'search_files',
    description:
      'Search for files by name pattern, or search text/regex within file contents. ' +
      'Returns matching file paths (and line numbers when searching content).',
    parameters: {
      pattern:        { type: 'string',  description: 'Text, regex, or filename glob to search for', required: true },
      directory:      { type: 'string',  description: 'Root directory to search in (defaults to cwd)' },
      search_content: { type: 'boolean', description: 'If true, search file contents; if false, search filenames (default: false)' },
      include:        { type: 'string',  description: 'Glob to filter files when searching content (e.g. "*.ts")' },
    },
  },

  // ── Web ────────────────────────────────────────────────────────────────────
  {
    name: 'web_search',
    description:
      'Search the web and return a list of relevant results (title, URL, snippet). ' +
      'Use this to find current information, news, documentation, or anything requiring internet access.',
    parameters: {
      query:  { type: 'string', description: 'The search query', required: true },
      count:  { type: 'number', description: 'Max results to return (default: 8, max: 20)' },
    },
  },
  {
    name: 'web_fetch',
    description:
      'Fetch the content of a URL and return it as readable plain text (HTML stripped). ' +
      'Use this to read a specific web page, documentation, or article.',
    parameters: {
      url:       { type: 'string', description: 'Full URL to fetch (https://...)', required: true },
      max_chars: { type: 'number', description: 'Max characters to return (default: 8000)' },
    },
  },
];

// ─── Tool executor ────────────────────────────────────────────────────────────

const MAX_OUTPUT_LENGTH = 8000;

function truncate(text: string, maxLen = MAX_OUTPUT_LENGTH): string {
  if (text.length <= maxLen) return text;
  const half = Math.floor(maxLen / 2);
  return `${text.slice(0, half)}\n...[output truncated, ${text.length - maxLen} chars omitted]...\n${text.slice(-half)}`;
}

export function executeTool(call: ToolCall): ToolResult {
  try {
    switch (call.tool) {
      case 'shell':        return executeShell(call);
      case 'read_file':    return executeReadFile(call);
      case 'write_file':   return executeWriteFile(call);
      case 'append_file':  return executeAppendFile(call);
      case 'delete_file':  return executeDeleteFile(call);
      case 'list_dir':     return executeListDir(call);
      case 'search_files': return executeSearchFiles(call);
      case 'web_search':   return executeWebSearch(call);
      case 'web_fetch':    return executeWebFetch(call);
      default:
        return {
          tool: call.tool, output: '',
          error: `Unknown tool: "${call.tool}". Available: ${TOOL_DEFINITIONS.map((t) => t.name).join(', ')}`,
        };
    }
  } catch (err) {
    return { tool: call.tool, output: '', error: String(err) };
  }
}

// ─── Shell ────────────────────────────────────────────────────────────────────

function executeShell(call: ToolCall): ToolResult {
  const command = String(call.input.command || '');
  const cwd = call.input.cwd ? String(call.input.cwd) : process.cwd();

  if (!command.trim()) return { tool: call.tool, output: '', error: 'No command provided' };

  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { tool: call.tool, output: truncate(output.trim()) };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const combined = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim();
    return { tool: call.tool, output: '', error: truncate(combined || String(err)) };
  }
}

// ─── File I/O ─────────────────────────────────────────────────────────────────

function executeReadFile(call: ToolCall): ToolResult {
  const filePath = String(call.input.path || '');
  if (!filePath) return { tool: call.tool, output: '', error: 'No path provided' };

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return { tool: call.tool, output: '', error: `File not found: ${resolved}` };

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) return { tool: call.tool, output: '', error: `Path is a directory: ${resolved}` };

  const rawContent = fs.readFileSync(resolved, 'utf8');
  const lines = rawContent.split('\n');

  const offset = call.input.offset ? Math.max(1, Number(call.input.offset)) : 1;
  const limit  = call.input.limit  ? Number(call.input.limit) : undefined;

  const sliced = limit
    ? lines.slice(offset - 1, offset - 1 + limit)
    : lines.slice(offset - 1);

  const totalLines = lines.length;
  const header = `File: ${resolved} (${totalLines} lines total, showing ${offset}–${offset + sliced.length - 1})\n`;

  return { tool: call.tool, output: truncate(header + sliced.join('\n')) };
}

function executeWriteFile(call: ToolCall): ToolResult {
  const filePath = String(call.input.path || '');
  const content  = String(call.input.content ?? '');
  if (!filePath) return { tool: call.tool, output: '', error: 'No path provided' };

  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf8');
  return { tool: call.tool, output: `Wrote ${content.length} chars (${content.split('\n').length} lines) to ${resolved}` };
}

function executeAppendFile(call: ToolCall): ToolResult {
  const filePath = String(call.input.path || '');
  const content  = String(call.input.content ?? '');
  if (!filePath) return { tool: call.tool, output: '', error: 'No path provided' };

  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.appendFileSync(resolved, content, 'utf8');
  return { tool: call.tool, output: `Appended ${content.length} chars to ${resolved}` };
}

function executeDeleteFile(call: ToolCall): ToolResult {
  const filePath = String(call.input.path || '');
  if (!filePath) return { tool: call.tool, output: '', error: 'No path provided' };

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return { tool: call.tool, output: '', error: `Not found: ${resolved}` };

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    fs.rmdirSync(resolved);
    return { tool: call.tool, output: `Deleted directory: ${resolved}` };
  }
  fs.unlinkSync(resolved);
  return { tool: call.tool, output: `Deleted file: ${resolved}` };
}

function executeListDir(call: ToolCall): ToolResult {
  const dirPath   = call.input.path ? String(call.input.path) : process.cwd();
  const recursive = Boolean(call.input.recursive);
  const resolved  = path.resolve(dirPath);

  if (!fs.existsSync(resolved)) return { tool: call.tool, output: '', error: `Directory not found: ${resolved}` };

  if (recursive) {
    const lines: string[] = [`Contents of ${resolved} (recursive):`];
    walkDir(resolved, resolved, lines, 0);
    return { tool: call.tool, output: truncate(lines.join('\n')) };
  }

  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  const lines = entries.map((e) => {
    if (e.isDirectory()) return `DIR   ${e.name}/`;
    const size = fs.statSync(path.join(resolved, e.name)).size;
    return `FILE  ${e.name}  (${formatBytes(size)})`;
  });
  return { tool: call.tool, output: `Contents of ${resolved}:\n${lines.join('\n')}` };
}

function walkDir(root: string, dir: string, lines: string[], depth: number): void {
  if (depth > 6) return; // guard against deep trees
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const rel = path.relative(root, path.join(dir, e.name));
    const indent = '  '.repeat(depth);
    if (e.isDirectory()) {
      lines.push(`${indent}${e.name}/`);
      walkDir(root, path.join(dir, e.name), lines, depth + 1);
    } else {
      const size = fs.statSync(path.join(dir, e.name)).size;
      lines.push(`${indent}${e.name}  (${formatBytes(size)})`);
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function executeSearchFiles(call: ToolCall): ToolResult {
  const pattern       = String(call.input.pattern || '');
  const directory     = call.input.directory ? String(call.input.directory) : process.cwd();
  const searchContent = Boolean(call.input.search_content);
  const include       = call.input.include ? String(call.input.include) : '';

  if (!pattern) return { tool: call.tool, output: '', error: 'No search pattern provided' };

  const resolvedDir = path.resolve(directory);

  if (searchContent) {
    // Try ripgrep first, fall back to pure-Node recursive grep
    try {
      const includeFlag = include ? `--glob ${JSON.stringify(include)}` : '';
      const output = execSync(
        `rg --no-heading -n ${includeFlag} ${JSON.stringify(pattern)} ${JSON.stringify(resolvedDir)}`,
        { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return { tool: call.tool, output: truncate(output.trim()) || 'No matches found.' };
    } catch {
      // ripgrep not available or no matches → pure-Node fallback
      const matches = nodeGrepDir(resolvedDir, pattern, include);
      return {
        tool: call.tool,
        output: matches.length > 0 ? truncate(matches.join('\n')) : 'No matches found.',
      };
    }
  }

  // Search by filename
  const matches = findFilesNamed(resolvedDir, pattern);
  return {
    tool: call.tool,
    output: matches.length > 0 ? truncate(matches.join('\n')) : 'No matching files found.',
  };
}

function findFilesNamed(dir: string, pattern: string, results: string[] = [], depth = 0): string[] {
  if (depth > 8) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.includes(pattern)) results.push(path.join(dir, e.name));
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        findFilesNamed(path.join(dir, e.name), pattern, results, depth + 1);
      }
    }
  } catch { /* skip inaccessible dirs */ }
  return results;
}

function nodeGrepDir(dir: string, pattern: string, include: string, results: string[] = [], depth = 0): string[] {
  if (depth > 8) return results;
  let re: RegExp;
  try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const fullPath = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        nodeGrepDir(fullPath, pattern, include, results, depth + 1);
      } else if (e.isFile()) {
        if (include && !matchGlob(e.name, include)) continue;
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) results.push(`${fullPath}:${i + 1}: ${lines[i].trim()}`);
          }
        } catch { /* skip unreadable files */ }
      }
    }
  } catch { /* skip inaccessible dirs */ }
  return results;
}

function matchGlob(name: string, glob: string): boolean {
  const pattern = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`, 'i').test(name);
}

// ─── Web tools ────────────────────────────────────────────────────────────────

/**
 * Perform an HTTP GET, respecting HTTP_PROXY / HTTPS_PROXY env vars.
 * Returns raw response body as string.
 */
function httpGet(url: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
    const parsed = new URL(url);

    let requestFn: typeof http.get | typeof https.get;
    let options: http.RequestOptions;

    if (proxy) {
      const proxyUrl = new URL(proxy);
      requestFn = proxyUrl.protocol === 'https:' ? https.get : http.get;
      options = {
        host: proxyUrl.hostname,
        port: parseInt(proxyUrl.port || '8080', 10),
        path: url, // absolute URL as path when going through proxy
        headers: {
          'Host': parsed.hostname,
          'User-Agent': 'Mozilla/5.0 (compatible; opencli-agent/1.0)',
          'Accept': 'text/html,application/json,*/*',
        },
        timeout: timeoutMs,
      };
    } else {
      requestFn = parsed.protocol === 'https:' ? https.get : http.get;
      options = {
        host: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; opencli-agent/1.0)',
          'Accept': 'text/html,application/json,*/*',
        },
        timeout: timeoutMs,
      };
    }

    const req = requestFn(options, (res) => {
      // Follow redirects (max 5)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timed out: ${url}`)); });
  });
}

/** Strip HTML tags and decode common entities, returning clean text. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function executeWebSearch(call: ToolCall): ToolResult {
  const query = String(call.input.query || '').trim();
  if (!query) return { tool: call.tool, output: '', error: 'No query provided' };

  const count = Math.min(Number(call.input.count) || 8, 20);

  try {
    // Use DuckDuckGo Lite (simple HTML, no JS required, works behind proxy)
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&kl=cn-zh`;
    const html = execSync(
      buildCurlCmd(url, '--max-time 20'),
      { encoding: 'utf8', timeout: 25_000 },
    );
    const results = parseDDGLite(html, count);
    if (results.length > 0) {
      return { tool: call.tool, output: formatSearchResults(query, results) };
    }

    // Fallback: DuckDuckGo instant answer API
    const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&no_redirect=1`;
    const json = execSync(buildCurlCmd(apiUrl, '--max-time 15'), { encoding: 'utf8', timeout: 20_000 });
    const instant = parseDDGInstant(json);
    if (instant) return { tool: call.tool, output: instant };

    return { tool: call.tool, output: `No results found for: ${query}` };
  } catch (err) {
    return { tool: call.tool, output: '', error: `Web search failed: ${String(err)}` };
  }
}

function executeWebFetch(call: ToolCall): ToolResult {
  const url      = String(call.input.url || '').trim();
  const maxChars = Number(call.input.max_chars) || 8000;

  if (!url) return { tool: call.tool, output: '', error: 'No URL provided' };
  if (!url.startsWith('http')) return { tool: call.tool, output: '', error: 'URL must start with http:// or https://' };

  try {
    const html = execSync(
      buildCurlCmd(url, '--max-time 30 -L'),
      { encoding: 'utf8', timeout: 35_000 },
    );
    const text = htmlToText(html);
    const trimmed = text.slice(0, maxChars);
    const note = text.length > maxChars ? `\n\n[Page truncated at ${maxChars} chars. Full length: ${text.length}]` : '';
    return { tool: call.tool, output: `Content of ${url}:\n\n${trimmed}${note}` };
  } catch (err) {
    return { tool: call.tool, output: '', error: `Failed to fetch ${url}: ${String(err)}` };
  }
}

/**
 * Build a curl command that forwards HTTP_PROXY/HTTPS_PROXY.
 * Uses `curl.exe` explicitly because on Windows PowerShell, `curl` is an
 * alias for Invoke-WebRequest which has an incompatible flag set.
 */
function buildCurlCmd(url: string, flags = ''): string {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  const proxyFlag = proxy ? `--proxy "${proxy}"` : '';
  const ua = `--user-agent "Mozilla/5.0 (compatible; opencli-agent/1.0)"`;
  // Try curl.exe first (Windows 10+), fall back to curl (Linux/macOS)
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
  return `${bin} -s ${flags} ${proxyFlag} ${ua} "${url}"`;
}

/** Parse DuckDuckGo Lite HTML into result objects.
 *
 * DDG Lite structure per result:
 *   <a href="//duckduckgo.com/l/?uddg=URL&amp;rut=..." class='result-link'>Title</a>
 *   <td class='result-snippet'>Snippet text</td>
 *   <span class='link-text'>visible.domain.com</span>
 */
interface SearchResult { title: string; url: string; snippet: string }

function parseDDGLite(html: string, max: number): SearchResult[] {
  // Match any <a> tag that has class='result-link' (attributes in any order).
  // DDG Lite actual format: <a rel="nofollow" href="//duckduckgo.com/l/?uddg=..." class='result-link'>Title</a>
  const anchorRe = /<a\s+([^>]*class=['"]result-link['"][^>]*)>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

  const links: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;

  while ((m = anchorRe.exec(html)) !== null && links.length < max * 2) {
    const attrs  = m[1];
    const inner  = m[2];
    const title  = htmlToText(inner).trim();
    if (!title) continue;

    // Extract href value (handles both single and double quote, &amp; entities)
    const hrefMatch = /href=['"]([^'"]+)['"]/i.exec(attrs);
    if (!hrefMatch) continue;
    const rawHref = hrefMatch[1].replace(/&amp;/g, '&').trim();
    const realUrl = decodeDDGHref(rawHref);
    if (realUrl) links.push({ url: realUrl, title });
  }

  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(htmlToText(m[1]).trim());
  }

  return links.slice(0, max).map((link, i) => ({
    ...link,
    snippet: snippets[i] ?? '',
  }));
}

/**
 * Decode a DDG redirect href like:
 *   //duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2F...&rut=...
 * into the real target URL.
 */
function decodeDDGHref(href: string): string {
  try {
    // Normalize protocol-relative URLs
    const withProto = href.startsWith('//') ? `https:${href}` : href;
    const u = new URL(withProto);
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    // If not a redirect, return as-is
    return href.startsWith('//') ? `https:${href}` : href;
  } catch {
    return '';
  }
}

function parseDDGInstant(json: string): string {
  try {
    const data = JSON.parse(json) as {
      AbstractText?: string;
      AbstractURL?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
    };
    const parts: string[] = [];
    if (data.AbstractText) {
      parts.push(data.AbstractText);
      if (data.AbstractURL) parts.push(`Source: ${data.AbstractURL}`);
    }
    if (data.RelatedTopics) {
      for (const t of data.RelatedTopics.slice(0, 5)) {
        if (t.Text && t.FirstURL) parts.push(`• ${t.Text}\n  ${t.FirstURL}`);
      }
    }
    return parts.join('\n\n');
  } catch {
    return '';
  }
}

function formatSearchResults(query: string, results: SearchResult[]): string {
  const header = `Search results for: "${query}" (${results.length} results)\n${'─'.repeat(50)}`;
  const body = results.map((r, i) =>
    `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? '\n   ' + r.snippet.slice(0, 200) : ''}`,
  ).join('\n\n');
  return `${header}\n\n${body}`;
}

// ─── Tool call parser ─────────────────────────────────────────────────────────

const TOOL_CALL_REGEX = /```tool_call\s*([\s\S]*?)```/gi;

/**
 * Parse tool calls embedded in an AI response.
 *
 * Expected format:
 * ```tool_call
 * { "tool": "shell", "input": { "command": "ls" } }
 * ```
 */
export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;

  TOOL_CALL_REGEX.lastIndex = 0;
  while ((match = TOOL_CALL_REGEX.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as ToolCall;
      if (parsed.tool && typeof parsed.tool === 'string') {
        calls.push({ tool: parsed.tool, input: parsed.input || {} });
      }
    } catch { /* ignore malformed JSON */ }
  }
  return calls;
}

export function hasToolCalls(text: string): boolean {
  TOOL_CALL_REGEX.lastIndex = 0;
  return TOOL_CALL_REGEX.test(text);
}

/**
 * Format tool definitions for the AI system prompt.
 */
export function buildToolsSystemPrompt(): string {
  const lines = [
    '## Available Tools',
    '',
    'Emit tool calls in this format:',
    '',
    '```tool_call',
    '{"tool": "<name>", "input": {"<param>": "<value>"}}',
    '```',
    '',
    'Multiple tool_call blocks are allowed. Results will be returned before you continue.',
    '',
  ];

  for (const tool of TOOL_DEFINITIONS) {
    lines.push(`**${tool.name}** — ${tool.description}`);
    const params = Object.entries(tool.parameters)
      .map(([n, p]) => `  - \`${n}\`${p.required ? '*' : ''} (${p.type}): ${p.description}`)
      .join('\n');
    lines.push(params, '');
  }

  return lines.join('\n');
}
