const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'frontend/src/lib/i18n/messages');
const en = JSON.parse(fs.readFileSync(path.join(DIR, 'en.json'), 'utf8'));

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const pk = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') Object.assign(out, flatten(v, pk));
    else out[pk] = v;
  }
  return out;
}

const enFlat = flatten(en);
const enKeys = Object.keys(enFlat).sort();
let failures = 0;

for (const locale of ['fa', 'th', 'ru', 'ur', 'zh-tw', 'nl', 'hi', 'bn', 'sq', 'vi', 'ne']) {
  const data = JSON.parse(fs.readFileSync(path.join(DIR, `${locale}.json`), 'utf8'));
  const flat = flatten(data);
  const keys = Object.keys(flat).sort();
  const missing = enKeys.filter(k => !(k in flat));
  const extra = keys.filter(k => !(k in enFlat));
  if (missing.length) {
    console.error(`${locale}: missing ${missing.length} keys (e.g. ${missing.slice(0,3).join(', ')})`);
    failures++;
  }
  if (extra.length) {
    console.error(`${locale}: extra ${extra.length} keys (e.g. ${extra.slice(0,3).join(', ')})`);
    failures++;
  }
  if (!missing.length && !extra.length) {
    console.log(`${locale}: parity OK (${keys.length} keys)`);
  }
}

process.exit(failures > 0 ? 1 : 0);
