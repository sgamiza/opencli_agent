/**
 * Terminal Markdown renderer.
 *
 * Converts the markdown returned by Yuanbao into readable terminal output
 * using ANSI escape codes — no extra dependencies.
 *
 * Handles the specific quirks from opencli's htmlToMarkdown conversion:
 *   - Nested `- •` bullet pattern (outer `-` is empty, inner `•` is content)
 *   - `**bold**` / `*italic*` inline styles
 *   - `## Headings`
 *   - `` `inline code` `` and fenced code blocks
 *   - `![alt](url)` images → strip (Yuanbao loading spinners, etc.)
 *   - `| table |` rows → preserve with light formatting
 *   - `* * *` / `---` horizontal rules
 */

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;

function ansi(...codes: number[]): string {
  return isTTY ? `\x1b[${codes.join(';')}m` : '';
}

const A = {
  reset:         ansi(0),
  bold:          ansi(1),
  dim:           ansi(2),
  italic:        ansi(3),
  underline:     ansi(4),
  cyan:          ansi(36),
  yellow:        ansi(33),
  green:         ansi(32),
  blue:          ansi(34),
  magenta:       ansi(35),
  gray:          ansi(90),
  white:         ansi(97),
  bgBlack:       ansi(40),
  brightCyan:    ansi(96),
  brightYellow:  ansi(93),
};

function styled(text: string, ...styles: string[]): string {
  if (!isTTY) return text;
  return styles.join('') + text + A.reset;
}

// ─── Pre-processing ────────────────────────────────────────────────────────────

/**
 * Collapse Yuanbao's double-nested bullet pattern into clean single bullets.
 *
 * opencli's htmlToMarkdown converts <li><ul><li>text</li></ul></li> into:
 *   -   •
 *
 *       text
 *
 * We collapse this into:
 *   • text
 */
function collapseNestedBullets(text: string): string {
  // Match lines that are "-   •" followed by blank line + indented content
  return text.replace(
    /^(-\s+•\s*)\n+^([ \t]{2,})([\s\S]*?)(?=\n(?:-\s+•|\n#{1,6} |$))/gm,
    (_match, _bullet, _indent, content) => {
      // content may itself contain blank lines + indented sub-items
      const cleaned = content.replace(/\n{2,}[ \t]{2,}/g, '\n    ');
      return `• ${cleaned.trim()}`;
    },
  );
}

/**
 * Simpler pass: collapse any remaining "-   •\n\n    text" pattern that the
 * regex above might have missed (non-greedy edge cases).
 */
function collapseBulletFallback(text: string): string {
  // Handle remaining "- •\n\n    <content>" lines
  return text.replace(/-[ \t]+•\s*\n+([ \t]+)(.*)/g, (_, _indent, content) => `• ${content.trim()}`);
}

// ─── Line-by-line renderer ────────────────────────────────────────────────────

const CODE_FENCE_RE = /^```(\w*)/;
const TABLE_ROW_RE  = /^\|(.+)\|/;
const HR_RE         = /^(\* \* \*|---+|\* \* \* \*|_{3,})\s*$/;
const H1_RE         = /^# (.+)/;
const H2_RE         = /^## (.+)/;
const H3_RE         = /^### (.+)/;
const BULLET_RE     = /^[•\-\*] (.+)/;

/** Apply inline styles (bold, italic, inline-code) to a single line of text. */
function applyInlineStyles(line: string): string {
  // Remove images: ![alt](url) or just ![](url)
  line = line.replace(/!\[([^\]]*)\]\([^)]*\)/g, '');

  // Bold-italic: ***text***
  line = line.replace(/\*\*\*(.+?)\*\*\*/g, styled('$1', A.bold, A.italic));

  // Bold: **text** or __text__
  line = line.replace(/\*\*(.+?)\*\*/g, styled('$1', A.bold));
  line = line.replace(/__(.+?)__/g, styled('$1', A.bold));

  // Italic: *text* or _text_ (avoid matching list bullets)
  line = line.replace(/(?<![*_])\*(?!\s)(.+?)(?<!\s)\*(?![*])/g, styled('$1', A.italic));
  line = line.replace(/(?<!_)_(?!\s)(.+?)(?<!\s)_(?!_)/g, styled('$1', A.italic));

  // Inline code: `code`
  line = line.replace(/`([^`]+)`/g, styled('$1', A.brightCyan, A.bgBlack));

  // [link text](url) → just the text in underline
  line = line.replace(/\[([^\]]+)\]\([^)]+\)/g, styled('$1', A.underline));

  return line;
}

const TERMINAL_WIDTH = Math.min(process.stdout.columns || 80, 100);

function hr(): string {
  return styled('─'.repeat(TERMINAL_WIDTH), A.gray);
}

