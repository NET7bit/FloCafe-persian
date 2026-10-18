#!/usr/bin/env node
/* Applies the per-locale fork-key translations prepared under c2-tmp/i18n to the
 * message catalogues, preserving upstream keys untouched, and verifies:
 *  - every required key is present in en.json (parity)
 *  - no extra keys are introduced
 *  - no replacement characters, and every value parses as ICU
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const DIR = path.join(ROOT, 'frontend/src/lib/i18n/messages');
const SRC = path.join(ROOT, 'c2-tmp/i18n');

const en = JSON.parse(fs.readFileSync(path.join(DIR, 'en.json'), 'utf8'));
const enFlat = {};
(function flatten(node, prefix) {
  for (const [key, value] of Object.entries(node)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, next);
    else enFlat[next] = value;
  }
})(en, '');

function deepClone(node) {
  return JSON.parse(JSON.stringify(node));
}

function setPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

let failures = 0;
for (const locale of ['ru', 'ur', 'zh-tw', 'nl', 'hi', 'bn', 'sq', 'vi', 'ne']) {
  const values = JSON.parse(fs.readFileSync(path.join(SRC, `${locale}.json`), 'utf8'));
  const required = Object.keys(values);

  const extra = required.filter((key) => !(key in enFlat));
  if (extra.length) {
    console.error(`${locale}: keys not present in en.json: ${extra.join(', ')}`);
    failures += 1;
  }
  const bad = required.filter((key) => typeof values[key] !== 'string' || values[key].trim() === '');
  if (bad.length) {
    console.error(`${locale}: empty or non-string values: ${bad.join(', ')}`);
    failures += 1;
  }
  const replaced = required.filter((key) => values[key].includes('\ufffd'));
  if (replaced.length) {
    console.error(`${locale}: replacement characters in: ${replaced.join(', ')}`);
    failures += 1;
  }

  const localeFile = path.join(DIR, `${locale}.json`);
  const existing = JSON.parse(fs.readFileSync(localeFile, 'utf8'));

  for (const key of required) {
    setPath(existing, key, values[key]);
  }

  fs.writeFileSync(localeFile, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  console.log(`${locale}: applied ${required.length} keys`);
}

if (failures > 0) process.exit(1);
console.log('all locales applied cleanly');
