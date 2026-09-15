import { prisma } from '@/lib/db';

/**
 * Optional container/batch on an expense.
 *
 * The Prisma model has these fields, but the live database was created before
 * they existed. Selecting or writing them throws P2022 and the expense screen
 * dies. Detect once per process and skip those columns until they are there.
 */

type QueryClient = { $queryRaw: (typeof prisma)['$queryRaw'] };

export const EXPENSE_TRACE_OMIT = { containerId: true, batchId: true } as const;

let cached: boolean | undefined;

export async function expensesHaveTraceColumns(client: QueryClient = prisma): Promise<boolean> {
  if (cached !== undefined) return cached;
  const rows = await client.$queryRaw<Array<{ present: boolean | string }>>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'expenses'
        AND column_name = 'batchId'
    ) AS present
  `;
  const value = rows[0]?.present;
  cached = value === true || value === 't' || value === 'true';
  return cached;
}

export async function expenseTraceWrite(
  client: QueryClient,
  input: { containerId?: string | null; batchId?: string | null },
) {
  if (!(await expensesHaveTraceColumns(client))) return {};
  return {
    containerId: input.containerId ?? null,
    batchId: input.batchId ?? null,
  };
}

export function expenseTraceIds(expense: object, hasTrace: boolean) {
  if (!hasTrace) return { containerId: null, batchId: null };
  const row = expense as { containerId?: string | null; batchId?: string | null };
  return {
    containerId: row.containerId ?? null,
    batchId: row.batchId ?? null,
  };
}
