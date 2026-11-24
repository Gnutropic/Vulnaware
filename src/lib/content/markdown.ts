// @polsia:user-owned — minimal safe-subset Markdown parser.
//
// Emits a typed node tree instead of an HTML string, so the client island
// renders the result as JSX — no dangerouslySetInnerHTML, no XSS surface.
//
// Supports: **bold**, _em_, [text](url), paragraphs split on blank lines,
// soft line breaks inside a paragraph. Rejects every URL scheme other than
// http/https/mailto and relative paths starting with "/".
//
// Each node carries a stable `key` derived from the byte offset of the
// parsed fragment in the source string, so the React island can use it as
// a list key without falling back to array indices.

export type InlineNode =
  | { type: 'text'; key: string; value: string }
  | { type: 'strong'; key: string; children: InlineNode[] }
  | { type: 'em'; key: string; children: InlineNode[] }
  | { type: 'br'; key: string }
  | { type: 'link'; key: string; href: string; children: InlineNode[] };

export type BlockNode = { type: 'paragraph'; key: string; children: InlineNode[] };

const SAFE_URL = /^(https?:|mailto:|\/)/i;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const EM_RE = /_([^_]+)_/g;

/** Parse a safe-subset Markdown string into a list of structured blocks. */
export function parseMarkdown(input: string): BlockNode[] {
  const blocks: BlockNode[] = [];
  let index = 0;
  for (const raw of input.split(/\n{2,}/)) {
    const chunk = raw.trim();
    if (chunk.length === 0) continue;
    const blockKey = `p-${index}`;
    blocks.push({ type: 'paragraph', key: blockKey, children: parseInline(chunk, blockKey) });
    index += 1;
  }
  return blocks;
}

function parseInline(source: string, blockKey: string): InlineNode[] {
  // Step 1: strip link patterns first (longest match) into a flat list of
  // text/link nodes, replacing unsafe URL schemes with bare text.
  const afterLinks: InlineNode[] = [];
  LINK_RE.lastIndex = 0;
  let lastIndex = 0;
  for (const match of source.matchAll(LINK_RE)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) {
      afterLinks.push({
        type: 'text',
        key: `t-${blockKey}-${lastIndex}`,
        value: source.slice(lastIndex, match.index),
      });
    }
    const text = match[1] ?? '';
    const url = (match[2] ?? '').trim();
    if (SAFE_URL.test(url)) {
      afterLinks.push({
        type: 'link',
        key: `lk-${blockKey}-${match.index}`,
        href: url,
        children: [{ type: 'text', key: `t-${blockKey}-${match.index}-lk`, value: text }],
      });
    } else {
      // Untrusted scheme (javascript:, data:, vbscript:, …) — drop the
      // link syntax and emit the text only.
      afterLinks.push({
        type: 'text',
        key: `t-${blockKey}-${match.index}-stripped`,
        value: text,
      });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < source.length) {
    afterLinks.push({
      type: 'text',
      key: `t-${blockKey}-tail-${lastIndex}`,
      value: source.slice(lastIndex),
    });
  }

  // Step 2: bold on the text fragments only.
  const afterBold: InlineNode[] = [];
  for (const part of afterLinks) {
    if (part.type !== 'text') {
      afterBold.push(part);
      continue;
    }
    for (const n of pushPattern(
      part.value,
      BOLD_RE,
      part.key,
      (offset, inner): InlineNode => ({
        type: 'strong',
        key: `s-${blockKey}-${part.key}-${offset}`,
        children: [{ type: 'text', key: `t-${blockKey}-${part.key}-${offset}-st`, value: inner }],
      }),
    )) {
      afterBold.push(n);
    }
  }

  // Step 3: italic on the text fragments only.
  const afterEm: InlineNode[] = [];
  for (const part of afterBold) {
    if (part.type !== 'text') {
      afterEm.push(part);
      continue;
    }
    for (const n of pushPattern(
      part.value,
      EM_RE,
      part.key,
      (offset, inner): InlineNode => ({
        type: 'em',
        key: `e-${blockKey}-${part.key}-${offset}`,
        children: [{ type: 'text', key: `t-${blockKey}-${part.key}-${offset}-em`, value: inner }],
      }),
    )) {
      afterEm.push(n);
    }
  }

  // Step 4: convert intra-paragraph \n into <br/> nodes.
  const final: InlineNode[] = [];
  for (const part of afterEm) {
    if (part.type !== 'text') {
      final.push(part);
      continue;
    }
    const lines = part.value.split('\n');
    lines.forEach((line, i) => {
      if (i > 0) final.push({ type: 'br', key: `br-${blockKey}-${final.length}` });
      if (line.length > 0) {
        final.push({
          type: 'text',
          key: `${part.key}-l${i}`,
          value: line,
        });
      }
    });
  }
  return final;
}

function pushPattern(
  source: string,
  pattern: RegExp,
  parentKey: string,
  build: (offset: number, inner: string) => InlineNode,
): InlineNode[] {
  const out: InlineNode[] = [];
  let lastIndexLocal = 0;
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndexLocal) {
      out.push({
        type: 'text',
        key: `${parentKey}-gap-${match.index}`,
        value: source.slice(lastIndexLocal, match.index),
      });
    }
    out.push(build(match.index, match[1] ?? ''));
    lastIndexLocal = match.index + match[0].length;
  }
  if (lastIndexLocal < source.length) {
    out.push({
      type: 'text',
      key: `${parentKey}-tail-${lastIndexLocal}`,
      value: source.slice(lastIndexLocal),
    });
  }
  return out;
}
