/**
 * Warehouse transfer numbers: WTO-001, WTO-002, WTO-003.
 *
 * Pure formatting, so screens and the server read a number the same way.
 * Transfers raised before this numbering carry the older system form,
 * FID-MA-ST-000004; that is transfer 4 in the same sequence, so it is shown
 * as WTO-004 and the number 4 is never issued to anything else.
 */

const PREFIX = 'WTO';
const WIDTH = 3;

export function formatTransferNumber(sequence: number): string {
  return `${PREFIX}-${String(sequence).padStart(WIDTH, '0')}`;
}

/** The sequence a stored number occupies, or null when it is not a sequence number. */
export function parseTransferSequence(transferNumber: string): number | null {
  const value = transferNumber.trim();
  const current = /^WTO-(\d+)$/i.exec(value);
  if (current) return Number(current[1]);
  const legacy = /-ST-(\d+)$/.exec(value);
  if (legacy) return Number(legacy[1]);
  return null;
}

/** What a person reads: WTO-004 whichever form the record was stored in. */
export function transferNumberLabel(transferNumber: string): string {
  const sequence = parseTransferSequence(transferNumber);
  return sequence === null ? transferNumber : formatTransferNumber(sequence);
}
