import type { ShareRowKind, ShareSection } from '@/lib/share/model';

/**
 * Reads a report off the page, exactly as it is shown.
 *
 * Report pages already draw their tables from the server's figures in the
 * columns the reader chose; reading those tables back is what guarantees the
 * PDF and the link say what the screen says. What the page leaves off paper —
 * buttons, action columns, anything marked not to print — is left off here
 * too.
 */

const SKIP = [
  '[data-share="skip"]',
  '[data-print="hide"]',
  '.print\\:hidden',
  '[role="dialog"]',
  '.sr-only',
  'button',
  'input',
  'select',
  'textarea',
  'svg',
  'script',
  'style',
].join(',');

/** Tables the page keeps off paper, or that belong to a dialog, are not part of the report. */
const TABLE_SKIP = '[data-share="skip"], [data-print="hide"], .print\\:hidden, [role="dialog"]';

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'TABLE', 'TR']);

function isSkipped(el: Element): boolean {
  return el.matches(SKIP);
}

function isBlock(el: Element): boolean {
  if (BLOCK_TAGS.has(el.tagName)) return true;
  return /(^|\s)(block|flex|grid)(\s|$)/.test(el.getAttribute('class') ?? '');
}

/** Text with line breaks where the page breaks lines, without asking the browser to lay anything out. */
function walk(node: Node, out: string[], keepButtons: boolean): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.textContent ?? '');
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  if (isSkipped(el) && !(keepButtons && el.tagName === 'BUTTON')) return;
  if (el.tagName === 'BR') {
    out.push('\n');
    return;
  }
  const block = isBlock(el);
  const spaced = /(^|\s)(flex|grid|inline-flex)(\s|$)|gap-/.test(el.getAttribute('class') ?? '');
  if (block) out.push('\n');
  el.childNodes.forEach((child, i) => {
    if (spaced && i > 0 && child.nodeType === Node.ELEMENT_NODE) out.push(' ');
    walk(child, out, keepButtons);
  });
  if (block) out.push('\n');
}

/** `keepButtons` for a header, where a sortable column's name is its button. */
export function textOf(el: Element, keepButtons = false): string {
  const out: string[] = [];
  el.childNodes.forEach((child) => walk(child, out, keepButtons));
  return out
    .join('')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function cellHidden(cell: Element): boolean {
  return cell.matches('[data-print="hide"], .print\\:hidden, [data-share="skip"]');
}

function rowKind(tr: HTMLTableRowElement, cellsKept: number, columns: number): ShareRowKind {
  const cls = tr.getAttribute('class') ?? '';
  if (/ledger-opening/.test(cls)) return 'opening';
  if (/ledger-closing|grid-final/.test(cls)) return 'closing';
  if (/ledger-totals|grid-total/.test(cls) || tr.parentElement?.tagName === 'TFOOT') return 'total';
  if (/subtotal/.test(cls)) return 'subtotal';
  if (cellsKept === 1 && columns > 1) return 'heading';
  return 'row';
}

/** The heading a table sits under: the card title, the section heading, whatever names it. */
function headingOf(table: Element, root: Element): string | undefined {
  const own = table.closest('[data-share-heading]');
  if (own && root.contains(own)) return own.getAttribute('data-share-heading') || undefined;
  const caption = table.querySelector('caption');
  if (caption) return textOf(caption) || undefined;
  let node: Element | null = table;
  for (let depth = 0; node && node !== root && depth < 8; depth++, node = node.parentElement) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (!isSkipped(sibling)) {
        const heading = sibling.matches('h1,h2,h3,h4,[data-slot="card-title"]')
          ? sibling
          : [...sibling.querySelectorAll('h2,h3,h4,[data-slot="card-title"]')].pop();
        if (heading) {
          const text = textOf(heading).split('\n')[0];
          if (text) return text;
        }
      }
      sibling = sibling.previousElementSibling;
    }
  }
  return undefined;
}

export type DomTable = { key: string; heading?: string; section: ShareSection; element: HTMLTableElement };

export function readTable(table: HTMLTableElement, root: Element, key: string): DomTable | null {
  const headRows = table.tHead ? [...table.tHead.rows] : [];
  const header = headRows[headRows.length - 1] ?? table.rows[0];
  if (!header) return null;

  // Which column positions are shown: a header cell left off paper takes its column with it.
  const keep: boolean[] = [];
  const columns: ShareSection['columns'] = [];
  for (const cell of [...header.cells]) {
    const span = Math.max(1, cell.colSpan || 1);
    const hidden = cellHidden(cell);
    const label = hidden ? '' : textOf(cell, true).replace(/\n/g, ' ');
    const numeric = /text-right|numeric/.test(cell.getAttribute('class') ?? '') || cell.getAttribute('data-numeric') === 'true';
    for (let i = 0; i < span; i++) {
      keep.push(!hidden);
      if (!hidden) columns.push({ label: i === 0 ? label : '', numeric });
    }
  }
  // An unlabelled, empty column (a chevron, a menu) is not part of the report.
  const bodyRows = [...(table.tBodies ? [...table.tBodies].flatMap((b) => [...b.rows]) : []), ...(table.tFoot ? [...table.tFoot.rows] : [])].filter(
    (tr) => tr !== header && !headRows.includes(tr) && !cellHidden(tr),
  );

  const rows: ShareSection['rows'] = [];
  const texts: string[][] = [];
  for (const tr of bodyRows) {
    let pos = 0;
    const cells: Array<{ text: string; span?: number }> = [];
    for (const cell of [...tr.cells]) {
      const span = Math.max(1, cell.colSpan || 1);
      const covered = keep.slice(pos, pos + span);
      const kept = covered.length ? covered.filter(Boolean).length : 1;
      pos += span;
      if (kept === 0 || cellHidden(cell)) continue;
      cells.push(kept > 1 ? { text: textOf(cell), span: kept } : { text: textOf(cell) });
    }
    if (cells.length === 0 || cells.every((c) => !c.text)) continue;
    rows.push({ cells, kind: rowKind(tr, cells.length, columns.length) });
    texts.push(cells.map((c) => c.text));
  }
  if (rows.length === 0) return null;

  // Drop columns with no header and nothing in them.
  const empty = columns.map((c, i) => !c.label && rows.every((r) => r.cells.length === columns.length && !r.cells[i]?.text));
  const section: ShareSection = {
    heading: headingOf(table, root),
    columns: columns.filter((_, i) => !empty[i]),
    rows: rows.map((r) => (r.cells.length === columns.length ? { ...r, cells: r.cells.filter((_, i) => !empty[i]) } : r)),
  };
  if (section.columns.length === 0) return null;
  return { key, heading: section.heading, section, element: table };
}

/** Every report table under `root`, in page order. */
export function readTables(root: Element): DomTable[] {
  const tables = [...root.querySelectorAll('table')].filter((t) => !t.closest(TABLE_SKIP));
  const found: DomTable[] = [];
  tables.forEach((table, i) => {
    const read = readTable(table, root, `t${i}`);
    if (read) found.push(read);
  });
  return found;
}

/** Figures the page marks for sharing: <dd data-share-fact="Opening balance">…</dd>. */
export function readFacts(root: Element): Array<{ label: string; value: string }> {
  return [...root.querySelectorAll('[data-share-fact]')]
    .filter((el) => !el.closest('[data-share="skip"], [role="dialog"]'))
    .map((el) => ({ label: el.getAttribute('data-share-fact') ?? '', value: textOf(el) }))
    .filter((f) => f.label && f.value);
}
