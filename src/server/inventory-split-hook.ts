import 'server-only';
import { after } from 'next/server';
import { restateInventorySplit } from '@/lib/services/inventory-split';

/**
 * After a posting that moves cost — a sale, a credit note, a shipment cost, a
 * receipt, a rate edit — put the ledger's stock / cost-of-sales line back
 * where the costing has it. Runs once the response has gone, so nobody waits
 * on it, and never fails the action that scheduled it: a restatement that
 * cannot be made is left for the Consistency page to show.
 */
export function scheduleInventorySplit(user: { id: string; activeCompany: { id: string } }, trigger: string): void {
  try {
    after(async () => {
      try {
        const result = await restateInventorySplit({ companyId: user.activeCompany.id, userId: user.id, trigger });
        if (!result.posted && result.reason !== 'in step') console.warn(`[inventory-split] ${trigger}: ${result.reason}`);
      } catch (error) {
        console.error('[inventory-split]', trigger, error);
      }
    });
  } catch {
    // Outside a request (a script, a test) there is nothing to schedule on.
  }
}
