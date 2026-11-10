/**
 * Currency catalogue for FloCafe.
 *
 * The product is scoped to a single regional catalogue: the Iranian Rial (IRR)
 * and its display units (toman / toman-short) which are handled as rendering
 * preferences in `main/countries.ts`, never as separate currency codes.
 *
 * Two distinct concerns are kept separate on purpose:
 *  - `listSupportedCurrencyCodes()` / `POPULAR_CURRENCY_CODES` are the
 *    SELECTABLE catalogue offered in the UI (settings, setup). They are
 *    restricted to IRR only, so no other currency can be chosen.
 *  - `isSupportedCurrencyCode()` / `normalizeSupportedCurrencyCode()` are a
 *    GENERAL validator for stored / arbitrary currency input. They stay broad
 *    (any ISO-4217 code) so existing tenant currencies, telemetry, and
 *    cloud-sync registration keep working and no stored value is ever rejected
 *    or rewritten (product invariant: do not break prior data).
 */

/** Selectable currency catalogue — the only currency offered in the UI. */
export const SUPPORTED_CURRENCY_CODES = ['IRR'] as const;

/** Popular currencies shown in the UI picker; restricted to the single catalogue entry. */
export const POPULAR_CURRENCY_CODES = ['IRR'] as const;

const RESERVED_CURRENCY_CODES = new Set(['XXX', 'XTS']);

/** Selectable currency catalogue (UI). Iran-only per product scope. */
export function listSupportedCurrencyCodes(): string[] {
  return [...SUPPORTED_CURRENCY_CODES];
}

/**
 * Full set of ISO-4217 codes recognised for stored / arbitrary input. Kept broad
 * so historical tenant currencies and cloud registration remain valid.
 */
function listAllCurrencyCodes(): string[] {
  try {
    return Intl.supportedValuesOf('currency')
      .map((code) => code.toUpperCase())
      .filter((code) => /^[A-Z]{3}$/.test(code) && !RESERVED_CURRENCY_CODES.has(code));
  } catch {
    return [...SUPPORTED_CURRENCY_CODES];
  }
}

export function normalizeSupportedCurrencyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return listAllCurrencyCodes().includes(normalized) ? normalized : null;
}

export function isSupportedCurrencyCode(value: unknown): value is string {
  return normalizeSupportedCurrencyCode(value) !== null;
}

export function getCurrencyDisplayName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'currency' }).of(code) || code;
  } catch {
    return code;
  }
}
