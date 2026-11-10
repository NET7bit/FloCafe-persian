import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRIES, getCountryByCode } from '../main/countries';
import { listSupportedCurrencyCodes } from '../shared/currencies';

test('IR country profile properties', () => {
  const ir = getCountryByCode('IR');
  assert.ok(ir, 'IR country profile should exist');
  assert.equal(ir.code, 'IR');
  assert.equal(ir.locale, 'fa-IR');
  assert.equal(ir.currency, 'IRR');
  assert.equal(ir.timezone, 'Asia/Tehran');
  assert.equal(ir.dialCode, '+98');
  assert.equal(ir.taxIdLabel, 'Economic Code');
  assert.equal(ir.taxName, 'VAT');
  assert.equal(ir.taxIdFormat, undefined, 'No tax ID format should be enforced for IR');
});

test('selectable country catalogue is Iran-only', () => {
  assert.equal(COUNTRIES.length, 1, 'exactly one selectable country');
  assert.equal(COUNTRIES[0].code, 'IR');
});

test('selectable currency catalogue is IRR-only', () => {
  assert.deepEqual(listSupportedCurrencyCodes(), ['IRR']);
});
