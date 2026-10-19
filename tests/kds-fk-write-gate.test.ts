/**
 * P-3.8D.2 — KDS WebSocket FK-degraded write gate.
 *
 * The maintenance lock alone did not cover a degraded FK state that outlives
 * maintenance: `status_update` could still mutate `order_items` while
 * `dbHealthState.foreignKeys !== 'ok'`. This suite drives the REAL KDS server
 * over a REAL WebSocket so the dispatch path, the session checks and the gate
 * are exercised end to end.
 *
 * Isolation: mkdtemp + mock-electron harness (same as the P-3.8B/P-3.8D.1
 * suites). The FK state is degraded through a pragma interceptor plus the real
 * `recoverForeignKeyEnforcement()` read-back, so SQLite enforcement itself is
 * never actually disabled — only the recorded health state is.
 */
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-p38d2-kds-gate-'));

const ORIGINAL_JWT_SECRET_ENV = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'test-secret-p38d2-kds';

if (process.env.FLO_E2E_DB_PATH) {
  throw new Error('Refusing to run with FLO_E2E_DB_PATH set: the test database would escape the temp directory');
}

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as never);
};

import { startKdsServer, stopKdsServer, getKdsPort } from '../main/kds-server';
import {
  initDatabase,
  closeDatabase,
  getDatabase,
  getDbPath,
  getDbHealth,
  isDatabaseMaintenanceActive,
  now,
  recoverForeignKeyEnforcement,
} from '../main/db';
import { clearRevokedTokens, revokeToken } from '../main/middleware/security';
import { getJWTSecret } from '../main/routes/auth';
import request from 'supertest';
import { WebSocket } from 'ws';
import * as jwt from 'jsonwebtoken';
const { assert, assertEqual, getResults } = require('./helpers/test-setup');

