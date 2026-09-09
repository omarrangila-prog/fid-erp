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

/** Serialises an error for a route handler / server action response. */
export function toErrorResponse(error: unknown): { message: string; code: string; status: number; details?: unknown } {
  if (error instanceof AppError) {
    return { message: error.message, code: error.code, status: error.status, details: error.details };
  }
  console.error('[unhandled-error]', error);
  return {
    message: 'Something went wrong while processing the request. Please try again.',
    code: 'INTERNAL_ERROR',
    status: 500,
  };
}
