/**
 * CSV export.
 *
 * Values are quoted and internal quotes doubled, per RFC 4180, so a coffee name
 * containing a comma cannot shift every subsequent column. A UTF-8 BOM is
 * prepended because Excel otherwise mangles accented origin names.
 */

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // A leading =, +, - or @ is interpreted as a formula by spreadsheet software,
  // so it is prefixed with an apostrophe. Report data should never execute.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(escapeCell).join(','), ...rows.map((row) => row.map(escapeCell).join(','))];
  return `﻿${lines.join('\r\n')}`;
}

/** Triggers a browser download of the given rows. Client-side only. */
export function downloadCsv(filename: string, headers: string[], rows: Array<Array<unknown>>): void {
  const blob = new Blob([toCsv(headers, rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Filename stem with the company and today's date, e.g. `FID-DXB-loading-2026-03-01`. */
export function exportFilename(companyCode: string, report: string): string {
  return `${companyCode}-${report}-${new Date().toISOString().slice(0, 10)}`;
}