/** Render a table row. */
function renderTableRow(line: string, isHeader: boolean): string {
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((cell) => applyInlineStyles(cell.trim()));

  if (isHeader) {
    return cells.map((c) => styled(c, A.bold + A.yellow)).join(styled('  │  ', A.gray));
  }
  return cells.join(styled('  │  ', A.gray));
}

// ─── Main renderer ─────────────────────────────────────────────────────────────

export function renderMarkdown(text: string): string {
  if (!text) return '';

  // Pre-process: collapse Yuanbao's nested bullet mess
  let processed = collapseNestedBullets(text);
  processed = collapseBulletFallback(processed);

  const lines = processed.split('\n');
  const output: string[] = [];

  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let prevLineBlank = false;
  let inTable = false;
  let tableHeaderDone = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // ── Code fences ──
    const fenceMatch = raw.match(CODE_FENCE_RE);
    if (fenceMatch && !inCodeBlock) {
      inCodeBlock = true;
      codeLang = fenceMatch[1] || '';
      codeLines = [];
      continue;
    }
    if (inCodeBlock) {
      if (trimmed === '```') {
        // Close code block
        const langLabel = codeLang
          ? styled(` ${codeLang} `, A.gray)
          : '';
        if (langLabel) output.push(langLabel);
        for (const cl of codeLines) {
          output.push(styled(cl, A.brightCyan));
        }
        output.push('');
        inCodeBlock = false;
        codeLang = '';
        codeLines = [];
      } else {
        codeLines.push(raw);
      }
      continue;
    }

    // ── Blank lines ──
    if (!trimmed) {
      if (!prevLineBlank) output.push('');
      prevLineBlank = true;
      inTable = false;
      tableHeaderDone = false;
      continue;
    }
    prevLineBlank = false;

    // ── Horizontal rules ──
    if (HR_RE.test(trimmed)) {
      output.push(hr());
      continue;
    }

    // ── Headings ──
    let hMatch: RegExpMatchArray | null;
    if ((hMatch = raw.match(H1_RE))) {
      output.push('');
      output.push(styled(`▌ ${hMatch[1].trim()}`, A.bold + A.brightYellow));
      output.push(styled('─'.repeat(Math.min(hMatch[1].trim().length + 4, TERMINAL_WIDTH)), A.yellow));
      continue;
    }
    if ((hMatch = raw.match(H2_RE))) {
      output.push('');
      output.push(styled(`◆ ${applyInlineStyles(hMatch[1].trim())}`, A.bold + A.cyan));
      continue;
    }
    if ((hMatch = raw.match(H3_RE))) {
      output.push(styled(`  › ${applyInlineStyles(hMatch[1].trim())}`, A.bold + A.green));
      continue;
    }

    // ── Tables ──
    if (TABLE_ROW_RE.test(trimmed)) {
      // Separator row (|---|---|) → treat as header separator
      if (/^\|[\s:|-]+\|/.test(trimmed)) {
        if (inTable && !tableHeaderDone) {
          output.push(styled('─'.repeat(TERMINAL_WIDTH), A.gray));
          tableHeaderDone = true;
        }
        continue;
      }
      if (!inTable) {
        output.push('');
        inTable = true;
        tableHeaderDone = false;
      }
      const isHeader = !tableHeaderDone;
      output.push(renderTableRow(trimmed, isHeader));
      continue;
    }

    // ── Bullet points (after pre-processing) ──
    const bulletMatch = trimmed.match(/^[•] (.+)/);
    if (bulletMatch) {
      // Detect indentation level
      const indent = raw.match(/^(\s*)/)?.[1].length ?? 0;
      const pad = ' '.repeat(Math.max(2, indent));
      output.push(`${pad}${styled('•', A.cyan)} ${applyInlineStyles(bulletMatch[1])}`);
      continue;
    }

    // Also handle remaining -/*/+ list items
    const mdBulletMatch = trimmed.match(/^[-*+] (.+)/);
    if (mdBulletMatch) {
      const indent = raw.match(/^(\s*)/)?.[1].length ?? 0;
      const pad = ' '.repeat(Math.max(2, indent));
      output.push(`${pad}${styled('•', A.cyan)} ${applyInlineStyles(mdBulletMatch[1])}`);
      continue;
    }

    // Numbered lists: "1. text"
    const numListMatch = trimmed.match(/^(\d+)\. (.+)/);
    if (numListMatch) {
      output.push(`  ${styled(numListMatch[1] + '.', A.yellow)} ${applyInlineStyles(numListMatch[2])}`);
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('> ')) {
      output.push(styled('  │ ', A.gray) + styled(applyInlineStyles(trimmed.slice(2)), A.dim));
      continue;
    }

    // ── Normal paragraph text ──
    output.push(applyInlineStyles(raw));
  }

  // Trim trailing blank lines
  while (output.length > 0 && output[output.length - 1] === '') {
    output.pop();
  }

  return output.join('\n');
}
