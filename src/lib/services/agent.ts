import type { Tx } from '@/lib/db';
import { transaction } from '@/lib/db';
import { BusinessRuleError, ConflictError } from '@/lib/errors';
import { writeAudit } from '@/lib/services/audit';

async function nextAgentCode(tx: Tx, companyId: string): Promise<string> {
  const used = await tx.agent.count({ where: { companyId } });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const code = `AGT-${String(used + 1 + attempt).padStart(4, '0')}`;
    const taken = await tx.agent.findFirst({
      where: { companyId, agentCode: code },
      select: { id: true },
    });
    if (!taken) return code;
  }
  return `AGT-${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Creates an agent from the receipt form: a name is enough. Phone and notes
 * are optional. The code is issued here so nobody has to invent one while
 * recording a collection.
 *
 * Names are not hardcoded anywhere in the product. Whoever collects for the
 * company is a master record, and this is how a new one is added without
 * leaving the voucher.
 */
export async function quickCreateAgent(params: {
  companyId: string;
  userId: string;
  agentName: string;
  phone?: string | null;
  notes?: string | null;
}) {
  const agentName = params.agentName.trim();
  if (!agentName) throw new BusinessRuleError('Enter the agent name.');

  const phone = params.phone?.trim() || null;
  const notes = params.notes?.trim() || null;

  return transaction(async (tx) => {
    const duplicate = await tx.agent.findFirst({
      where: { companyId: params.companyId, agentName: { equals: agentName, mode: 'insensitive' } },
      select: { id: true, agentName: true, status: true },
    });
    if (duplicate) {
      if (duplicate.status !== 'ACTIVE') {
        throw new ConflictError(
          `${duplicate.agentName} already exists but is inactive. Reactivate them on the Agents page.`,
        );
      }
      throw new ConflictError(`${duplicate.agentName} is already an agent. Choose them from the list.`);
    }

    const agentCode = await nextAgentCode(tx, params.companyId);
    const created = await tx.agent.create({
      data: {
        companyId: params.companyId,
        agentCode,
        agentName,
        phone,
        notes,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        agentName: true,
        agentCode: true,
        phone: true,
      },
    });

    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'AGENT_CREATED',
      entityType: 'Agent',
      entityId: created.id,
      after: { agentCode: created.agentCode, agentName: created.agentName },
    });

    return created;
  });
}
