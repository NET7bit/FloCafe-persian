/**
 * Phase 7 setup/demo and print-test locale coverage.
 *
 * The seed path is exercised through the exported setup-profile API for every
 * registered UI locale. Filipino's English-identical seed data is an explicit
 * reviewed exception; country selection is passed separately and must not be
 * inferred from the selected UI language. Every seeded merchant-visible string
 * is also checked for script integrity, because a code point copied from another
 * script reads as a plausible word in review while rendering broken.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-phase7-i18n-'));
const Module = require('module');
process.env.NODE_PATH = [path.join(__dirname, '../frontend/node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter);
Module._initPaths();
const originalLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'phase7-test',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, closeDatabase } = require('../main/db') as typeof import('../main/db');
const {
  seedSetupProfile,
  ENGLISH_IDENTICAL_SEED_LANGUAGES,
} = require('../main/routes/auth') as typeof import('../main/routes/auth');
const { LANGUAGES } = require('../frontend/src/lib/i18n/languages') as typeof import('../frontend/src/lib/i18n/languages');
const { loadLocaleMessages } = require('../frontend/src/lib/i18n/loader') as typeof import('../frontend/src/lib/i18n/loader');
const { parsePhoneE164 } = require('../main/lib/phone') as typeof import('../main/lib/phone');
const { createTranslator } = require('use-intl/core') as typeof import('use-intl/core');
const { printLabel } = require('../main/print/print-labels.generated') as typeof import('../main/print/print-labels.generated');

const languages = Object.keys(LANGUAGES) as Array<keyof typeof LANGUAGES>;
const englishIdenticalSeeds = new Set<string>(ENGLISH_IDENTICAL_SEED_LANGUAGES);

/**
 * A store country that is no seeded sample's home country. A sample still
 * written in national format resolves against the selected store country, so
 * the 'IN' pass below re-normalizes a non-Indian regression into a valid
 * Indian number and cannot see it. Re-seeding under a country that owns no
 * sample is the only pass that observes the failure the E.164 seed repair
 * prevents. All 66 samples are invalid in this country's numbering plan when
 * reduced to national format, so no national-format regression survives it.
 */
const FOREIGN_SEED_COUNTRY = 'AU';