/** Buffers server messages and resolves waiters by message type. */
function createMessageQueue(ws: WebSocket) {
  const messages: any[] = [];
  const waiters: Array<{ type: string; resolve: (message: any) => void }> = [];
  ws.on('message', (raw: { toString(): string }) => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.type === message.type);
    if (waiterIndex >= 0) return waiters.splice(waiterIndex, 1)[0].resolve(message);
    messages.push(message);
  });
  return (type: string, timeoutMs = 8000): Promise<any> => {
    const messageIndex = messages.findIndex((message) => message.type === type);
    if (messageIndex >= 0) return Promise.resolve(messages.splice(messageIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve: (_message: any) => {} };
      const timeout = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for "${type}" (queued: ${messages.map((m) => m.type).join(',') || 'none'})`));
      }, timeoutMs);
      waiter.resolve = (message: any) => { clearTimeout(timeout); resolve(message); };
      waiters.push(waiter);
    });
  };
}

const isFkWrite = (source: any): boolean =>
  typeof source === 'string' && /foreign_keys/i.test(source)
  && source.trim().replace(/\s+/g, '') === 'foreign_keys=ON';
const isFkPragma = (source: any): boolean =>
  typeof source === 'string' && /foreign_keys/i.test(source);

/**
 * Degrades the recorded FK health to 'error' through the real recovery helper:
 * the pragma interceptor makes the read-back return 0 while SQLite itself keeps
 * enforcing. Returns a restore function that re-verifies a healthy state.
 */
function degradeFkToError(): () => void {
  const db = getDatabase() as any;
  const originalPragma = db.pragma.bind(db);
  db.pragma = (source: any, options?: any) => {
    if (isFkPragma(source)) return isFkWrite(source) ? undefined : 0;
    return originalPragma(source, options);
  };
  recoverForeignKeyEnforcement();
  return () => {
    db.pragma = originalPragma;
    recoverForeignKeyEnforcement();
  };
}

async function run() {
  console.log('P-3.8D.2 — KDS WebSocket FK-degraded write gate');
  console.log('='.repeat(60));

  clearRevokedTokens();
  initDatabase();
  await startKdsServer();

  const sockets: WebSocket[] = [];
  let restoreFk: (() => void) | null = null;

  try {
    const port = getKdsPort();
    const db = getDatabase();
    const bcrypt = require('bcryptjs');

    // ── isolation guards ────────────────────────────────────────────────────
    assert(getDbPath().startsWith(testDir), 'isolation: the test database lives inside the temp directory');
    assertEqual(isDatabaseMaintenanceActive(), false, 'setup: no maintenance lock is active');
    assertEqual(getDbHealth().foreignKeys, 'ok', 'setup: FK enforcement is verified OK');

    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active)
      VALUES ('kds-gate-chef', 'Gate Chef', 'gatechef@flo.local', ?, 'chef', 1)
    `).run(bcrypt.hashSync('Pass123!', 10));
    db.prepare('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)')
      .run('kds-gate-cat', 'Gate Kitchen', 1);
    db.prepare('INSERT INTO products (id, category_id, name, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, 1)')
      .run('kds-gate-prod', 'kds-gate-cat', 'Gate Burger', 15);
    db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
      VALUES (?, 'takeaway', 'pending', 45, 45, ?, ?)`).run('KDS-GATE-001', now(), now());
    const orderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get('KDS-GATE-001') as any).id;

    const itemIds: Record<string, number> = {};
    for (const key of ['A', 'B', 'C']) {
      db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
        VALUES (?, 'kds-gate-prod', ?, 15, 1, 15, 0, 15, 'pending', ?, ?)`)
        .run(orderId, `Gate Burger ${key}`, now(), now());
      itemIds[key] = (db.prepare('SELECT id FROM order_items WHERE order_id = ? AND product_name = ?')
        .get(orderId, `Gate Burger ${key}`) as any).id;
    }

    const itemStatus = (id: number): string =>
      (db.prepare('SELECT status FROM order_items WHERE id = ?').get(id) as any)?.status;
    /** Full business-data snapshot used to prove a rejection wrote nothing. */
    const snapshot = (): string => JSON.stringify({
      items: db.prepare('SELECT * FROM order_items ORDER BY id').all(),
      orders: db.prepare('SELECT * FROM orders ORDER BY id').all(),
    });

    const sign = (jti: string) =>
      jwt.sign({ userId: 'kds-gate-chef', role: 'chef', jti }, getJWTSecret(), { expiresIn: '1h' });

    const openClient = async (token: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/kds`);
      sockets.push(ws);
      const queue = createMessageQueue(ws);
      await once(ws, 'open');
      ws.send(JSON.stringify({ type: 'auth', token }));
      await queue('auth_success');
      await queue('initial_data');
      return { ws, queue };
    };

    const mainToken = sign('kds-gate-main');
    const { ws, queue } = await openClient(mainToken);

    // ── KDS-D1: normal behaviour with healthy FK ─────────────────────────────
    ws.send(JSON.stringify({ type: 'status_update', order_item_id: itemIds.A, status: 'preparing' }));
    const d1 = await queue('status_updated');
    assertEqual(d1.type, 'status_updated', 'KDS-D1: a valid status_update is acknowledged');
    assertEqual(d1.status, 'preparing', 'KDS-D1: the acknowledgement reports the new status');
    assertEqual(itemStatus(itemIds.A), 'preparing', 'KDS-D1: the status change is persisted');

    // ── KDS-D2 / KDS-D3: degraded after maintenance, nothing written ─────────
    restoreFk = degradeFkToError();
    assertEqual(getDbHealth().foreignKeys, 'error', 'KDS-D2: FK enforcement is recorded as degraded');
    assertEqual(isDatabaseMaintenanceActive(), false, 'KDS-D2: the maintenance lock is NOT active (the original gap)');

    const before = snapshot();
    ws.send(JSON.stringify({ type: 'status_update', order_item_id: itemIds.B, status: 'preparing' }));
    const d2 = await queue('error');
    assertEqual(d2.type, 'error', 'KDS-D2: the write is rejected with an error message');
    assertEqual(d2.code, 'ERR_FK_DEGRADED', 'KDS-D2: the rejection carries the stable FK-degraded code');
    assertEqual(ws.readyState, WebSocket.OPEN, 'KDS-D2: the session stays open for read-only use');

    assertEqual(snapshot(), before, 'KDS-D3: no business row changed while the write was rejected');
    assertEqual(itemStatus(itemIds.B), 'pending', 'KDS-D3: the target item keeps its previous status');

    // ── KDS-D7: no internal detail leaks, service stays alive ────────────────
    assert(!/select\s+\S|update\s+\w+\s+set|insert\s+into|delete\s+from|order_items|\.ts\b|[A-Za-z]:\\|\/main\//i
      .test(d2.message || ''),
      'KDS-D7: the rejection message exposes no SQL statement, table or file path');
    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await queue('pong');
    assertEqual(pong.type, 'pong', 'KDS-D7: the service keeps serving after a rejection');

    // ── KDS-D6: payload validation still runs before the gate ────────────────
    ws.send(JSON.stringify({ type: 'status_update', order_item_id: itemIds.B, status: 'bogus' }));
    const d6 = await queue('error');
    assert(d6.code !== 'ERR_FK_DEGRADED', 'KDS-D6: invalid payloads are rejected by validation, not by the gate');
    assert(/Invalid status/i.test(d6.message || ''), 'KDS-D6: the validation message is preserved');
    assertEqual(itemStatus(itemIds.B), 'pending', 'KDS-D6: the invalid update wrote nothing');

    // ── KDS-D5: session checks keep precedence over the gate ─────────────────
    const revokedToken = sign('kds-gate-revoked');
    const { ws: revokedWs, queue: revokedQueue } = await openClient(revokedToken);
    revokeToken(revokedToken);
    revokedWs.send(JSON.stringify({ type: 'status_update', order_item_id: itemIds.C, status: 'preparing' }));
    const d5 = await revokedQueue('auth_error');
    assert(/revoked|expired/i.test(d5.message || ''), 'KDS-D5: a revoked session is reported as such, not masked by the gate');
    await once(revokedWs, 'close');
    assertEqual(itemStatus(itemIds.C), 'pending', 'KDS-D5: the revoked session wrote nothing');
    clearRevokedTokens();

    const unauthWs = new WebSocket(`ws://127.0.0.1:${port}/kds`);
    sockets.push(unauthWs);
    const unauthQueue = createMessageQueue(unauthWs);
    await once(unauthWs, 'open');
    unauthWs.send(JSON.stringify({ type: 'status_update', order_item_id: itemIds.C, status: 'preparing' }));
    const d5b = await unauthQueue('auth_error');
    assert(/authentication required/i.test(d5b.message || ''), 'KDS-D5: an unauthenticated write is refused as unauthenticated');
    await once(unauthWs, 'close');
    assertEqual(itemStatus(itemIds.C), 'pending', 'KDS-D5: the unauthenticated write wrote nothing');

    // ── KDS-D8: read-only paths and ping are unaffected while degraded ───────
    const { ws: readerWs, queue: readerQueue } = await openClient(sign('kds-gate-reader'));
    assertEqual(readerWs.readyState, WebSocket.OPEN, 'KDS-D8: a client can still authenticate while FK is degraded');
    readerWs.send(JSON.stringify({ type: 'ping' }));
    const readerPong = await readerQueue('pong');
    assertEqual(readerPong.type, 'pong', 'KDS-D8: ping/pong keeps working while FK is degraded');
    assertEqual(itemStatus(itemIds.C), 'pending', 'KDS-D8: read-only traffic changed nothing');

    // ── KDS-D9: the KDS HTTP surface is gated by the same policy ─────────────
    {
      const httpBase = `http://127.0.0.1:${port}`;
      const beforeHttp = snapshot();
      const patchRes = await request(httpBase)
        .patch(`/api/kds/items/${itemIds.C}/status`)
        .set('Authorization', `Bearer ${mainToken}`)
        .send({ status: 'preparing' });
      assertEqual(patchRes.status, 503, 'KDS-D9: the KDS HTTP status write is blocked while FK is degraded');
      assertEqual(patchRes.body?.foreignKeys, 'error', 'KDS-D9: the HTTP block reports the FK state');
      assertEqual(snapshot(), beforeHttp, 'KDS-D9: the blocked HTTP write changed no business row');

      const readRes = await request(httpBase)
        .get('/api/kds/orders')
        .set('Authorization', `Bearer ${mainToken}`);
      assertEqual(readRes.status, 200, 'KDS-D9: KDS HTTP reads stay available while FK is degraded');
    }

    // ── KDS-D4: a verified recovery reopens normal writes ────────────────────
    restoreFk();
    restoreFk = null;
    assertEqual(getDbHealth().foreignKeys, 'ok', 'KDS-D4: FK enforcement is verified OK again');
    ws.send(JSON.stringify({ type: 'status_update', order_item_id: itemIds.B, status: 'preparing' }));
    const d4 = await queue('status_updated');
    assertEqual(d4.type, 'status_updated', 'KDS-D4: a valid write succeeds again after recovery');
    assertEqual(itemStatus(itemIds.B), 'preparing', 'KDS-D4: the status change is persisted after recovery');

    // ── KDS-D6b: expected_status conflicts still lose the race check ─────────
    ws.send(JSON.stringify({
      type: 'status_update', order_item_id: itemIds.C, status: 'preparing', expected_status: 'served',
    }));
    const d6b = await queue('error');
    assert(/status changed/i.test(d6b.message || ''), 'KDS-D6: an expected_status mismatch is still rejected');
    assertEqual(itemStatus(itemIds.C), 'pending', 'KDS-D6: the conflicting update wrote nothing');

    const results = getResults();
    if (results.failed > 0) throw new Error(`${results.failed} assertion(s) failed`);
    console.log(`\n✅ P-3.8D.2 KDS FK write-gate tests passed (${results.passed}/${results.total} assertions)`);
  } finally {
    if (restoreFk) {
      try { restoreFk(); } catch { }
    }
    for (const socket of sockets) {
      try { socket.terminate(); } catch { }
    }
    try { await stopKdsServer(); } catch { }
    try { closeDatabase(); } catch { }
    clearRevokedTokens();
    Module._load = originalLoad;
    if (ORIGINAL_JWT_SECRET_ENV === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET_ENV;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
