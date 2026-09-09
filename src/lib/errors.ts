/**
 * Application error hierarchy.
 *
 * `AppError`s carry a user-safe message and an HTTP status. Anything that is
 * not an `AppError` is treated as an unexpected fault: the technical detail is
 * logged server-side and the user sees a generic message.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The submitted data is not valid.', details?: unknown) {
    super(message, 'VALIDATION_ERROR', 422, details);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'You must sign in to continue.') {
    super(message, 'UNAUTHENTICATED', 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action.') {
    super(message, 'FORBIDDEN', 403);
  }
}

export class NotFoundError extends AppError {
  constructor(entity = 'Record') {
    super(`${entity} was not found.`, 'NOT_FOUND', 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
  }
}

/** Business-rule violation: the request is well-formed but not allowed. */
export class BusinessRuleError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'BUSINESS_RULE', 400, details);
  }
}

export class InsufficientStockError extends BusinessRuleError {
  constructor(batchNumber: string, requestedKg: string, availableKg: string) {
    super(
      `Insufficient stock in batch ${batchNumber}. Requested ${requestedKg} KG but only ${availableKg} KG is available.`,
      { batchNumber, requestedKg, availableKg },
    );
  }
}

/**
 * Turns a database constraint violation into something a person can act on.
 *
 * Prisma reports a duplicate as `PrismaClientKnownRequestError` with code
 * P2002 and an empty message, which reaches the user as "something went
 * wrong" — true, unhelpful, and indistinguishable from a real fault. The
 * constraint name carries what we need: `batches_companyId_batchNumber_key`
 * says a batch number was reused.
 */
const ENTITY_LABELS: Record<string, string> = {
  batches: 'batch',
  lots: 'lot',
  containers: 'container',
  purchase_contracts: 'purchase contract',
  sales_invoices: 'sales invoice',
  goods_receipts: 'goods receipt',
  stock_transfers: 'stock transfer',
  customers: 'customer',
  vendors: 'supplier',
  coffee_items: 'coffee item',
  warehouses: 'warehouse',
  agents: 'agent',
  shipping_lines: 'shipping line',
  expense_categories: 'expense category',
  cash_bank_accounts: 'cash or bank account',
  accounts: 'account',
  users: 'user',
  companies: 'company',
  cheques: 'cheque',
  journal_entries: 'journal entry',
};

const FIELD_LABELS: Record<string, string> = {
  batchNumber: 'batch number',
  lotNumber: 'lot number',
  containerNumber: 'container number',
  contractReference: 'contract reference',
  invoiceNumber: 'invoice number',
  customerCode: 'customer code',
  vendorCode: 'supplier code',
  itemCode: 'item code',
  code: 'code',
  email: 'email address',
  chequeNumber: 'cheque number',
};

function humaniseField(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
}

function describeUniqueViolation(constraint: string): string {
  // e.g. "batches_companyId_batchNumber_key" → entity "batches", field "batchNumber"
  const withoutSuffix = constraint.replace(/_(key|pkey|unique)$/, '');
  const table = Object.keys(ENTITY_LABELS).find((name) => withoutSuffix.startsWith(`${name}_`));
  const fields = (table ? withoutSuffix.slice(table.length + 1) : withoutSuffix)
    .split('_')
    .filter((field) => field !== 'companyId' && field.length > 0);

  const entity = table ? ENTITY_LABELS[table] : 'record';
  if (fields.length === 0) {
    return `That ${entity} already exists.`;
  }
  const list = fields.map(humaniseField).join(' and ');
  return `A ${entity} with that ${list} already exists. Choose a different one.`;
}

type PrismaLikeError = {
  code?: unknown;
  message?: unknown;
  meta?: { target?: unknown; modelName?: unknown; field_name?: unknown } | null;
};

/**
 * Maps a Prisma error to an `AppError`. Returns null when the error is not a
 * recognised database fault, so the caller falls back to the generic message.
 */
export function translateDatabaseError(error: unknown): AppError | null {
  const candidate = error as PrismaLikeError;
  if (!candidate || typeof candidate.code !== 'string') return null;

  const target = candidate.meta?.target;
  const constraint =
    typeof target === 'string'
      ? target
      : Array.isArray(target)
        ? target.join('_')
        : (typeof candidate.message === 'string'
            ? /constraint: `([^`]+)`/.exec(candidate.message)?.[1] ?? ''
            : '');

  switch (candidate.code) {
    case 'P2002':
      return new ConflictError(describeUniqueViolation(constraint));
    case 'P2003':
      return new BusinessRuleError(
        'That record is still referenced by something else, so it cannot be changed or removed.',
      );
    case 'P2025':
      return new NotFoundError('Record');
    case 'P2028':
      return new AppError(
        'The operation took too long and was rolled back; nothing was saved. Please try again.',
        'TRANSACTION_TIMEOUT',
        503,
      );
    default:
      return null;
  }
}

/** Serialises an error for a route handler / server action response. */
export function toErrorResponse(error: unknown): { message: string; code: string; status: number; details?: unknown } {
  if (error instanceof AppError) {
    return { message: error.message, code: error.code, status: error.status, details: error.details };
  }

  const translated = translateDatabaseError(error);
  if (translated) {
    return {
      message: translated.message,
      code: translated.code,
      status: translated.status,
      details: translated.details,
    };
  }

  console.error('[unhandled-error]', error);
  return {
    message: 'Something went wrong while processing the request. Please try again.',
    code: 'INTERNAL_ERROR',
    status: 500,
  };
}
