'use client';

import { createContext, useContext, useMemo } from 'react';
import { currencyOptions as buildOptions, transactionCurrencies } from '@/lib/company-currencies';
import { makeTerms, type Terms } from '@/lib/terminology';

export type CompanyConfig = {
  transactionCurrencies: string[];
  salesCurrencies: string[];
  defaultSalesCurrency: string | null;
  terminology: Record<string, string>;
  /** Which optional item attributes the company's industry offers (lib/item-attributes.ts). */
  attributeSet: string;
};

const CompanyConfigContext = createContext<CompanyConfig | null>(null);

/** The active company's currency lists and wording, for client components. */
export function CompanyConfigProvider({ config, children }: { config: CompanyConfig; children: React.ReactNode }) {
  return <CompanyConfigContext.Provider value={config}>{children}</CompanyConfigContext.Provider>;
}

/** Currencies the active company offers on a money form (see company-currencies.ts). */
export function useTransactionCurrencies(localCurrency: string, keep?: string | null): string[] {
  const config = useContext(CompanyConfigContext);
  return useMemo(
    () => transactionCurrencies(localCurrency, keep, config?.transactionCurrencies),
    [localCurrency, keep, config],
  );
}

/**
 * As `useTransactionCurrencies`, but returns a function — for a spot that
 * cannot call a hook (inside a callback, or after an early return). Get it
 * once at the top of the component and call it wherever the list is needed.
 */
export function useCurrencyLister(): (localCurrency: string, keep?: string | null) => string[] {
  const config = useContext(CompanyConfigContext);
  return useMemo(
    () => (localCurrency, keep) => transactionCurrencies(localCurrency, keep, config?.transactionCurrencies),
    [config],
  );
}

/** The company's chosen currencies, or undefined while it still uses the built-in list. */
export function useConfiguredCurrencies(): string[] | undefined {
  const config = useContext(CompanyConfigContext);
  return config?.transactionCurrencies?.length ? config.transactionCurrencies : undefined;
}

/** The same list as `{ value, label }` options. */
export function useCurrencyOptions(
  localCurrency: string,
  opts: { keep?: string | null; short?: boolean } = {},
): Array<{ value: string; label: string }> {
  const config = useContext(CompanyConfigContext);
  return useMemo(
    () => buildOptions(localCurrency, { ...opts, configured: config?.transactionCurrencies }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opts is read by value
    [localCurrency, opts.keep, opts.short, config],
  );
}

/** Currencies the company invoices in: its sales list, else its transaction list. */
export function useSalesCurrencies(localCurrency: string, keep?: string | null): string[] {
  const config = useContext(CompanyConfigContext);
  return useMemo(() => {
    const sales = config?.salesCurrencies ?? [];
    return sales.length > 0
      ? [...new Set([...(keep ? [keep] : []), ...sales.map((c) => c.toUpperCase())])]
      : transactionCurrencies(localCurrency, keep, config?.transactionCurrencies);
  }, [localCurrency, keep, config]);
}

/** The currency a new sales invoice starts in. */
export function useDefaultSalesCurrency(localCurrency: string): string {
  const config = useContext(CompanyConfigContext);
  return config?.defaultSalesCurrency || localCurrency;
}

/** The industry attribute set offered on the item form. */
export function useAttributeSet(): string {
  return useContext(CompanyConfigContext)?.attributeSet ?? 'general';
}

/** The company's words: `terms('product')`, `terms.lower('customers')`. */
export function useTerms(): Terms {
  const config = useContext(CompanyConfigContext);
  return useMemo(() => makeTerms(config?.terminology), [config]);
}
