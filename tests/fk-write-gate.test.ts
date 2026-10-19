/**
 * P-3.8D.1 — focused tests for the FK degraded-state write gate.
 *
 * Covers the gate contract: FK-sensitive normal writes are blocked with HTTP
 * 503 while `dbHealthState.foreignKeys !== 'ok'`; read-only and health paths
 * stay accessible; designated recovery paths (maintenance routes) keep
 * working; queued requests re-verify FK state at execution time; maintenance
 * that ends with FK degraded keeps the gate closed.
 *
 * Isolation: same mkdtemp + mock-electron harness as the P-3.8B/P-3.8C.1
 * tests. HTTP tests drive the REAL server (startServer on PORT=0) so the
 * real middleware gate is exercised — no response mocking.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-p38d1-gate-'));

const ORIGINAL_JWT_SECRET_ENV = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'test-secret-p38d1';

if (process.env.FLO_E2E_DB_PATH) {
  throw new Error('Refusing to run with FLO_E2E_DB_PATH set: the test database would escape the temp directory');
}

const RealDatabase = require('better-sqlite3');

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'dpapi',
        encryptString: (value: string) => Buffer.from(`enc(${value})`, 'utf8'),
        decryptString: (buffer: Buffer) => buffer.toString('utf8').slice(4, -1),
      },
    };
  }
  return originalLoad.apply(this, arguments as never);
};

const {
  initTestDb,
  seedOwnerUser,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  getDatabase,
  now,
} = require('./helpers/test-setup');
const dbModule = require('../main/db');
const { getCurrentSchemaVersion, getDbPath } = dbModule;

const isFkWrite = (source: any): boolean =>
  typeof source === 'string' && /foreign_keys/i.test(source)
  && source.trim().replace(/\s+/g, '') === 'foreign_keys=ON';
const isFkPragma = (source: any): boolean =>
  typeof source === 'string' && /foreign_keys/i.test(source);

/** Installs a pragma interceptor on the live handle; returns a restore function. */
function interceptPragma(
  handler: (source: any, options: any, original: (source: any, options: any) => any) => any,
): () => void {
  const db = getDatabase() as any;
  const originalPragma = db.pragma.bind(db);
  db.pragma = (source: any, options?: any) => handler(source, options, originalPragma);
  return () => { db.pragma = originalPragma; };
}

/** Degrades FK to 'error' through the real recovery helper (read-back fails). */
function degradeFkToError(): () => void {
  const restore = interceptPragma((source, options, original) => {
    if (isFkPragma(source)) return isFkWrite(source) ? undefined : 0;
    return original(source, options);
  });
  dbModule.recoverForeignKeyEnforcement();
  return restore;
}

/** Degrades FK to 'unknown' through the real recovery helper (it throws). */
function degradeFkToUnknown(): () => void {
  const restore = interceptPragma((source, options, original) => {
    if (isFkPragma(source)) throw new Error('simulated failure');
    return original(source, options);
  });
  dbModule.recoverForeignKeyEnforcement();
  return restore;
}

/** Restores the real pragma and re-verifies FK through the real helper. */
function recoverFk(restore: () => void): void {
  restore();
  dbModule.recoverForeignKeyEnforcement();
}

function diskRowCount(sql: string, ...params: unknown[]): number {
  const fileCheck = new RealDatabase(getDbPath(), { readonly: true });
  try {
    return (fileCheck.prepare(sql).get(...params) as { c: number }).c;
  } finally {
    fileCheck.close();
  }
}

/** Restores process.env.PORT to its pre-suite value (shared by the suite
 *  finally, the error path, and the cleanup-contract regression test). */
function restorePortEnv(saved: string | undefined): void {
  if (saved === undefined) delete process.env.PORT;
  else process.env.PORT = saved;
}

// Module-scope so both the suite finally and the error path can restore it.
let originalPort: string | undefined;
let portOverridden = false;

