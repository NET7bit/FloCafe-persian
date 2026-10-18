/**
 * SEC-02 regression tests — cloud API key envelope (flosec1).
 *
 * The cloud API key must only ever be persisted as a `flosec1:` envelope
 * produced by OS-backed `safeStorage`. Legacy plaintext rows are migrated
 * lazily, but only when secure storage is genuinely available; otherwise the
 * key is withheld (fail-closed) without being deleted or rewritten. A corrupt
 * envelope must never reach the network, API responses, the UI or logs.
 *
 * The test database lives in a throwaway temp directory (the electron `app`
 * mock reports `isPackaged: true` and `getPath() -> testDir`), so the real
 * install database is never opened or modified. All HTTP traffic stays on
 * loopback; no external request is made.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as crypto from 'node:crypto';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cloud-key-sec02-'));

// Pin the JWT secret before the auth module is first used. The shared test
// harness only sets process.env.JWT_SECRET when it is absent, while the secret
// is generated and cached during initTestDb(); a cleared cache would then pick
// up the harness value instead of the database row and invalidate tokens that
// were minted earlier in this test. A fixed secret keeps the harness auth
// stable across the settings import, which clears the JWT secret cache.
const ORIGINAL_JWT_SECRET_ENV = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'test-secret-cloud-api-key-encryption';

// The isolated test database must stay inside the temp directory.
if (process.env.FLO_E2E_DB_PATH) {
  throw new Error('Refusing to run with FLO_E2E_DB_PATH set: the test database would escape the temp directory');
}

// Controllable safeStorage stand-in. The "ciphertext" carries a visible marker
// so tests can prove that envelopes are distinct from plaintext.
const ENC_MARKER = 'enc(';
const secureState = { available: true };

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => secureState.available,
        getSelectedStorageBackend: () => (secureState.available ? 'dpapi' : 'basic_text'),
        encryptString: (value: string) => Buffer.from(`${ENC_MARKER}${value})`, 'utf8'),
        decryptString: (buffer: Buffer) => {
          const text = buffer.toString('utf8');
          if (!text.startsWith(ENC_MARKER) || !text.endsWith(')')) throw new Error('decrypt failed');
          return text.slice(ENC_MARKER.length, -1);
        },
      },
    };
  }
  return originalLoad.apply(this, arguments as never);
};

const request = require('supertest');
const {
  initTestDb,
  seedOwnerUser,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  getDatabase,
  createApp,
} = require('./helpers/test-setup');
const { settingsRoutes } = require('../main/routes/settings');
const { databaseRoutes } = require('../main/routes/database');
const { cloudSync } = require('../main/services/cloud-sync');
const { decryptSecret, isEncryptedSettingValue } = require('../main/services/secure-settings');
const {
  createBackup,
  restoreBackup,
  captureRestoreProtectedSettings,
  mergeRestoreProtectedSettings,
  getCurrentSchemaVersion,
  now,
} = require('../main/db');

const CLOUD_KEY = 'cloud_api_key';
const SECRET_A = 'cloud-secret-alpha-0001';
const SECRET_B = 'cloud-secret-bravo-0002';
const ROTATED = 'cloud-secret-rotated-9999';

// Typed view over the service internals under test (private members).
const sync = cloudSync as unknown as {
  settings: { api_key: string } | null;
  reload: () => void;
  signedFetch: (pathname: string, init: RequestInit) => Promise<Response>;
  buildSignedHeaders: (apiKey: string, posHash: string, method: string, signedPath: string, body: string) => Record<string, string>;
};

type Captured = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
const captured: Captured[] = [];
let nextResponseBody: Record<string, unknown> = { ok: true };

function rawCell(): string {
  const row = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(CLOUD_KEY) as { value: string } | undefined;
  return row ? row.value : '';
}

function allSettingValues(): string[] {
  const rows = getDatabase().prepare('SELECT value FROM settings').all() as { value: string }[];
  return rows.map((row) => String(row.value));
}

function setSettings(entries: Record<string, string>) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  for (const [key, value] of Object.entries(entries)) stmt.run(key, value, now());
}

async function run() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      captured.push({ method: req.method || '', url: req.url || '', headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(nextResponseBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const serverUrl = `http://127.0.0.1:${port}`;

  try {
    initTestDb();
    const db = getDatabase();
    const owner = seedOwnerUser(db);
    const app = createApp({ '/api/settings': settingsRoutes, '/api/database': databaseRoutes });

    console.log('SEC-02 cloud API key envelope tests');
    console.log('='.repeat(50));

    assertEqual(rawCell(), '', 'T-1: fresh database has no cloud API key');

    // ── T-1: write through the API, read back through the service ───────────
    setSettings({ cloud_server_url: serverUrl, cloud_registration_status: 'unregistered' });
    const putWrite = await request(app)
      .put('/api/settings/cloud')
      .set(owner.authHeader)
      .send({ cloud_api_key: SECRET_A });
    assertEqual(putWrite.status, 200, 'T-1: raw key accepted through PUT /settings/cloud');
    assert(rawCell().startsWith('flosec1:'), 'T-1: persisted cell uses the flosec1 envelope');
    assert(!rawCell().includes(SECRET_A), 'T-1: raw secret never appears in the stored cell');
    cloudSync.reload();
    assertEqual(sync.settings?.api_key, SECRET_A, 'T-1: decrypted key round-trips exactly');
    assertEqual(cloudSync.getStatus().cloud_api_key_state, 'ready', 'T-1: state reports ready');
    const cellAfterFirstRead = rawCell();
    cloudSync.reload();
    assertEqual(rawCell(), cellAfterFirstRead, 'T-1: repeated reads do not re-encrypt');

    // ── T-2: legacy plaintext migration ────────────────────────────────────
    setSettings({ [CLOUD_KEY]: SECRET_B });
    assertEqual(rawCell(), SECRET_B, 'T-2: legacy plaintext seeded directly in the cell');
    cloudSync.reload();
    assert(rawCell().startsWith('flosec1:'), 'T-2: legacy plaintext migrated to an envelope');
    assert(!rawCell().includes(SECRET_B), 'T-2: migrated cell no longer contains plaintext');
    assertEqual(sync.settings?.api_key, SECRET_B, 'T-2: migrated value decrypts to the original secret');
    assertEqual(cloudSync.getStatus().cloud_api_key_state, 'ready', 'T-2: state ready after migration');
    const migratedCell = rawCell();
    cloudSync.reload();
    assertEqual(rawCell(), migratedCell, 'T-2: migration is idempotent');

    // ── T-3: corrupt envelope never reaches the network ────────────────────
    const corruptEnvelope = `flosec1:${Buffer.from('not-a-valid-ciphertext').toString('base64')}`;
    setSettings({ [CLOUD_KEY]: corruptEnvelope, cloud_registration_status: 'registered' });
    cloudSync.reload();
    assertEqual(sync.settings?.api_key, '', 'T-3: unreadable envelope yields no key');
    assertEqual(rawCell(), corruptEnvelope, 'T-3: corrupt envelope is left untouched');
    assertEqual(cloudSync.getStatus().cloud_api_key_state, 'unreadable', 'T-3: state reports unreadable');
    assertEqual(cloudSync.isCloudAccountAvailable(), false, 'T-3: cloud account is unavailable');
    const originalFetch = globalThis.fetch;
    let networkAttempts = 0;
    globalThis.fetch = (async () => { networkAttempts += 1; throw new Error('network must not be reached'); }) as typeof fetch;
    let signedFetchError: Error | null = null;
    try {
      await sync.signedFetch('/api/pos/heartbeat', { method: 'POST', body: '{}' });
    } catch (err) {
      signedFetchError = err as Error;
    }
    globalThis.fetch = originalFetch;
    assert(signedFetchError !== null, 'T-3: signed request fails while the key is unreadable');
    assertEqual(networkAttempts, 0, 'T-3: no request is attempted with an unreadable key');
    assert(!JSON.stringify(signedFetchError?.message || '').includes('flosec1'), 'T-3: the error never echoes ciphertext');

    // ── T-4: secure storage unavailable -> fail closed ─────────────────────
    setSettings({ [CLOUD_KEY]: SECRET_B, cloud_registration_status: 'registered' });
    secureState.available = false;
    cloudSync.reload();
    assertEqual(rawCell(), SECRET_B, 'T-4: legacy plaintext is neither deleted nor rewritten');
    assertEqual(sync.settings?.api_key, '', 'T-4: key is withheld when secure storage is unavailable');
    assertEqual(cloudSync.getStatus().cloud_api_key_state, 'legacy_blocked', 'T-4: state reports legacy_blocked');
    assertEqual(cloudSync.isCloudAccountAvailable(), false, 'T-4: cloud account is unavailable (fail-closed)');
    const blockedWrite = await request(app)
      .put('/api/settings/cloud')
      .set(owner.authHeader)
      .send({ cloud_api_key: 'plaintext-must-not-land-4321' });
    assertEqual(blockedWrite.status, 503, 'T-4: new raw key is rejected when secure storage is unavailable');
    assertEqual(rawCell(), SECRET_B, 'T-4: the existing key is untouched after the rejected write');
    assert(!JSON.stringify(blockedWrite.body).includes('plaintext-must-not-land'), 'T-4: rejected value is not echoed back');
    nextResponseBody = { api_key: 'registration-must-not-land-8765', pos_id: 'pos-x', store_id: 'store-x' };
    let registerError: Error | null = null;
    try {
      await cloudSync.register();
    } catch (err) {
      registerError = err as Error;
    }
    assert(registerError !== null, 'T-4: registration fails closed without secure storage');
    assert(!allSettingValues().some((value) => value.includes('registration-must-not-land')), 'T-4: failed registration persists no plaintext key');
    secureState.available = true;
    nextResponseBody = { ok: true };

    // ── T-5: no secret in logs or API responses ────────────────────────────
    setSettings({
      [CLOUD_KEY]: SECRET_A,
      cloud_registration_status: 'registered',
      cloud_services_disabled_by_user: 'false',
      cloud_deletion_status: '',
      cloud_sync_enabled: '1',
      cloud_verification_welcome_requested: '1',
      cloud_server_url: serverUrl,
    });
    const logLines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { logLines.push(args.map(String).join(' ')); };
    cloudSync.reload();
    const cloudStatus = await request(app).get('/api/settings/cloud').set(owner.authHeader);
    const publicSettings = await request(app).get('/api/settings').set(owner.authHeader);
    const signedResponse = await sync.signedFetch('/api/pos/heartbeat', { method: 'POST', body: '{}' });
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    assertEqual(cloudStatus.status, 200, 'T-5: cloud status responds 200');
    assertEqual(signedResponse.status, 200, 'T-5: signed request succeeds against the loopback server');
    const observed = [
      logLines.join('\n'),
      JSON.stringify(cloudStatus.body),
      JSON.stringify(publicSettings.body),
    ].join('\n');
    assert(!observed.includes(SECRET_A), 'T-5: raw secret never appears in logs or API responses');
    // The outbound Authorization header is the one legitimate carrier of the
    // key; it must hold the decrypted secret and never an envelope (see T-7).
    assert(!JSON.stringify(captured.map((entry) => entry.headers)).includes('flosec1'), 'T-5: no envelope is sent on the wire');

    // ── T-6: masking, direct-read rejection, export redaction, restore ─────
    assertEqual(cloudStatus.body.cloud_api_key_state, 'ready', 'T-6: status exposes a secret-free key state');
    const directRead = await request(app).get('/api/settings/cloud_api_key').set(owner.authHeader);
    assertEqual(directRead.status, 403, 'T-6: direct read of the API key stays forbidden');
    assertEqual(publicSettings.body.settings[CLOUD_KEY], `****${SECRET_A.slice(-4)}`, 'T-6: mask suffix comes from the decrypted secret');
    assert(!JSON.stringify(publicSettings.body).includes('flosec1:'), 'T-6: envelopes are never exposed by the settings API');
    const exportRes = await request(app).get('/api/database/export').set(owner.authHeader);
    assertEqual(exportRes.status, 200, 'T-6: export responds 200');
    const exportedSettings = (exportRes.body.data?.settings || []) as { key: string; value: string }[];
    const exportedKeyRow = exportedSettings.find((row) => row.key === CLOUD_KEY);
    assertEqual(exportedKeyRow?.value, '[REDACTED]', 'T-6: export redacts the cloud API key');
    assert(!JSON.stringify(exportRes.body).includes(SECRET_A), 'T-6: export never contains the raw secret');

    // ── T-7: signed transport uses the decrypted key ──────────────────────
    const heartbeatEntry = captured[captured.length - 1];
    assertEqual(heartbeatEntry.headers.authorization, `Bearer ${SECRET_A}`, 'T-7: Authorization carries the decrypted key');
    const expectedBase = [
      'POST',
      '/api/pos/heartbeat',
      String(heartbeatEntry.headers['x-flo-timestamp']),
      String(heartbeatEntry.headers['x-flo-nonce']),
      crypto.createHash('sha256').update('{}').digest('hex'),
    ].join('\n');
    const expectedSignature = `sha256=${crypto.createHmac('sha256', SECRET_A).update(expectedBase).digest('hex')}`;
    assertEqual(heartbeatEntry.headers['x-flo-signature'], expectedSignature, 'T-7: HMAC is computed with the decrypted key');
    assert(!JSON.stringify(heartbeatEntry.headers).includes('flosec1'), 'T-7: no envelope travels on the wire');
    const relayHeaders = sync.buildSignedHeaders(SECRET_A, 'pos-hash-1', 'GET', '/api/pos/relay', '');
    assertEqual(relayHeaders.Authorization, `Bearer ${SECRET_A}`, 'T-7: relay handshake headers use the decrypted key');
    assert(!JSON.stringify(relayHeaders).includes('flosec1'), 'T-7: relay headers contain no envelope');

    // ── T-8: backup/restore keeps the live install identity ───────────────
    setSettings({ [CLOUD_KEY]: 'backup-era-key-4444' });
    const { path: backupPath } = await createBackup();
    setSettings({ [CLOUD_KEY]: SECRET_A });
    cloudSync.reload();
    const preserved = captureRestoreProtectedSettings(getDatabase());
    const restoreResult = restoreBackup(backupPath, true);
    mergeRestoreProtectedSettings(getDatabase(), preserved);
    assertEqual(restoreResult.success, true, 'T-8: backup restore succeeds');
    assert(rawCell().startsWith('flosec1:'), 'T-8: restored database keeps the envelope of the live install');
    cloudSync.reload();
    assertEqual(sync.settings?.api_key, SECRET_A, 'T-8: live cloud identity survives the restore');
    assert(!allSettingValues().some((value) => value.includes('backup-era-key-4444')), 'T-8: the backup copy never overrides the live key');

    // ── T-9: re-registration rotates the key ──────────────────────────────
    setSettings({
      cloud_registration_status: 'registered',
      cloud_verification_welcome_requested: '1',
      cloud_deletion_status: '',
      cloud_server_url: serverUrl,
      cloud_sync_enabled: '1',
    });
    const cellBeforeRotation = rawCell();
    nextResponseBody = { api_key: ROTATED, pos_id: 'pos-9', store_id: 'store-9' };
    await cloudSync.register();
    nextResponseBody = { ok: true };
    assert(isEncryptedSettingValue(rawCell()), 'T-9: rotated key is stored as a flosec1 envelope');
    assertEqual(decryptSecret(rawCell()), ROTATED, 'T-9: stored envelope decrypts to the rotated secret');
    assert(!rawCell().includes(ROTATED), 'T-9: the rotated secret is not stored in plaintext');
    assert(rawCell() !== cellBeforeRotation, 'T-9: the stored envelope changes after rotation');
    cloudSync.reload();
    assertEqual(sync.settings?.api_key, ROTATED, 'T-9: rotated key decrypts to the new secret');
    // The request record must exist before its contents are inspected, so a
    // missing registration call fails loudly instead of comparing undefined.
    const registerEntry = captured.filter((entry) => entry.url.includes('/api/pos/register')).pop();
    assert(registerEntry !== undefined, 'T-9: the registration request was actually recorded');
    if (registerEntry) {
      assertEqual(registerEntry.method, 'POST', 'T-9: registration uses POST /api/pos/register');
      assert(typeof registerEntry.headers['x-flo-pos-hash'] === 'string', 'T-9: registration is signed by the device hash');
      assert(!('authorization' in registerEntry.headers), 'T-9: registration request carries no API key header');
    }

    // ── T-10: stop-all keeps identity; delete-data clears it ──────────────
    await cloudSync.stopAllCloudServices();
    assert(rawCell().startsWith('flosec1:'), 'T-10: stop-all keeps the envelope for a later resume');
    assertEqual(cloudSync.getStatus().cloud_services_disabled_by_user, true, 'T-10: stop-all disables cloud services');
    setSettings({ cloud_services_disabled_by_user: 'false' });
    nextResponseBody = { status: 'completed', request_id: 'req-1', status_token: 'tok-1' };
    await cloudSync.deleteCloudData();
    nextResponseBody = { ok: true };
    assertEqual(rawCell(), '', 'T-10: delete-data clears the cloud API key');

    // ── T-11/T-12: import must never install the file's key as the live key ─
    // Invariant: the settings import writes rows generically, then re-applies
    // the protected settings captured before the write (main/routes/database.ts
    // :145 capture → :363 insert → :403 merge → :436 response). A `cloud_api_key`
    // supplied by the import file must never become the live key.
    const IMPORTED_PLAINTEXT = 'imported-plaintext-must-not-win-3131';
    const LIVE_SECRET = 'live-install-secret-7777';
    const importPayload = (settingsRows: Array<Record<string, string>>) => ({
      overwrite: false,
      data: {
        version: 1,
        app: 'FloDesktop',
        schema_version: String(getCurrentSchemaVersion()),
        data: { settings: settingsRows, categories: [], products: [], users: [] },
      },
    });
    const importRow = (key: string, value: string) => ({ key, value, updated_at: new Date().toISOString() });
    const settingValue = (key: string): string | undefined => {
      const row = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value;
    };

    // Scenario A — no live key: the imported value must not become the live key.
    const probeKeyA = 'p1_import_probe_a';
    const importDb = getDatabase();
    importDb.prepare('DELETE FROM settings WHERE key = ?').run(CLOUD_KEY);
    importDb.prepare('DELETE FROM settings WHERE key = ?').run(probeKeyA);
    assert(settingValue(CLOUD_KEY) === undefined, 'T-11: no cloud_api_key row exists before the import');
    const importLogs: string[] = [];
    const importLog = console.log;
    const importErr = console.error;
    let importA: { status: number; body?: { success?: unknown } };
    try {
      console.log = (...args: unknown[]) => { importLogs.push(args.map(String).join(' ')); };
      console.error = (...args: unknown[]) => { importLogs.push(args.map(String).join(' ')); };
      importA = await request(app)
        .post('/api/database/import')
        .set(owner.authHeader)
        .send(importPayload([
          importRow(CLOUD_KEY, IMPORTED_PLAINTEXT),
          importRow(probeKeyA, 'probe-present'),
        ]));
    } finally {
      console.log = importLog;
      console.error = importErr;
    }
    assertEqual(importA.status, 200, 'T-11: the real import endpoint accepted the payload');
    assertEqual(importA.body?.success, true, 'T-11: import reported success');
    assertEqual(settingValue(probeKeyA), 'probe-present', 'T-11: the control row persisted, proving the import wrote settings');
    assert(!importLogs.some((line) => line.includes(IMPORTED_PLAINTEXT)), 'T-11: the import never logs the supplied key value');
    assert(settingValue(CLOUD_KEY) === undefined, 'T-11: the imported plaintext key is not kept as the live key');
    assert(!allSettingValues().some((value) => value.includes(IMPORTED_PLAINTEXT)), 'T-11: the imported value appears nowhere in settings');
    assertEqual(cloudSync.getStatus().cloud_api_key_state, 'empty', 'T-11: cloud key state stays empty after the import');

    // Scenario B — a live envelope exists: the live value must survive exactly.
    setSettings({ [CLOUD_KEY]: LIVE_SECRET });
    cloudSync.reload();
    const liveCell = rawCell();
    assert(isEncryptedSettingValue(liveCell), 'T-12: the live key is stored as an envelope before the import');
    const importB = await request(app)
      .post('/api/database/import')
      .set(owner.authHeader)
      .send(importPayload([importRow(CLOUD_KEY, IMPORTED_PLAINTEXT)]));
    assert(importB.status !== 401 && importB.status !== 403, 'T-12: the request was authorized and reached the import handler');
    assert(importB.body?.success !== true, 'T-12: the import does not report success while a live key row exists');
    assert(rawCell() === liveCell, 'T-12: the live envelope is preserved byte-for-byte');
    assert(decryptSecret(rawCell()) === LIVE_SECRET, 'T-12: the live key still decrypts to the live secret');
    assert(!rawCell().includes(LIVE_SECRET), 'T-12: the live secret is never stored in plaintext');
    assert(!allSettingValues().some((value) => value.includes(IMPORTED_PLAINTEXT)), 'T-12: the imported value never replaces the live key');
    cloudSync.reload();
    assert(sync.settings?.api_key === LIVE_SECRET, 'T-12: cloud sync still uses the live key after the import');

    const results = getResults();
    if (results.failed > 0) throw new Error(`${results.failed} SEC-02 assertions failed`);
    console.log('✅ SEC-02 cloud API key envelope tests passed');
  } finally {
    cloudSync.stop();
    try { closeDatabase(); } catch { }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    Module._load = originalLoad;
    if (ORIGINAL_JWT_SECRET_ENV === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET_ENV;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  try { closeDatabase(); } catch { }
  Module._load = originalLoad;
  if (ORIGINAL_JWT_SECRET_ENV === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET_ENV;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
