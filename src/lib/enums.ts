/**
 * Enum unions mirrored from the Prisma schema.
 *
 * Importing them from `@prisma/client` in a module that a client component
 * touches would pull the database driver into the browser bundle, so the shapes
 * the shared calculation modules need are declared here instead. They are kept
 * in step with `prisma/schema.prisma` by the type checker: any service that
 * assigns one of these to a Prisma field will fail to compile if they diverge.
 */

export type ContainerType = 'FT20' | 'FT40' | 'FT40HC' | 'LCL' | 'BULK';
export type Incoterm = 'EXW' | 'FCA' | 'FOB' | 'CFR' | 'CIF' | 'DAP' | 'DDP';
export type UnitOfMeasure = 'KG' | 'MT' | 'BAG';
export type PaymentMethodCode = 'CASH' | 'BANK_TRANSFER' | 'CHEQUE';
