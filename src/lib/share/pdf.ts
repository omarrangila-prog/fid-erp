import { jsPDF } from 'jspdf';
import { autoTable, type CellInput, type RowInput } from 'jspdf-autotable';
import type { ShareRowKind, ShareSnapshot } from '@/lib/share/model';

/**
 * The shared report as a PDF, made in the browser from the snapshot.
 *
 * Same letterhead as the printed reports: company, report, party, period,
 * filters, columns, the table with a bold header and full grid lines, totals
 * set off, and a quiet footer saying where it came from. Built here rather
 * than on the server so the report never leaves the phone unless the person
 * chooses a link — and loaded only when somebody shares, not with every page.
 *
 * The font is DejaVu Sans, embedded: the built-in PDF fonts cannot print
 * "≈", "—" or a customer's accented name.
 */

const FONT = 'DejaVuSans';
let fonts: Promise<{ regular: string; bold: string }> | null = null;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function loadFonts() {
  fonts ??= Promise.all(
    ['/fonts/DejaVuSans.ttf', '/fonts/DejaVuSans-Bold.ttf'].map((url) =>
      fetch(url).then((r) => {
        if (!r.ok) throw new Error('font');
        return r.arrayBuffer();
      }),
    ),
  )
    .then(([regular, bold]) => ({ regular: toBase64(regular), bold: toBase64(bold) }))
    .catch((error) => {
      fonts = null;
      throw error;
    });
  return fonts;
}

const GRID = [63, 63, 70] as const; // --color-grid
const HEAD = [238, 241, 238] as const; // --color-grid-head
const TOTAL = [241, 244, 241] as const; // --color-grid-total
const INK = [24, 24, 27] as const;
const MUTED = [90, 90, 98] as const;

const EMPHASIS: Partial<Record<ShareRowKind, { fill: readonly [number, number, number]; bold: boolean }>> = {
  opening: { fill: TOTAL, bold: true },
  subtotal: { fill: TOTAL, bold: true },
  total: { fill: TOTAL, bold: true },
  closing: { fill: HEAD, bold: true },
  heading: { fill: HEAD, bold: true },
};

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export async function buildSharePdf(snapshot: ShareSnapshot): Promise<Blob> {
  const widest = Math.max(0, ...snapshot.sections.map((s) => s.columns.length));
  const doc = new jsPDF({ orientation: widest > 7 ? 'landscape' : 'portrait', unit: 'mm', format: 'a4', compress: true });

  let font = 'helvetica';
  try {
    const { regular, bold } = await loadFonts();
    doc.addFileToVFS('DejaVuSans.ttf', regular);
    doc.addFont('DejaVuSans.ttf', FONT, 'normal');
    doc.addFileToVFS('DejaVuSans-Bold.ttf', bold);
    doc.addFont('DejaVuSans-Bold.ttf', FONT, 'bold');
    font = FONT;
  } catch {
    // Offline or blocked: the standard font still makes a readable PDF.
  }

  doc.setProperties({ title: [snapshot.subject, snapshot.title].filter(Boolean).join(' — '), creator: 'FID Trading ERP', author: snapshot.generatedBy });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;
  let y = 14;

  const line = (value: string, size: number, style: 'normal' | 'bold', color: readonly [number, number, number] = INK, gap = 1.5) => {
    doc.setFont(font, style);
    doc.setFontSize(size);
    doc.setTextColor(...color);
    for (const part of doc.splitTextToSize(value, pageWidth - margin * 2) as string[]) {
      doc.text(part, margin, y);
      y += size * 0.42;
    }
    y += gap;
  };

  line(snapshot.company, 13, 'bold', INK, 1);
  line(snapshot.title, 12, 'bold', INK, 0.5);
  if (snapshot.subject) line(snapshot.subject, 11, 'normal', INK, 0.5);
  if (snapshot.period) line(snapshot.period, 9.5, 'normal', MUTED, 0.5);
  if (snapshot.filters.length) line(`Filters: ${snapshot.filters.join(' · ')}`, 8.5, 'normal', MUTED, 0.5);
  line(`${snapshot.scope} · Generated ${when(snapshot.generatedAt)}${snapshot.generatedBy ? ` by ${snapshot.generatedBy}` : ''}`, 8, 'normal', MUTED, 2);

  const tableStyles = {
    font,
    fontSize: widest > 9 ? 7 : 8,
    cellPadding: 1.4,
    lineColor: [...GRID] as [number, number, number],
    lineWidth: 0.15,
    textColor: [...INK] as [number, number, number],
    overflow: 'linebreak' as const,
    valign: 'top' as const,
  };

  if (snapshot.facts.length) {
    const pairs: RowInput[] = [];
    for (let i = 0; i < snapshot.facts.length; i += 2) {
      const a = snapshot.facts[i];
      const b = snapshot.facts[i + 1];
      pairs.push([
        { content: a.label, styles: { textColor: [...MUTED] as [number, number, number] } },
        { content: a.value, styles: { fontStyle: 'bold', halign: 'right' } },
        { content: b?.label ?? '', styles: { textColor: [...MUTED] as [number, number, number] } },
        { content: b?.value ?? '', styles: { fontStyle: 'bold', halign: 'right' } },
      ]);
    }
    autoTable(doc, { startY: y, body: pairs, theme: 'grid', styles: tableStyles, margin: { left: margin, right: margin } });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 5;
  }

  for (const section of snapshot.sections) {
    if (section.heading) {
      if (y > doc.internal.pageSize.getHeight() - 30) {
        doc.addPage();
        y = 14;
      }
      line(section.heading, 10, 'bold', INK, 1);
    }
    const numeric = section.columns.map((c) => Boolean(c.numeric));
    const body: RowInput[] = section.rows.map((row) => {
      const emphasis = EMPHASIS[row.kind ?? 'row'];
      let pos = 0;
      return row.cells.map((cell): CellInput => {
        const at = pos;
        pos += cell.span ?? 1;
        return {
          content: cell.text,
          colSpan: cell.span,
          styles: {
            halign: (cell.span ?? 1) === 1 && numeric[at] ? 'right' : 'left',
            ...(emphasis ? { fontStyle: emphasis.bold ? 'bold' : 'normal', fillColor: [...emphasis.fill] as [number, number, number] } : {}),
          },
        };
      });
    });
    autoTable(doc, {
      startY: y,
      head: [section.columns.map((c, i) => ({ content: c.label, styles: { halign: numeric[i] ? 'right' : 'left' } }))],
      body,
      theme: 'grid',
      styles: tableStyles,
      headStyles: { fillColor: [...HEAD] as [number, number, number], textColor: [...INK] as [number, number, number], fontStyle: 'bold', lineWidth: 0.3 },
      margin: { left: margin, right: margin, bottom: 14 },
      showHead: 'everyPage',
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  }

  // Footer on every page: where it came from, and which page.
  const pages = doc.getNumberOfPages();
  const height = doc.internal.pageSize.getHeight();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont(font, 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text(`Shared from FID Trading ERP · Generated ${when(snapshot.generatedAt)}`, margin, height - 7);
    doc.text(`Page ${p} of ${pages}`, pageWidth - margin, height - 7, { align: 'right' });
  }

  return doc.output('blob');
}
