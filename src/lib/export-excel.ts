/**
 * Download the rows on screen as a real Excel file.
 *
 * The workbook is written on the server — an .xlsx is a zip of XML and putting
 * a spreadsheet library in the browser bundle to build one would cost every
 * page load. The rows travel up because only the browser knows which ones the
 * user is actually looking at after searching, filtering and sorting.
 */

export type ExcelColumnType = 'text' | 'number' | 'money' | 'quantity' | 'date' | 'integer' | 'percent';

export type ExcelCell = string | number | null;

export async function downloadExcel(params: {
  title: string;
  subtitle?: string;
  columns: Array<{ header: string; type?: ExcelColumnType }>;
  rows: ExcelCell[][];
  totals?: string[];
}): Promise<void> {
  const response = await fetch('/api/export/table', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    // Never a raw status code. The caller shows this as it stands.
    const message = await response
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => null);
    throw new Error(message ?? 'The export could not be prepared. Please try again.');
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filenameFrom(response.headers.get('Content-Disposition')) ?? 'export.xlsx';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** The server names the file; this reads that name back off the response. */
function filenameFrom(disposition: string | null): string | null {
  const match = disposition?.match(/filename="([^"]+)"/);
  return match ? match[1] : null;
}
