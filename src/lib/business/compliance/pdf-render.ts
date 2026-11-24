// @polsia:user-owned — Pure PDF 1.4 byte-stream emitter for the /compliance
// dashboard. No server-only, no prisma, no fetch — the route handler
// imports it server-side after passing through the admin gate. Kept as a
// pure function so it can be unit-tested in isolation.
//
// Layout: A4 portrait (595×842pt), 48pt margins, Helvetica core font (no
// font embedding — keeps bytes small). The PDF is hand-built: Catalog,
// Pages, Helvetica font object, then one Page object per page with a
// content stream that lays out the header, summary, controls table, and
// findings audit trail. Text is wrapped manually using the Helvetica
// width table (PDF 1.4 spec, Annex C).

import { brand } from '@/lib/brand';
import type {
  ComplianceFramework,
  FindingWithControls,
  FrameworkCoverage,
} from '@/lib/contracts/compliance';

export interface CompliancePdfInput {
  teamName: string;
  generatedAt: string;
  framework: ComplianceFramework;
  coverage: FrameworkCoverage;
  findings: FindingWithControls[];
  scansAnalyzed: number;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const BRAND: {
  accent: Rgb;
  ink: Rgb;
  muted: Rgb;
  paper: Rgb;
  rule: Rgb;
  panel: Rgb;
  green: Rgb;
  amber: Rgb;
  red: Rgb;
  blue: Rgb;
  grey: Rgb;
} = {
  accent: { r: 0x1f / 255, g: 0x8f / 255, b: 0x7a / 255 },
  ink: { r: 0x0a / 255, g: 0x13 / 255, b: 0x13 / 255 },
  muted: { r: 0x6b / 255, g: 0x72 / 255, b: 0x80 / 255 },
  paper: { r: 0xff / 255, g: 0xff / 255, b: 0xff / 255 },
  rule: { r: 0xe2 / 255, g: 0xe8 / 255, b: 0xe7 / 255 },
  panel: { r: 0xf1 / 255, g: 0xf6 / 255, b: 0xf5 / 255 },
  green: { r: 0x16 / 255, g: 0xa3 / 255, b: 0x4a / 255 },
  amber: { r: 0xd9 / 255, g: 0x77 / 255, b: 0x06 / 255 },
  red: { r: 0xdc / 255, g: 0x26 / 255, b: 0x26 / 255 },
  blue: { r: 0x1d / 255, g: 0x4e / 255, b: 0xd8 / 255 },
  grey: { r: 0x9c / 255, g: 0xa3 / 255, b: 0xaf / 255 },
};

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 48;
const CONTENT_LEFT = MARGIN;
const CONTENT_RIGHT = PAGE_WIDTH - MARGIN;
const CONTENT_TOP = PAGE_HEIGHT - MARGIN;
const CONTENT_BOTTOM = MARGIN;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
const BOTTOM_LIMIT = CONTENT_BOTTOM + 24;

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const FRAMEWORK_LABEL: Record<ComplianceFramework, string> = {
  SOC2: 'SOC 2 (TSC)',
  HIPAA: 'HIPAA Security Rule',
  NIST_800_53: 'NIST SP 800-53 r5',
};

// Helvetica core font widths in 1/1000 of em (PDF 1.4 spec Annex C). Spans
// ASCII 0x20–0x7E; non-ASCII and control chars fall back to 500.
const HELV_WIDTHS: Record<number, number> = {
  32: 278,
  33: 278,
  34: 355,
  35: 556,
  36: 556,
  37: 889,
  38: 667,
  39: 191,
  40: 333,
  41: 333,
  42: 389,
  43: 584,
  44: 278,
  45: 333,
  46: 278,
  47: 278,
  48: 556,
  49: 556,
  50: 556,
  51: 556,
  52: 556,
  53: 556,
  54: 556,
  55: 556,
  56: 556,
  57: 556,
  58: 278,
  59: 278,
  60: 584,
  61: 584,
  62: 584,
  63: 556,
  64: 1015,
  65: 667,
  66: 667,
  67: 722,
  68: 722,
  69: 667,
  70: 611,
  71: 778,
  72: 722,
  73: 278,
  74: 500,
  75: 667,
  76: 556,
  77: 833,
  78: 722,
  79: 778,
  80: 667,
  81: 778,
  82: 722,
  83: 667,
  84: 611,
  85: 722,
  86: 667,
  87: 944,
  88: 667,
  89: 667,
  90: 611,
  91: 278,
  92: 278,
  93: 278,
  94: 469,
  95: 556,
  96: 333,
  97: 556,
  98: 556,
  99: 500,
  100: 556,
  101: 556,
  102: 278,
  103: 556,
  104: 556,
  105: 222,
  106: 222,
  107: 500,
  108: 222,
  109: 833,
  110: 556,
  111: 556,
  112: 556,
  113: 556,
  114: 333,
  115: 500,
  116: 278,
  117: 556,
  118: 500,
  119: 722,
  120: 500,
  121: 500,
  122: 500,
  123: 334,
  124: 260,
  125: 334,
  126: 584,
};

function helveticaWidth(ch: string): number {
  const code = ch.charCodeAt(0);
  if (HELV_WIDTHS[code] !== undefined) return HELV_WIDTHS[code];
  return 500;
}

function measureText(text: string, fontSize: number): number {
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    total += helveticaWidth(ch);
  }
  return (total * fontSize) / 1000;
}

