/**
 * Backend print-language policy settings glue (#441, epic #438).
 *
 * Covers main/lib/print-language-settings.ts, which bridges the neutral
 * shared kernel to the tenant settings store:
 *   - valid policies (JSON string or object) normalize to canonical JSON;
 *   - invalid payloads are rejected with a reason (unknown language,
 *     duplicate additional entry, >1 additional entry, bad JSON);
 *   - stored values parse leniently and fall back to inherit/none defaults;
 *   - all three settings keys are exposed for the wildcard allowlist.
 *
 * Run: npm run test:print-kernel
 */

import assert from 'node:assert/strict';

import {
  BILL_LANGUAGE_POLICY_KEY,
  KOT_LANGUAGE_POLICY_KEY,
  Z_REPORT_LANGUAGE_POLICY_KEY,
  LANGUAGE_POLICY_SETTING_KEYS,
  defaultLanguagePolicySettingJson,
  parseStoredLanguagePolicy,
  validateLanguagePolicySetting,
} from '../main/lib/print-language-settings';

console.log('Testing language-policy settings keys...');
assert.deepEqual(
  [...LANGUAGE_POLICY_SETTING_KEYS].sort(),
  ['bill_language_policy', 'kot_language_policy', 'z_report_language_policy'],
);

console.log('✓ keys registered');

console.log('Testing default policy payload...');
const defaultValue = JSON.parse(defaultLanguagePolicySettingJson());
assert.deepEqual(defaultValue, { primary: { mode: 'inherit' }, additional: [] });
// Defaults must resolve to exactly the store language (pre-#441 behavior).
const parsed = parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY, undefined);
assert.deepEqual(parsed, { primary: { mode: 'inherit' }, additional: [] });

console.log('✓ inherit/none default preserves current behavior');

console.log('Testing valid payloads normalize to canonical JSON...');

const objectPayload = validateLanguagePolicySetting(BILL_LANGUAGE_POLICY_KEY, {
  primary: { mode: 'inherit' },
  additional: [],
});
assert.ok(objectPayload.ok);
if (objectPayload.ok) {
  assert.equal(objectPayload.stored, '{"primary":{"mode":"inherit"},"additional":[]}');
}

const stringPayload = validateLanguagePolicySetting(BILL_LANGUAGE_POLICY_KEY,
  '{"primary":{"mode":"fixed","language":"fa"},"additional":["en"]}');
assert.ok(stringPayload.ok);
if (stringPayload.ok) {
  const stored = JSON.parse(stringPayload.stored);
  assert.deepEqual(stored.primary, { mode: 'fixed', language: 'fa' });
  assert.deepEqual(stored.additional, ['en']);
}

const kotFixed = validateLanguagePolicySetting(KOT_LANGUAGE_POLICY_KEY,
  '{"primary":{"mode":"fixed","language":"fa"},"additional":[]}');
assert.ok(kotFixed.ok);
const zFixed = validateLanguagePolicySetting(Z_REPORT_LANGUAGE_POLICY_KEY,
  '{"primary":{"mode":"fixed","language":"fa"},"additional":["en"]}');
assert.ok(zFixed.ok);
if (zFixed.ok) {
  assert.equal(zFixed.stored, '{"primary":{"mode":"fixed","language":"fa"},"additional":["en"]}');
}

console.log('✓ canonical storage');

console.log('Testing invalid payloads are rejected...');
const rejections: Array<[string, unknown]> = [
  [BILL_LANGUAGE_POLICY_KEY, 'not json'],
  [BILL_LANGUAGE_POLICY_KEY, '{"primary":{"mode":"fixed","language":"xx"}}'],
  [BILL_LANGUAGE_POLICY_KEY, '{"primary":{"mode":"auto"}}'],
  [BILL_LANGUAGE_POLICY_KEY, '{"primary":{"mode":"inherit"},"additional":["fa","es"]}'],
  [BILL_LANGUAGE_POLICY_KEY, '{"primary":{"mode":"inherit"},"additional":["fa","fa"]}'],
  [BILL_LANGUAGE_POLICY_KEY, '{"primary":{"mode":"inherit"},"bogus":1}'],
  // KOT is single-primary in v1.
  [KOT_LANGUAGE_POLICY_KEY, '{"primary":{"mode":"inherit"},"additional":["fa"]}'],
];
for (const [key, value] of rejections) {
  const result = validateLanguagePolicySetting(key, value);
  assert.ok(!result.ok, `expected rejection: ${key} = ${JSON.stringify(value)}`);
  if (!result.ok) assert.ok(result.error.length > 0);
}
// Non-policy key is rejected outright.
assert.ok(!validateLanguagePolicySetting('timezone', {}).ok);

