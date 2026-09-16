/**
 * How a master record (customer, supplier, item, …) gets its unique code.
 *
 * The form may omit the code on create — the server then issues CUS-0001 and
 * so on. On edit the form often omits the same field because it is not shown.
 * Treating that omission as “issue a new code” collides with the next number
 * and the save fails, or silently renames a live customer. Blank on create
 * generates; blank on edit keeps the existing code.
 */
export function resolveMasterCode(params: {
  submitted: unknown;
  existing?: unknown;
  isCreate: boolean;
}): { code: string } | { generate: true } {
  const submitted = String(params.submitted ?? '').trim();
  if (submitted) return { code: submitted };
  if (!params.isCreate) {
    const existing = String(params.existing ?? '').trim();
    if (existing) return { code: existing };
  }
  return { generate: true };
}