function escapePdfString(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    const code = ch.charCodeAt(0);
    if (ch === '\\' || ch === '(' || ch === ')') {
      out += `\\${ch}`;
      continue;
    }
    if (code < 32 || code > 126) {
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function wrapText(text: string, maxWidth: number, fontSize: number): string[] {
  const paragraphs = text.split(/\n/);
  const lines: string[] = [];
  for (const para of paragraphs) {
    if (para === '') {
      lines.push('');
      continue;
    }
    const words = para.split(/\s+/);
    let current = '';
    for (const word of words) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (measureText(candidate, fontSize) <= maxWidth) {
        current = candidate;
      } else if (current === '') {
        // Word is wider than maxWidth — split per character.
        let buf = '';
        for (const ch of word) {
          if (measureText(buf + ch, fontSize) <= maxWidth) {
            buf += ch;
          } else {
            if (buf) lines.push(buf);
            buf = ch;
          }
        }
        current = buf;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function severityColor(severity: string | null): Rgb {
  const key = (severity ?? '').toLowerCase();
  if (key === 'critical' || key === 'high') return BRAND.red;
  if (key === 'medium') return BRAND.amber;
  if (key === 'low') return BRAND.blue;
  return BRAND.grey;
}

function formatDate(iso: string): string {
  return iso
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC')
    .replace(/Z$/, ' UTC');
}

function rgb(c: Rgb): string {
  return `${c.r.toFixed(3)} ${c.g.toFixed(3)} ${c.b.toFixed(3)}`;
}

interface PageContent {
  stream: string;
}

interface PageBuilderState {
  y: number;
  pages: PageContent[];
}

function newPage(state: PageBuilderState): void {
  state.pages.push({ stream: '' });
  state.y = CONTENT_TOP;
}

function appendToPage(state: PageBuilderState, ops: string): void {
  if (state.pages.length === 0) newPage(state);
  const last = state.pages.at(-1);
  if (last) last.stream += ops;
}

function ensureSpace(state: PageBuilderState, needed: number): void {
  if (state.y - needed < BOTTOM_LIMIT) newPage(state);
}

function drawText(
  state: PageBuilderState,
  text: string,
  opts: { x: number; size?: number; color?: Rgb; font?: 'Helvetica' | 'Helvetica-Bold' },
): number {
  const size = opts.size ?? 10;
  const color = opts.color ?? BRAND.ink;
  const font = opts.font ?? 'Helvetica';
  ensureSpace(state, size + 2);
  const lines = wrapText(text, opts.x === CONTENT_LEFT ? CONTENT_WIDTH : opts.x, size);
  for (const line of lines) {
    const ops =
      `BT /${font} ${size} Tf ${rgb(color)} rg ${opts.x.toFixed(2)} ${state.y.toFixed(2)} Td ` +
      `(${escapePdfString(line)}) Tj ET\n`;
    appendToPage(state, ops);
    state.y -= size + 2;
    ensureSpace(state, size + 2);
  }
  return state.y;
}

function drawRect(
  state: PageBuilderState,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: Rgb,
): void {
  appendToPage(
    state,
    `${rgb(fill)} rg ${x.toFixed(2)} ${(y - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f\n`,
  );
}

function drawLine(
  state: PageBuilderState,
  x1: number,
  y1: number,
  x2: number,
  color: Rgb,
  thickness = 0.5,
): void {
  appendToPage(
    state,
    `${rgb(color)} RG ${thickness.toFixed(2)} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y1.toFixed(2)} l S\n`,
  );
}

function sectionHeader(state: PageBuilderState, label: string): void {
  ensureSpace(state, 36);
  state.y -= 6;
  drawRect(state, CONTENT_LEFT, state.y, 4, 14, BRAND.accent);
  appendToPage(
    state,
    `BT /Helvetica-Bold 12 Tf ${rgb(BRAND.ink)} rg ${(CONTENT_LEFT + 10).toFixed(2)} ${(state.y + 2).toFixed(2)} Td (${escapePdfString(label)}) Tj ET\n`,
  );
  state.y -= 18;
}

function buildSummary(state: PageBuilderState, coverage: FrameworkCoverage): void {
  sectionHeader(state, 'Summary');
  const cardWidth = (CONTENT_WIDTH - 16) / 4;
  const cardHeight = 56;
  const cardY = state.y;
  const labels = ['Pass', 'Fail', 'Findings', 'Coverage'];
  const values = [
    String(coverage.passCount),
    String(coverage.failCount),
    String(coverage.totalFindings),
    coverage.controls.length === 0
      ? '—'
      : `${Math.round((coverage.passCount / coverage.controls.length) * 100)}%`,
  ];
  const colors = [BRAND.green, BRAND.red, BRAND.amber, BRAND.accent];
  for (let i = 0; i < 4; i++) {
    const x = CONTENT_LEFT + i * (cardWidth + 4);
    drawRect(state, x, cardY, cardWidth, cardHeight, BRAND.panel);
    drawRect(state, x, cardY, cardWidth, 2, colors[i] as Rgb);
    appendToPage(
      state,
      `BT /Helvetica 8 Tf ${rgb(BRAND.muted)} rg ${(x + 8).toFixed(2)} ${(cardY - 14).toFixed(2)} Td (${escapePdfString(labels[i] ?? '')}) Tj ET\n`,
    );
    appendToPage(
      state,
      `BT /Helvetica-Bold 16 Tf ${rgb(BRAND.ink)} rg ${(x + 8).toFixed(2)} ${(cardY - 34).toFixed(2)} Td (${escapePdfString(values[i] ?? '')}) Tj ET\n`,
    );
  }
  state.y = cardY - cardHeight - 6;
}

function buildControlsTable(state: PageBuilderState, coverage: FrameworkCoverage): void {
  sectionHeader(state, 'Controls');
  const colX = {
    id: CONTENT_LEFT,
    title: CONTENT_LEFT + 90,
    sev: CONTENT_RIGHT - 96,
    fail: CONTENT_RIGHT - 36,
  };
  const headerY = state.y;
  drawText(state, 'Control ID', {
    x: colX.id,
    size: 8,
    color: BRAND.muted,
    font: 'Helvetica-Bold',
  });
  state.y = headerY;
  drawText(state, 'Title', {
    x: colX.title,
    size: 8,
    color: BRAND.muted,
    font: 'Helvetica-Bold',
  });
  state.y = headerY;
  drawText(state, 'Severity', {
    x: colX.sev,
    size: 8,
    color: BRAND.muted,
    font: 'Helvetica-Bold',
  });
  state.y = headerY;
  drawText(state, 'Fail', {
    x: colX.fail,
    size: 8,
    color: BRAND.muted,
    font: 'Helvetica-Bold',
  });
  state.y = headerY - 8;
  drawLine(state, CONTENT_LEFT, state.y + 6, CONTENT_RIGHT, BRAND.rule, 0.5);
  for (const c of coverage.controls) {
    ensureSpace(state, 22);
    const rowY = state.y;
    drawText(state, c.controlId, {
      x: colX.id,
      size: 9,
      color: BRAND.ink,
      font: 'Helvetica-Bold',
    });
    state.y = rowY;
    drawText(state, c.title, {
      x: colX.title,
      size: 9,
      color: BRAND.ink,
    });
    state.y = rowY;
    const sevLabel = c.worstSeverity
      ? (SEVERITY_LABEL[c.worstSeverity.toLowerCase()] ?? c.worstSeverity)
      : '—';
    const sevColor = severityColor(c.worstSeverity);
    if (c.worstSeverity) {
      drawRect(state, colX.sev, rowY - 4, 6, 10, sevColor);
    }
    appendToPage(
      state,
      `BT /Helvetica 9 Tf ${rgb(c.worstSeverity ? BRAND.ink : BRAND.muted)} rg ${(colX.sev + 10).toFixed(2)} ${(rowY).toFixed(2)} Td (${escapePdfString(sevLabel)}) Tj ET\n`,
    );
    appendToPage(
      state,
      `BT /Helvetica-Bold 9 Tf ${rgb(c.failing > 0 ? BRAND.red : BRAND.muted)} rg ${colX.fail.toFixed(2)} ${(rowY).toFixed(2)} Td (${escapePdfString(String(c.failing))}) Tj ET\n`,
    );
    state.y = rowY - 14;
    drawLine(state, CONTENT_LEFT, state.y + 8, CONTENT_RIGHT, BRAND.rule, 0.25);
  }
  state.y -= 4;
}

function buildFindingsAudit(
  state: PageBuilderState,
  findings: FindingWithControls[],
  framework: ComplianceFramework,
): void {
  sectionHeader(state, 'Findings audit trail');
  if (findings.length === 0) {
    drawText(state, 'No findings tagged for this framework in the analyzed scans.', {
      x: CONTENT_LEFT,
      size: 10,
      color: BRAND.muted,
    });
    return;
  }
  const sevRank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
  const sorted = [...findings].sort((a, b) => {
    const ra = sevRank[(a.severity ?? '').toLowerCase()] ?? 0;
    const rb = sevRank[(b.severity ?? '').toLowerCase()] ?? 0;
    if (rb !== ra) return rb - ra;
    return a.cveId.localeCompare(b.cveId);
  });
  for (const f of sorted) {
    ensureSpace(state, 60);
    const blockStart = state.y;
    const sevLabel = f.severity ? (SEVERITY_LABEL[f.severity.toLowerCase()] ?? f.severity) : '—';
    const sevColor = severityColor(f.severity);
    drawRect(state, CONTENT_LEFT, blockStart, 4, 14, sevColor);
    appendToPage(
      state,
      `BT /Helvetica-Bold 10 Tf ${rgb(BRAND.ink)} rg ${(CONTENT_LEFT + 10).toFixed(2)} ${blockStart.toFixed(2)} Td (${escapePdfString(f.cveId)}) Tj ET\n`,
    );
    appendToPage(
      state,
      `BT /Helvetica 8 Tf ${rgb(sevColor)} rg ${(CONTENT_LEFT + 10 + measureText(f.cveId, 10) + 6).toFixed(2)} ${blockStart.toFixed(2)} Td (${escapePdfString(sevLabel)}) Tj ET\n`,
    );
    state.y = blockStart - 14;
    const meta = `Scan target: ${f.scanTarget}  •  ${formatDate(f.scanStartedAt)}`;
    drawText(state, meta, { x: CONTENT_LEFT + 10, size: 8, color: BRAND.muted });
    if (f.matchReason) {
      drawText(state, `Match: ${f.matchReason}`, {
        x: CONTENT_LEFT + 10,
        size: 8,
        color: BRAND.muted,
      });
    }
    state.y -= 2;
    for (const tag of f.tags) {
      if (tag.framework !== framework) continue;
      ensureSpace(state, 18);
      const tagY = state.y;
      drawText(state, `▸ ${tag.controlId}`, {
        x: CONTENT_LEFT + 10,
        size: 9,
        color: BRAND.accent,
        font: 'Helvetica-Bold',
      });
      state.y = tagY;
      drawText(state, tag.reason, {
        x: CONTENT_LEFT + 10 + 64,
        size: 8,
        color: BRAND.ink,
      });
      state.y -= 6;
    }
    state.y = blockStart - 70;
    drawLine(state, CONTENT_LEFT, state.y + 4, CONTENT_RIGHT, BRAND.rule, 0.25);
    state.y -= 4;
  }
}

function buildHeader(state: PageBuilderState, input: CompliancePdfInput): void {
  const headerY = CONTENT_TOP;
  drawText(state, input.teamName, {
    x: CONTENT_LEFT,
    size: 9,
    color: BRAND.muted,
    font: 'Helvetica-Bold',
  });
  state.y = headerY;
  appendToPage(
    state,
    `BT /Helvetica-Bold 18 Tf ${rgb(BRAND.ink)} rg ${CONTENT_LEFT.toFixed(2)} ${(headerY - 22).toFixed(2)} Td (Compliance coverage) Tj ET\n`,
  );
  state.y = headerY - 22;
  drawText(state, `Framework: ${FRAMEWORK_LABEL[input.framework]}`, {
    x: CONTENT_LEFT,
    size: 10,
    color: BRAND.ink,
  });
  state.y = headerY - 22;
  drawText(state, `Scans analyzed: ${input.scansAnalyzed}`, {
    x: CONTENT_LEFT,
    size: 9,
    color: BRAND.muted,
  });
  state.y = headerY - 22;
  drawText(state, `Generated: ${formatDate(input.generatedAt)}`, {
    x: CONTENT_LEFT,
    size: 9,
    color: BRAND.muted,
  });
  // Framework badge on the right.
  const badgeText = FRAMEWORK_LABEL[input.framework];
  const badgeWidth = measureText(badgeText, 9) + 16;
  const badgeHeight = 18;
  const badgeX = CONTENT_RIGHT - badgeWidth;
  const badgeY = headerY - 14;
  drawRect(state, badgeX, badgeY, badgeWidth, badgeHeight, BRAND.panel);
  drawRect(state, badgeX, badgeY, 3, badgeHeight, BRAND.accent);
  appendToPage(
    state,
    `BT /Helvetica-Bold 9 Tf ${rgb(BRAND.accent)} rg ${(badgeX + 10).toFixed(2)} ${(badgeY + 5).toFixed(2)} Td (${escapePdfString(badgeText)}) Tj ET\n`,
  );
  state.y = headerY - 36;
  drawLine(state, CONTENT_LEFT, state.y, CONTENT_RIGHT, BRAND.rule, 0.5);
  state.y -= 10;
}

function buildEmptyState(state: PageBuilderState): void {
  sectionHeader(state, 'Findings');
  drawText(state, 'No findings to map yet — run a scan against a public hostname.', {
    x: CONTENT_LEFT,
    size: 10,
    color: BRAND.muted,
  });
}

function buildFooter(state: PageBuilderState, teamName: string): void {
  // Footer is drawn after the body content but before xref assembly; we
  // just inject it into the last page if there's room, otherwise the
  // caller iterates pages and stamps it after the fact. The actual
  // stamping is done by `stampFooters` below.
  void state;
  void teamName;
}

function stampFooters(
  pages: PageContent[],
  teamName: string,
  framework: ComplianceFramework,
): PageContent[] {
  return pages.map((p, idx) => {
    const footerY = CONTENT_BOTTOM - 18;
    const left = `${brand.name} · ${teamName} · ${FRAMEWORK_LABEL[framework]}`;
    const center = `Page ${idx + 1} of ${pages.length}`;
    const right = formatDate(new Date().toISOString());
    const ops =
      `${rgb(BRAND.muted)} rg ` +
      `BT /Helvetica 7 Tf ${CONTENT_LEFT.toFixed(2)} ${footerY.toFixed(2)} Td (${escapePdfString(left)}) Tj ET\n` +
      `BT /Helvetica 7 Tf ${((PAGE_WIDTH - measureText(center, 7)) / 2).toFixed(2)} ${footerY.toFixed(2)} Td (${escapePdfString(center)}) Tj ET\n` +
      `BT /Helvetica 7 Tf ${(CONTENT_RIGHT - measureText(right, 7)).toFixed(2)} ${footerY.toFixed(2)} Td (${escapePdfString(right)}) Tj ET\n`;
    return { stream: p.stream + ops };
  });
}

function assemblePdf(pages: PageContent[]): Uint8Array {
  // Object numbers:
  //   1: Catalog
  //   2: Pages
  //   3: Font Helvetica
  //   4: Font Helvetica-Bold
  //   5…: alternating Page (odd) + Contents (even)
  const fontId = 3;
  const fontBoldId = 4;
  const firstPageId = 5;
  const pageObjectIds: number[] = [];
  const contentObjectIds: number[] = [];
  let nextId = firstPageId;
  for (let i = 0; i < pages.length; i++) {
    pageObjectIds.push(nextId++);
    contentObjectIds.push(nextId++);
  }

  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  function push(s: string): void {
    parts.push(enc.encode(s));
  }
  const offsets: number[] = [0];
  function currentLength(): number {
    let total = 0;
    for (const p of parts) total += p.byteLength;
    return total;
  }
  function recordObject(label: string): void {
    offsets.push(currentLength());
    push(label);
  }

  push('%PDF-1.4\n');
  push('%\xE2\xE3\xCF\xD3\n');

  const pagesRefs = pageObjectIds.map((id) => `${id} 0 R`).join(' ');
  recordObject(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  recordObject(
    `2 0 obj\n<< /Type /Pages /Kids [${pagesRefs}] /Count ${pageObjectIds.length} >>\nendobj\n`,
  );
  recordObject(
    `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`,
  );
  recordObject(
    `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`,
  );

  for (let i = 0; i < pages.length; i++) {
    const pageId = pageObjectIds[i];
    const contentId = contentObjectIds[i];
    const page = pages[i];
    if (!page) continue;
    const streamBytes = enc.encode(page.stream);
    recordObject(`${contentId} 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n`);
    parts.push(streamBytes);
    push('\nendstream\nendobj\n');
    recordObject(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /Helvetica ${fontId} 0 R /Helvetica-Bold ${fontBoldId} 0 R >> >> ` +
        `/Contents ${contentId} 0 R >>\nendobj\n`,
    );
  }

  const xrefOffsetFinal = currentLength();
  let xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    xref += `${offsets[i]?.toString().padStart(10, '0') ?? '0000000000'} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffsetFinal}\n%%EOF\n`,
  );

  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export function renderCompliancePdf(input: CompliancePdfInput): Uint8Array {
  const state: PageBuilderState = { y: CONTENT_TOP, pages: [] };
  newPage(state);
  buildHeader(state, input);
  if (input.findings.length === 0) {
    buildEmptyState(state);
  } else {
    buildSummary(state, input.coverage);
    buildControlsTable(state, input.coverage);
    buildFindingsAudit(state, input.findings, input.framework);
  }
  buildFooter(state, input.teamName);
  const stamped = stampFooters(state.pages, input.teamName, input.framework);
  return assemblePdf(stamped);
}