console.log('✓ strict writer validation');

console.log('Testing lenient reader fallbacks...');
// Malformed or invalid stored rows fall back to defaults; printing never
// breaks because of one bad settings row.
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY, '{broken'),
  { primary: { mode: 'inherit' }, additional: [] },
);
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY, '{"primary":{"mode":"fixed","language":"xx"}}'),
  { primary: { mode: 'inherit' }, additional: [] },
);
const okStored = parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY,
  '{"primary":{"mode":"fixed","language":"fa"},"additional":["en"]}');
assert.ok('primary' in okStored && okStored.primary.mode === 'fixed');

console.log('✓ lenient reader with safe fallback');

console.log('Testing read-side salvage when a stored policy names a removed locale...');
const DEFAULT_POLICY = { primary: { mode: 'inherit' }, additional: [] };

// A language the generated print registry does not carry (locale removal).
const REMOVED = 'zz';

// Removed primary language -> inherit; nothing else to keep.
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY,
    `{"primary":{"mode":"fixed","language":"${REMOVED}"}}`),
  DEFAULT_POLICY,
);

// Removed primary language, valid additional -> primary inherit, additional kept.
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY,
    `{"primary":{"mode":"fixed","language":"${REMOVED}"},"additional":["fa"]}`),
  { primary: { mode: 'inherit' }, additional: ['fa'] },
);

// Valid fixed primary, removed additional -> primary preserved.
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY,
    `{"primary":{"mode":"fixed","language":"en"},"additional":["${REMOVED}"]}`),
  { primary: { mode: 'fixed', language: 'en' }, additional: [] },
);

// Removed additional next to a valid one -> only the removed entry is dropped.
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY,
    `{"primary":{"mode":"inherit"},"additional":["${REMOVED}","fa"]}`),
  { primary: { mode: 'inherit' }, additional: ['fa'] },
);

// Non-string and blank entries are dropped; the valid entry survives.
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY,
    '{"primary":{"mode":"inherit"},"additional":[42,"","   ","fa"]}'),
  { primary: { mode: 'inherit' }, additional: ['fa'] },
);

// Non-array additional is structural damage, not a removed locale -> default.
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY,
    '{"primary":{"mode":"inherit"},"additional":"fa"}'),
  DEFAULT_POLICY,
);

// Duplicates collapse to the first occurrence.
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY,
    '{"primary":{"mode":"inherit"},"additional":["fa","fa"]}'),
  { primary: { mode: 'inherit' }, additional: ['fa'] },
);

// An additional entry equal to the fixed primary is a conflict -> removed.
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY,
    '{"primary":{"mode":"fixed","language":"en"},"additional":["en"]}'),
  { primary: { mode: 'fixed', language: 'en' }, additional: [] },
);

// Receipt cap: at most one additional, first surviving entry wins.
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY,
    '{"primary":{"mode":"inherit"},"additional":["fa","en"]}'),
  { primary: { mode: 'inherit' }, additional: ['fa'] },
);

// Ordering: filter -> dedupe -> conflict removal -> cap.
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY,
    `{"primary":{"mode":"fixed","language":"en"},"additional":["${REMOVED}","en","fa"]}`),
  { primary: { mode: 'fixed', language: 'en' }, additional: ['fa'] },
);

// KOT cap: no additional entry survives.
assert.deepEqual(
  parseStoredLanguagePolicy(KOT_LANGUAGE_POLICY_KEY,
    '{"primary":{"mode":"fixed","language":"en"},"additional":["fa"]}'),
  { primary: { mode: 'fixed', language: 'en' }, additional: [] },
);

// Unknown top-level key and broken primary stay on the default path.
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY,
    '{"primary":{"mode":"inherit"},"bogus":1}'),
  DEFAULT_POLICY,
);
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY, '{"primary":{"mode":"auto"}}'),
  DEFAULT_POLICY,
);
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY,
    '{"primary":{"mode":"fixed","language":"   "}}'),
  DEFAULT_POLICY,
);

// Regression: fully valid policies keep their exact previous output.
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY,
    '{"primary":{"mode":"fixed","language":"fa"},"additional":["en"]}'),
  { primary: { mode: 'fixed', language: 'fa' }, additional: ['en'] },
);
assert.deepEqual(
  parseStoredLanguagePolicy(Z_REPORT_LANGUAGE_POLICY_KEY,
    '{"primary":{"mode":"inherit"},"additional":[]}'),
  DEFAULT_POLICY,
);

console.log('✓ read-side salvage preserves valid parts and keeps structural defaults');

console.log('✓ Z-report policy normalizes through the public policy contract');
console.log('\nAll print-language settings tests passed.');