async function run() {
  let baseUrl = '';
  try {
    initTestDb();
    const owner = seedOwnerUser(getDatabase());
    assert(getDbPath().startsWith(testDir), 'setup: the test database lives inside the temp directory');

    const { startServer, stopServer, getServerPort } = require('../main/server');
    originalPort = process.env.PORT;
    portOverridden = true;
    process.env.PORT = '0'; // ephemeral port — never the shared 3001
    await startServer();
    baseUrl = `http://127.0.0.1:${getServerPort()}`;

    const postJson = async (urlPath: string, body: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...owner.authHeader },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };

    // ── T-D1: FK=error blocks an FK-sensitive write with 503, no DB change ──
    {
      const restore = degradeFkToError();
      try {
        assertEqual(dbModule.getDbHealth().foreignKeys, 'error', 'T-D1: setup — FK degraded to error');
        const res = await postJson('/api/customers', { name: 'Gate Test Customer' });
        assertEqual(res.status, 503, 'T-D1: FK-sensitive write is blocked with HTTP 503');
        assertEqual(res.body.foreignKeys, 'error', 'T-D1: the 503 body exposes foreignKeys error');
        assert(typeof res.body.error === 'string' && res.body.error.length > 0, 'T-D1: the 503 body carries an error message');
        assertEqual(diskRowCount('SELECT COUNT(*) c FROM customers'), 0, 'T-D1: no customer row was created');
      } finally {
        recoverFk(restore);
      }
      assertEqual(dbModule.getDbHealth().foreignKeys, 'ok', 'T-D1: cleanup — FK recovered to ok');
    }

    // ── T-D2: FK=unknown blocks the same write ──────────────────────────────
    {
      const restore = degradeFkToUnknown();
      try {
        assertEqual(dbModule.getDbHealth().foreignKeys, 'unknown', 'T-D2: setup — FK degraded to unknown');
        const res = await postJson('/api/customers', { name: 'Gate Test Customer 2' });
        assertEqual(res.status, 503, 'T-D2: FK-sensitive write is blocked with HTTP 503 (unknown)');
        assertEqual(res.body.foreignKeys, 'unknown', 'T-D2: the 503 body exposes foreignKeys unknown');
        assertEqual(diskRowCount('SELECT COUNT(*) c FROM customers'), 0, 'T-D2: no customer row was created');
      } finally {
        recoverFk(restore);
      }
    }

    // ── T-D3: health and read-only paths stay accessible in degraded state ──
    {
      const restore = degradeFkToError();
      try {
        const health = await fetch(`${baseUrl}/api/health`);
        assertEqual(health.status, 503, 'T-D3: /api/health reports degraded (existing contract)');
        const healthBody = (await health.json()) as any;
        assertEqual(healthBody.foreignKeys, 'error', 'T-D3: health body exposes the FK state');
        const list = await fetch(`${baseUrl}/api/customers`, { headers: owner.authHeader });
        assertEqual(list.status, 200, 'T-D3: read-only route is not gated');
      } finally {
        recoverFk(restore);
      }
    }

    // ── T-D4: designated recovery path still executes in degraded state ─────
    {
      const restore = degradeFkToError();
      try {
        const stamp = new Date().toISOString();
        const res = await postJson('/api/db/import', {
          overwrite: false,
          data: {
            version: 1,
            app: 'FloDesktop',
            schema_version: String(getCurrentSchemaVersion()),
            data: {
              settings: [{ key: 'gate_d4', value: 'committed-d4', updated_at: stamp }],
              categories: [{ id: 'gate-d4-cat', name: 'Gate D4 Category', sort_order: 1, is_active: 1, created_at: stamp, updated_at: stamp }],
              products: [{ id: 'gate-d4-prod', name: 'Gate D4 Product', price: 5, category_id: 'gate-d4-cat', stock_quantity: 0, created_at: stamp, updated_at: stamp }],
              users: [],
            },
          },
        });
        assertEqual(res.status, 200, 'T-D4: the import recovery path still runs while FK is degraded');
        assertEqual(res.body.success, true, 'T-D4: the import reports success');
        assertEqual(diskRowCount('SELECT COUNT(*) c FROM settings WHERE key = ?', 'gate_d4'), 1, 'T-D4: the import committed its settings row');
        // FK-sensitive parent/child data imported while degraded is persisted
        // with its relationship intact (the route validates FK integrity before COMMIT).
        assertEqual(diskRowCount('SELECT COUNT(*) c FROM categories WHERE id = ?', 'gate-d4-cat'), 1, 'T-D4: the FK-sensitive category row was imported');
        assertEqual(diskRowCount('SELECT COUNT(*) c FROM products WHERE id = ? AND category_id = ?', 'gate-d4-prod', 'gate-d4-cat'), 1, 'T-D4: the product row was imported with its FK intact');
        assertEqual(diskRowCount('SELECT COUNT(*) c FROM products WHERE category_id = ?', 'gate-d4-cat'), 1, 'T-D4: the FK relationship resolves to exactly one child');
        // No unrelated records were created.
        assertEqual(diskRowCount('SELECT COUNT(*) c FROM categories'), 1, 'T-D4: no unrelated category rows were created');
        assertEqual(diskRowCount('SELECT COUNT(*) c FROM customers'), 0, 'T-D4: no unrelated customer rows were created');
      } finally {
        recoverFk(restore);
      }
      // No public bypass API exists.
      const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'db.ts'), 'utf8');
      assert(!/skipGate|forceWrite/.test(source), 'T-D4: no public bypass parameter exists in the gate');
    }

    // ── T-D5: invalid child INSERT on a normal path never executes ──────────
    {
      const restore = degradeFkToError();
      try {
        const res = await postJson('/api/supplies/gate-missing-supply/movements', {
          movement_type: 'adjustment',
          quantity: 1,
        });
        assertEqual(res.status, 503, 'T-D5: the FK-sensitive write is blocked with 503');
        assertEqual(res.body.foreignKeys, 'error', 'T-D5: the block reports the FK state');
        assertEqual(diskRowCount('SELECT COUNT(*) c FROM supply_movements'), 0, 'T-D5: no supply_movements row was created');
      } finally {
        recoverFk(restore);
      }
    }

    // ── T-D6: invalid FK-column UPDATE on a normal path never executes ──────
    {
      // products.category_id is a real FK (REFERENCES categories(id)).
      getDatabase().prepare(
        'INSERT INTO products (id, name, price) VALUES (?, ?, ?)'
      ).run('gate-prod-d6', 'Gate Product D6', 1);
      const restore = degradeFkToError();
      try {
        const res = await fetch(`${baseUrl}/api/products/gate-prod-d6`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...owner.authHeader },
          body: JSON.stringify({ category_id: 'gate-missing-category' }),
        });
        const body = (await res.json()) as any;
        assertEqual(res.status, 503, 'T-D6: the FK-column update is blocked with 503');
        assertEqual(body.foreignKeys, 'error', 'T-D6: the block reports the FK state');
        const row = getDatabase().prepare('SELECT category_id FROM products WHERE id = ?').get('gate-prod-d6') as { category_id: string | null };
        assertEqual(row.category_id, null, 'T-D6: the product FK column is unchanged');
      } finally {
        recoverFk(restore);
      }
    }

    // ── T-D7: cascade/restrict behavior stays intact after recovery ─────────
    {
      getDatabase().prepare(
        'INSERT INTO categories (id, name, sort_order, is_active, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)'
      ).run('gate-cat-d7', 'Gate Category D7', now(), now());
      getDatabase().prepare(
        'INSERT INTO addon_groups (id, name, sort_order, is_active, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)'
      ).run('gate-ag-d7', 'Gate Addon Group D7', now(), now());
      getDatabase().prepare(
        'INSERT INTO category_addon_groups (category_id, addon_group_id) VALUES (?, ?)'
      ).run('gate-cat-d7', 'gate-ag-d7');
      const restore = degradeFkToError();
      recoverFk(restore);
      assertEqual(dbModule.getDbHealth().foreignKeys, 'ok', 'T-D7: setup — FK recovered to ok');

      // Enforcement is active again: an orphan child INSERT is rejected.
      let orphanRejected = false;
      try {
        getDatabase().prepare(
          'INSERT INTO category_addon_groups (category_id, addon_group_id) VALUES (?, ?)'
        ).run('gate-missing-category', 'gate-ag-d7');
      } catch {
        orphanRejected = true;
      }
      assertEqual(orphanRejected, true, 'T-D7: FK enforcement rejects an orphan child after recovery');

      // ON DELETE CASCADE is active again: a hard parent delete removes the child.
      getDatabase().prepare('DELETE FROM categories WHERE id = ?').run('gate-cat-d7');
      assertEqual(diskRowCount('SELECT COUNT(*) c FROM category_addon_groups WHERE category_id = ?', 'gate-cat-d7'), 0, 'T-D7: the ON DELETE CASCADE child row was removed — enforcement is active');
    }

    // ── T-D10: wrapped-operation contract in degraded state ─────────────────
    {
      const restore = degradeFkToError();
      try {
        const safe = await dbModule.withDatabaseRequest(() => 'settings-write-ok');
        assertEqual(safe, 'settings-write-ok', 'T-D10: FK-safe wrapped operation is not gated');
        let rejected = false;
        try {
          await dbModule.withDatabaseRequest(() => 'should-not-run', undefined, { fkSensitive: true });
        } catch {
          rejected = true;
        }
        assertEqual(rejected, true, 'T-D10: FK-sensitive wrapped operation is blocked in degraded state');
      } finally {
        recoverFk(restore);
      }
    }

    // ── T-D11: newly classified read-only / FK-safe routes (B1, P-3.8D.1.2) ──
    // Each route below was verified against its real implementation: login,
    // logout, refresh, tenants/select are read-only (SELECT users + JWT /
    // in-memory revocation); tax/preview is a pure computation; rotate-code
    // writes only the FK-free settings table.
    {
      const restore = degradeFkToError();
      try {
        // `logout` revokes the caller's own token (INSERT INTO revoked_tokens,
        // a FK-free table), so it is exercised WITHOUT the suite's owner token —
        // otherwise every later authenticated request in this suite would 401.
        const cases: Array<[string, string, unknown, boolean]> = [
          ['/api/auth/login', 'auth/login (read-only)', { email: 'nobody@example.com', password: 'x' }, false],
          ['/api/auth/logout', 'auth/logout (FK-free revoked_tokens only)', {}, false],
          ['/api/auth/refresh', 'auth/refresh (read-only)', {}, true],
          ['/api/auth/tenants/select', 'auth/tenants/select (read-only)', {}, true],
          ['/api/tax/preview', 'tax/preview (pure computation)', { items: [] }, true],
          ['/api/mobile/rotate-code', 'mobile/rotate-code (settings only)', {}, true],
        ];
        for (const [path, label, body, withAuth] of cases) {
          const res = await fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(withAuth ? owner.authHeader : {}) },
            body: JSON.stringify(body),
          });
          const parsed = (await res.json().catch(() => null)) as any;
          assert(
            res.status !== 503 || parsed?.foreignKeys === undefined,
            `T-D11: ${label} is not FK-gated in degraded state (got ${res.status})`,
          );
        }
        // The FK-sensitive families keep their protection.
        const blocked = await postJson('/api/customers', { name: 'Still Blocked D11' });
        assertEqual(blocked.status, 503, 'T-D11: FK-sensitive writes remain blocked after the classification change');
      } finally {
        recoverFk(restore);
      }
      // Healthy-state regression: login works normally when FK is ok.
      const okLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@test.local', password: 'testpass123' }),
      });
      assertEqual(okLogin.status, 200, 'T-D11: login still works normally in the healthy state');
    }

    // ── T-X1: a normal request during maintenance cannot bypass the gate ────
    {
      let releaseLock: () => void = () => {};
      const lockPromise = dbModule.withDatabaseMaintenanceLock(
        () => new Promise<void>((resolve) => { releaseLock = resolve; }),
      );
      await new Promise((r) => setImmediate(r));
      assertEqual(dbModule.isDatabaseMaintenanceActive(), true, 'T-X1: setup — maintenance lock is active');
      const res = await postJson('/api/customers', { name: 'Should Not Run' });
      assertEqual(res.status, 503, 'T-X1: a normal write during maintenance is rejected with 503');
      assertEqual(res.body.error, 'Database maintenance in progress', 'T-X1: the rejection is the maintenance guard');
      releaseLock();
      await lockPromise;
      assertEqual(dbModule.isDatabaseMaintenanceActive(), false, 'T-X1: the lock is released');
    }

    // ── T-X7: pre-authentication gate ordering (B3 decision, P-3.8D.1.2) ────
    // Decision: the gate stays inside databaseMaintenanceMiddleware (before
    // requireAuth). Moving it after authentication would require a second
    // middleware mounted in three servers with an unproven regression surface.
    // This test pins the accepted behaviour: an unauthenticated FK-sensitive
    // write is rejected with the FK 503 before auth (no mutation), while the
    // verified read-only auth routes are no longer FK-gated.
    {
      const restore = degradeFkToError();
      try {
        const noAuth = await fetch(`${baseUrl}/api/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'No Auth Should Not Run' }),
        });
        const noAuthBody = (await noAuth.json()) as any;
        assertEqual(noAuth.status, 503, 'T-X7: unauthenticated FK-sensitive write → 503 (gate precedes auth — documented policy)');
        assertEqual(noAuthBody.foreignKeys, 'error', 'T-X7: the rejection identifies the FK degradation');
        assertEqual(diskRowCount('SELECT COUNT(*) c FROM customers'), 0, 'T-X7: no row was created by the unauthenticated request');

        const login = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'nobody@example.com', password: 'x' }),
        });
        assertEqual(login.status, 401, 'T-X7: login is not FK-gated — it reaches credential validation (401)');
      } finally {
        recoverFk(restore);
      }
    }

    // ── T-X2: whatsapp message writes are gated; blocklist is not ───────────
    {
      const restore = degradeFkToError();
      try {
        // whatsapp/send touches whatsapp_messages (FK to bills/customers) and
        // must stay blocked with no persisted row.
        const send = await postJson('/api/whatsapp/send', { to: '+919999999999', message: 'gate test' });
        assertEqual(send.status, 503, 'T-X2: whatsapp_messages write is blocked (FK-sensitive table)');
        assertEqual(send.body.foreignKeys, 'error', 'T-X2: the send block reports the FK state');
        assertEqual(diskRowCount('SELECT COUNT(*) c FROM whatsapp_messages'), 0, 'T-X2: no whatsapp_messages row was created');

        // whatsapp/blocklist writes only the FK-free blocklist table: it must
        // succeed with its normal contract and actually persist.
        const blocklist = await postJson('/api/whatsapp/blocklist', { phone_e164: '+919999999999', reason: 'gate test' });
        assertEqual(blocklist.status, 200, 'T-X2: blocklist succeeds in degraded state');
        assertEqual(blocklist.body?.ok, true, 'T-X2: blocklist returns its success contract');
        assertEqual(blocklist.body?.foreignKeys, undefined, 'T-X2: blocklist is not FK-gated');
        assertEqual(diskRowCount('SELECT COUNT(*) c FROM whatsapp_blocklist WHERE phone_e164 = ?', '+919999999999'), 1, 'T-X2: the blocklist row was persisted');
      } finally {
        recoverFk(restore);
      }
    }

    // ── T-X3: a queued request re-verifies FK state at execution time ───────
    {
      let releaseLock: () => void = () => {};
      const lockPromise = dbModule.withDatabaseMaintenanceLock(
        () => new Promise<void>((resolve) => { releaseLock = resolve; }),
      );
      await new Promise((r) => setImmediate(r));
      assertEqual(dbModule.isDatabaseMaintenanceActive(), true, 'T-X3: setup — maintenance lock is active');

      let queuedOpRan = false;
      const queued = dbModule.withDatabaseRequest(
        () => { queuedOpRan = true; return 'queued-done'; },
        undefined,
        { fkSensitive: true },
      );
      await new Promise((r) => setImmediate(r));

      const restore = degradeFkToError();
      assertEqual(dbModule.getDbHealth().foreignKeys, 'error', 'T-X3: setup — FK degraded while the request sits in the queue');

      releaseLock();
      await lockPromise;

      let rejected = false;
      let rejection: any;
      try { await queued; } catch (error) { rejected = true; rejection = error; }
      assertEqual(rejected, true, 'T-X3: the queued FK-sensitive request is blocked at execution time');
      assert(rejection instanceof dbModule.DatabaseFkDegradedError, 'T-X3: the rejection is DatabaseFkDegradedError');
      assertEqual(rejection.foreignKeys, 'error', 'T-X3: the rejection carries the FK state');
      assertEqual(queuedOpRan, false, 'T-X3: the queued operation never ran');
      recoverFk(restore);
      const after = await dbModule.withDatabaseRequest(() => 'after-ok');
      assertEqual(after, 'after-ok', 'T-X3: request lifecycle has no leak after the blocked request');
    }

    // ── T-X5: exception inside maintenance keeps state recorded + lock free ─
    {
      const restore = degradeFkToError();
      try {
        let threw = false;
        try {
          await dbModule.withDatabaseMaintenanceLock(() => { throw new Error('injected maintenance failure'); });
        } catch {
          threw = true;
        }
        assertEqual(threw, true, 'T-X5: the maintenance failure propagates');
        assertEqual(dbModule.isDatabaseMaintenanceActive(), false, 'T-X5: the lock is released after the failure');
        assertEqual(dbModule.getDbHealth().foreignKeys, 'error', 'T-X5: FK state stays recorded after the failure');
      } finally {
        recoverFk(restore);
      }
    }

    // ── T-X6: maintenance ending with FK degraded keeps the gate closed ─────
    {
      const restore = degradeFkToError();
      try {
        await dbModule.withDatabaseMaintenanceLock(() => {});
        assertEqual(dbModule.isDatabaseMaintenanceActive(), false, 'T-X6: maintenance ended');
        const res = await postJson('/api/customers', { name: 'Still Blocked' });
        assertEqual(res.status, 503, 'T-X6: a normal write stays blocked after maintenance with FK degraded');
        assertEqual(res.body.foreignKeys, 'error', 'T-X6: the block reports the FK state');
      } finally {
        recoverFk(restore);
      }
    }

    // ── T-D9: normal writes work again after successful recovery ────────────
    {
      assertEqual(dbModule.getDbHealth().foreignKeys, 'ok', 'T-D9: setup — FK is healthy');
      const res = await postJson('/api/customers', { name: 'Gate Recovery Customer' });
      assertEqual(res.status, 201, 'T-D9: a normal write succeeds after recovery');
      assertEqual(diskRowCount('SELECT COUNT(*) c FROM customers'), 1, 'T-D9: the row was really created');
    }

    // ── T-D12: port-restore cleanup contract (B2, P-3.8D.1.2) ───────────────
    {
      const saved = process.env.PORT;
      process.env.PORT = '0';
      restorePortEnv(saved);
      assertEqual(process.env.PORT, saved, 'T-D12: restorePortEnv restores the exact original PORT value');
      process.env.PORT = '0';
      restorePortEnv(undefined);
      assertEqual(process.env.PORT, undefined, 'T-D12: restorePortEnv deletes PORT when it was originally unset');
      process.env.PORT = '0';
      restorePortEnv('45678');
      assertEqual(process.env.PORT, '45678', 'T-D12: restorePortEnv restores a concrete original value');
      restorePortEnv(saved); // leave the environment exactly as it was found
    }

    // ── T-D8: no state leakage between tests ────────────────────────────────
    {
      const health = dbModule.getDbHealth();
      assertEqual(health.ok, true, 'T-D8: final health state is clean');
      assertEqual(health.foreignKeys, 'ok', 'T-D8: final FK state is ok');
      assertEqual(dbModule.isDatabaseMaintenanceActive(), false, 'T-D8: no maintenance lock is left active');
    }

    const results = getResults();
    if (results.failed > 0) throw new Error(`${results.failed} P-3.8D.1 gate assertions failed`);
    console.log(`✅ P-3.8D.1 FK write-gate tests passed (${results.passed}/${results.total} assertions)`);
  } finally {
    if (baseUrl) {
      try { const { stopServer } = require('../main/server'); await stopServer(); } catch { }
    }
    if (portOverridden) restorePortEnv(originalPort);
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    if (ORIGINAL_JWT_SECRET_ENV === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET_ENV;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { }
  }
}

run()
  .then(() => {
    console.log(`[cleanup] process.env.PORT after suite: ${process.env.PORT === undefined ? '(unset)' : process.env.PORT}`);
  })
  .catch((error) => {
    // Safety net for a failure inside run()'s own finally: still restore the
    // environment, release resources, and never leave PORT overridden.
    try { const { stopServer } = require('../main/server'); stopServer(); } catch { }
    if (portOverridden) restorePortEnv(originalPort);
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    if (ORIGINAL_JWT_SECRET_ENV === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET_ENV;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { }
    console.error(error);
    process.exit(1);
  });
