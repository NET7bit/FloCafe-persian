/** Receipt and KOT language policy settings bridge to tenant settings store. */
import { PRINT_LABEL_LANGUAGES } from '../print/print-labels.generated';
import {
  defaultPrintLanguagePolicy,
  parseKotLanguagePolicy,
  parsePrintLanguagePolicy,
  type KotLanguagePolicy,
  type LanguageRegistryFacts,
  type ReceiptLanguagePolicy,
} from '../../shared/print';

export const BILL_LANGUAGE_POLICY_KEY = 'bill_language_policy';
export const KOT_LANGUAGE_POLICY_KEY = 'kot_language_policy';
export const Z_REPORT_LANGUAGE_POLICY_KEY = 'z_report_language_policy';

export const LANGUAGE_POLICY_SETTING_KEYS: ReadonlySet<string> = new Set([
  BILL_LANGUAGE_POLICY_KEY,
  KOT_LANGUAGE_POLICY_KEY,
  Z_REPORT_LANGUAGE_POLICY_KEY,
]);

/** Backend registry view: languages with generated print labels. */
const SELECTABLE_PRINT_LANGUAGES: ReadonlySet<string> = new Set<string>(PRINT_LABEL_LANGUAGES);

const REGISTRY_FACTS: LanguageRegistryFacts = {
  isSelectableLanguage: (code: string) => SELECTABLE_PRINT_LANGUAGES.has(code),
};

/** Canonical JSON stored when a tenant has not customized the policy. */
export function defaultLanguagePolicySettingJson(): string {
  return JSON.stringify(defaultPrintLanguagePolicy());
}

export type LanguagePolicyValidation =
  | { ok: true; stored: string }
  | { ok: false; error: string };

/** Validate an untrusted policy value for a language-policy settings key. */
export function validateLanguagePolicySetting(
  key: string,
  value: unknown,
): LanguagePolicyValidation {
  if (typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ok: false, error: `${key} must be valid policy JSON` };
    }
    return validateLanguagePolicySetting(key, parsed);
  }
  if (key === BILL_LANGUAGE_POLICY_KEY || key === Z_REPORT_LANGUAGE_POLICY_KEY) {
    const result = parsePrintLanguagePolicy(value, REGISTRY_FACTS);
    return result.ok
      ? { ok: true, stored: JSON.stringify(result.policy) }
      : { ok: false, error: `Invalid ${key}: ${result.error}` };
  }
  if (key === KOT_LANGUAGE_POLICY_KEY) {
    const result = parseKotLanguagePolicy(value, REGISTRY_FACTS);
    return result.ok
      ? { ok: true, stored: JSON.stringify(result.policy) }
      : { ok: false, error: `Invalid ${key}: ${result.error}` };
  }
  return { ok: false, error: `${key} is not a language policy key` };
}

export type StoredPrintLanguagePolicy = ReceiptLanguagePolicy | KotLanguagePolicy;

/**
 * Salvage a stored policy that fails strict validation because it names a
 * language the registry no longer carries (the locale-removal case).
 *
 * Rejecting the whole row would silently discard the tenant's valid primary
 * language — and, for receipts, a valid additional one — so only the
 * unregistered parts are dropped. Structural corruption still falls back to
 * the default: this salvage covers registry membership and entry shape, not
 * arbitrary damage. Returns null when the row is not salvageable.
 */
function normalizeStoredPolicy(
  key: string,
  parsed: unknown,
): StoredPrintLanguagePolicy | null {
  if (key !== BILL_LANGUAGE_POLICY_KEY && key !== Z_REPORT_LANGUAGE_POLICY_KEY
    && key !== KOT_LANGUAGE_POLICY_KEY) {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const shape = parsed as Record<string, unknown>;
  for (const field of Object.keys(shape)) {
    if (field !== 'primary' && field !== 'additional') return null;
  }

  const rawPrimary = shape.primary;
  if (typeof rawPrimary !== 'object' || rawPrimary === null || Array.isArray(rawPrimary)) return null;
  const primaryShape = rawPrimary as { mode?: unknown; language?: unknown };
  let primary: { readonly mode: 'inherit' } | { readonly mode: 'fixed'; readonly language: string };
  if (primaryShape.mode === 'inherit') {
    primary = { mode: 'inherit' };
  } else if (primaryShape.mode === 'fixed') {
    if (typeof primaryShape.language !== 'string' || primaryShape.language.trim().length === 0) {
      return null;
    }
    primary = REGISTRY_FACTS.isSelectableLanguage(primaryShape.language)
      ? { mode: 'fixed', language: primaryShape.language }
      : { mode: 'inherit' };
  } else {
    return null;
  }

  const rawAdditional = shape.additional;
  if (rawAdditional !== undefined && !Array.isArray(rawAdditional)) return null;

  const maxAdditional = key === KOT_LANGUAGE_POLICY_KEY ? 0 : 1;
  const kept: string[] = [];
  for (const entry of Array.isArray(rawAdditional) ? rawAdditional : []) {
    if (typeof entry !== 'string' || entry.trim().length === 0) continue;
    if (!REGISTRY_FACTS.isSelectableLanguage(entry)) continue;
    if (primary.mode === 'fixed' && entry === primary.language) continue;
    if (kept.includes(entry)) continue;
    kept.push(entry);
  }

  const additional = kept.slice(0, maxAdditional);
  return additional.length === 0
    ? { primary, additional: [] }
    : { primary, additional: [additional[0]] };
}

/** Lenient read-side parse of a stored policy, falling back to default. */
export function parseStoredLanguagePolicy(
  key: string,
  stored: string | undefined,
): StoredPrintLanguagePolicy {
  const fallback = defaultPrintLanguagePolicy();
  if (!stored) return fallback;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (key === KOT_LANGUAGE_POLICY_KEY) {
      const result = parseKotLanguagePolicy(parsed, REGISTRY_FACTS);
      return result.ok ? result.policy : (normalizeStoredPolicy(key, parsed) ?? fallback);
    }
    const result = parsePrintLanguagePolicy(parsed, REGISTRY_FACTS);
    return result.ok ? result.policy : (normalizeStoredPolicy(key, parsed) ?? fallback);
  } catch {
    return fallback;
  }
}