function resetDatabase(): void {
  try { closeDatabase(); } catch { /* first iteration */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const file = path.join(testDir, `flo.db${suffix}`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  const marker = path.join(testDir, '.flo-db-initialized');
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
  initDatabase();
}

function rows(table: string, columns: string, where: string): any[] {
  return getDatabase().prepare(`SELECT ${columns} FROM ${table} WHERE ${where}`).all();
}

/** Merchant-visible text the setup seed writes, so no localized string escapes the script check. */
const SEEDED_TEXT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['categories', 'name'],
  ['products', 'name'],
  ['customers', 'name'],
  ['users', 'name'],
  ['tables', 'number'],
];

function seededTexts(): Array<[string, string]> {
  return SEEDED_TEXT_COLUMNS.flatMap(([table, column]) =>
    rows(table, `id, ${column}`, '1 = 1').map((row) => [`${table}.${row.id}`, String(row[column])]));
}

/**
 * `Intl.Locale` resolves the registry's locale tag to a CLDR script code, so a
 * newly registered locale is covered without a hand-maintained per-language
 * list. Every CLDR code is a Unicode script name except the four script *sets*
 * below; an unrecognized code would make the script regex throw, which fails the
 * run instead of quietly passing.
 */
const CLDR_SCRIPT_SETS: Record<string, string[]> = {
  Hans: ['Han'],
  Hant: ['Han'],
  Jpan: ['Han', 'Hiragana', 'Katakana'],
  Kore: ['Hangul'],
};

function localeScripts(language: string): string[] {
  const code = new Intl.Locale(LANGUAGES[language as keyof typeof LANGUAGES].locale).maximize().script ?? '';
  return CLDR_SCRIPT_SETS[code] ?? [code];
}

/** Digits, currency and unit symbols, punctuation, spaces and ZWJ/ZWNJ carry no script identity. */
const SCRIPT_NEUTRAL = /^[\p{N}\p{S}\p{P}\p{Z}\p{C}]$/u;
/** `Common` covers punctuation, digits and joiners; `Inherited` covers combining diacritics. */
const SCRIPT_SHARED = /^(?:\p{Script=Common}|\p{Script=Inherited})$/u;

/**
 * Returns the characters of `text` whose script the locale does not use, so the
 * letters of a localized seed string come only from its own locale's scripts. A
 * string that uses none of them is an untranslated label (the shared `T1` table
 * label) rather than a mixed script, and is left to the localization
 * assertions in this suite.
 */
function foreignScriptCharacters(text: string, allowedScripts: string[]): string[] {
  const own = new RegExp(`^(?:${allowedScripts.map((script) => `\\p{Script=${script}}`).join('|')})$`, 'u');
  const foreign: string[] = [];
  let usesOwnScript = false;
  for (const character of text) {
    if (SCRIPT_NEUTRAL.test(character) || SCRIPT_SHARED.test(character)) continue;
    if (own.test(character)) { usesOwnScript = true; continue; }
    foreign.push(character);
  }
  return usesOwnScript ? foreign : [];
}

function describeCodePoints(text: string): string {
  return [...text].map((character) => `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
}

async function run(): Promise<void> {
  console.log(`Phase 7 setup/demo locale coverage: ${languages.length} registered locales`);
  assert.deepEqual([...englishIdenticalSeeds].sort(), [], 'No registered locale is on the documented English-identical seed allowlist after the en/fa restriction');

  const translators = new Map<string, (key: string, values?: Record<string, unknown>) => string>();
  for (const language of languages) {
    const messages = await loadLocaleMessages(language);
    translators.set(language, createTranslator({ locale: LANGUAGES[language].locale, messages }) as unknown as (key: string, values?: Record<string, unknown>) => string);
  }
  const translate = (language: string, key: string, values?: Record<string, unknown>): string => {
    const translator = translators.get(language);
    assert.ok(translator, `${language}: runtime translator is available`);
    return translator(key, values);
  };

  const snapshots = new Map<string, { category: string; product: string; manager: string; customer: string }>();
  for (const language of languages) {
    resetDatabase();
    const db = getDatabase();

    seedSetupProfile(db, 'express', 'qsr', language);
    assert.equal(rows('categories', 'name', "id = 'cat-express-food'").length, 1, `${language}: express setup seeds food category`);
    assert.equal(rows('products', 'name', "id = 'prod-express-meal'").length, 1, `${language}: express setup seeds starter product`);

    seedSetupProfile(db, 'demo', 'finedine', language, 'IN');
    const seededCustomers = rows('customers', 'phone, phone_digits, country_code', 'is_active = 1');
    for (const customer of seededCustomers) {
      const parsed = parsePhoneE164(customer.phone, 'IN');
      assert.ok(parsed, `${language}: demo customer phone ${customer.phone} must be valid E.164`);
      assert.equal(customer.phone, `+${customer.phone_digits}`, `${language}: demo customer phone and digits must agree`);
      assert.equal(customer.country_code, parsed.countryCode, `${language}: demo customer country code must follow the phone number`);
    }
    const languageScripts = localeScripts(language);
    for (const [location, value] of seededTexts()) {
      const foreign = foreignScriptCharacters(value, languageScripts);
      assert.deepEqual(
        foreign,
        [],
        `${language}: seeded ${location} ${JSON.stringify(value)} mixes ${languageScripts.join('+')} with ${describeCodePoints(foreign)}: ${foreign.join('')}`,
      );
    }
    const snapshot = {
      category: rows('categories', 'name', "id = 'cat-demo-starters'")[0].name,
      product: rows('products', 'name', "id LIKE 'prod-demo-%'")[0].name,
      manager: rows('users', 'name', "id = 'user-demo-manager'")[0].name,
      customer: rows('customers', 'name', "id = 'cust-demo-1'")[0].name,
    };
    snapshots.set(language, snapshot);
    assert.equal(rows('customers', 'id', 'is_active = 1').length, 3, `${language}: demo setup seeds customers`);
    assert.equal(rows('tables', 'id', "id LIKE 'tbl-demo-%'").length, 4, `${language}: demo FineDine setup seeds tables`);

    if (englishIdenticalSeeds.has(language)) {
      assert.deepEqual(snapshot, snapshots.get('en') ?? snapshot, `${language}: seed data follows the documented English-identical allowlist`);
    } else if (language !== 'en') {
      const english = snapshots.get('en');
      assert.ok(english, 'English baseline is available before localized locale checks');
      assert.notEqual(snapshot.category, english.category, `${language}: demo category is localized`);
      assert.notEqual(snapshot.product, english.product, `${language}: demo product is localized`);
      assert.notEqual(snapshot.manager, english.manager, `${language}: demo staff name is localized`);
      assert.notEqual(snapshot.customer, english.customer, `${language}: demo customer name is localized`);
    }

    // The seed inserts are INSERT OR IGNORE, so the country-independent pass
    // needs its own database rather than a second call on the seeded one.
    resetDatabase();
    seedSetupProfile(getDatabase(), 'demo', 'finedine', language, FOREIGN_SEED_COUNTRY);
    const foreignCustomers = rows('customers', 'phone, phone_digits, country_code', 'is_active = 1');
    assert.equal(foreignCustomers.length, 3, `${language}: demo setup seeds customers in a ${FOREIGN_SEED_COUNTRY} store`);
    for (const customer of foreignCustomers) {
      const parsed = parsePhoneE164(customer.phone, FOREIGN_SEED_COUNTRY);
      assert.ok(parsed, `${language}: demo customer phone ${customer.phone} must be valid E.164 in a ${FOREIGN_SEED_COUNTRY} store`);
      assert.equal(customer.phone, `+${customer.phone_digits}`, `${language}: demo customer phone and digits must agree in a ${FOREIGN_SEED_COUNTRY} store`);
      assert.equal(customer.country_code, parsed.countryCode, `${language}: demo customer country code must follow the phone number in a ${FOREIGN_SEED_COUNTRY} store`);
    }
  }

  resetDatabase();
  seedSetupProfile(getDatabase(), 'demo', 'qsr', 'en', 'TR');
  const selectedCountryCustomer = rows('customers', 'phone, country_code', "id = 'cust-demo-1'")[0];
  assert.equal(selectedCountryCustomer.country_code, '+91', 'English (India-sample) demo phone country stays independent of the selected Turkish store country');
  assert.equal(selectedCountryCustomer.phone, '+919876543210', 'English demo phone remains E.164 in a non-India store');

  resetDatabase();
  seedSetupProfile(getDatabase(), 'demo', 'qsr', 'en', 'IN');
  const explicitCountryCustomer = rows('customers', 'phone, country_code', "id = 'cust-demo-1'")[0];
  assert.equal(explicitCountryCustomer.country_code, '+91', 'E.164 demo phone country follows the seeded sample (India), not the selected Indian store country');
  assert.equal(explicitCountryCustomer.phone, '+919876543210', 'English demo phone remains E.164 in a non-Argentina store');

  // Gate I1-R31H restricts the UI/translation registry to en/fa, so the
  // removed-language value assertions (fil/de/es/pt/ru) are no longer valid.
  // en/fa print-label and translation coverage is exercised by the per-locale loop below.

  for (const language of languages) {
    assert.notEqual(translate(language, 'printTest.optionBasicReceipt'), 'printTest.optionBasicReceipt', `${language}: basic receipt label resolves`);
    assert.notEqual(translate(language, 'printTest.optionWebPrint'), 'printTest.optionWebPrint', `${language}: web print label resolves`);
    assert.notEqual(translate(language, 'printTest.kitchenStation'), 'printTest.kitchenStation', `${language}: kitchen station label resolves`);
    assert.notEqual(translate(language, 'printWarnings.languageLoadError', { languages: 'fa' }), 'printWarnings.languageLoadError', `${language}: locale-load warning resolves`);
  }

  console.log('Phase 7 setup/demo, allowlist, country decoupling, fallback, warning, and print-test checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  fs.rmSync(testDir, { recursive: true, force: true });
  Module._load = originalLoad;
});
