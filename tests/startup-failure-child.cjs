const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-startup-failure-'));
const events = [];
const exitCodes = [];
const appListeners = new Map();
const startupRace = process.env.FLO_STARTUP_RACE === '1';
const startupFailureRace = process.env.FLO_STARTUP_FAILURE_RACE === '1';
// Blocked-migration mode: initDatabase throws the real structured diagnostic the
// migration engine raises, so the startup dialog is asserted on real content.
const convergenceBlock = process.env.FLO_STARTUP_CONVERGENCE_BLOCK === '1';
const dialogs = [];
const telemetryEvents = [];

function blockedMigrationError() {
  const { MigrationConvergenceError } = require('../main/migration-diagnostics');
  if (typeof MigrationConvergenceError !== 'function') {
    throw new Error('migration-diagnostics did not export MigrationConvergenceError');
  }
  return new MigrationConvergenceError([
    { objectType: 'column', object: 'role_permission_overrides.effect', problem: 'column missing' },
    { objectType: 'index', object: 'local_diagnostics.idx_local_diagnostics_created', problem: 'index missing' },
  ], 1001, 'catch_up_upstream_v93_to_v98');
}
const realProcessExit = process.exit.bind(process);
let releaseServerStart;
let rejectServerStart;

if (startupRace || startupFailureRace) {
  process.exit = (code = 0) => { exitCodes.push(code); };
}

function register(event, listener) {
  const listeners = appListeners.get(event) || [];
  listeners.push(listener);
  appListeners.set(event, listeners);
}

const app = {
  isPackaged: true,
  commandLine: { appendSwitch() {} },
  name: 'flo-test',
  setPath() {},
  getPath: () => testDir,
  getVersion: () => 'test',
  getName: () => 'Flo Test',
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  on: register,
  quit: () => { events.push('app.quit'); },
  relaunch: () => { events.push('app.relaunch'); },
  exit: (code = 0) => { exitCodes.push(code); },
  focus() {},
};

const log = {
  initialize() {},
  transports: {
    file: { level: 'info', getFile: () => ({ path: path.join(testDir, 'test.log') }) },
    console: { level: 'debug' },
  },
  debug() {},
  info() {},
  error() {},
  warn() {},
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app,
      BrowserWindow: class {},
      ipcMain: { handle() {} },
      dialog: { showErrorBox: (title, body) => { events.push('dialog.showErrorBox'); dialogs.push({ title, body }); } },
      Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
      Tray: class {},
      nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
      shell: { openExternal: () => Promise.resolve() },
    };
  }
  if (request === 'electron-log/main' || request === 'electron-log') return log;
  if (request === 'electron-updater') return { autoUpdater: { on() {} } };
  if (request === './db') {
    class SchemaVersionMismatchError extends Error {}
    return {
      initDatabase: () => {
        events.push('database.init');
        if (convergenceBlock) throw blockedMigrationError();
        if (!startupRace && !startupFailureRace) throw new Error('simulated startup failure');
      },
      beginDatabaseShutdown: () => { events.push('database.admission'); },
      closeDatabase: () => { events.push('database.close'); },
      waitForDatabaseRequests: () => Promise.resolve(),
      // main/index.ts calls this shared boundary validator at module load, so
      // the ./db stub must expose it with the same contract as main/db.ts:
      // null when no E2E override is configured, otherwise the resolved root
      // (rejected when it would land inside the checkout). The shutdown tests
      // never set the override, which keeps app.setPath on its ordinary path.
      resolveIsolatedUserDataRoot: () => {
        const raw = process.env.FLO_E2E_USER_DATA_DIR;
        if (!raw) return null;
        const isolated = path.resolve(raw);
        const repoRoot = path.resolve(__dirname, '..');
        const relative = path.relative(repoRoot, isolated);
        if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
          throw new Error('[DB] FLO_E2E_USER_DATA_DIR must not be the repository or a directory inside it');
        }
        return isolated;
      },
      SchemaVersionMismatchError,
    };
  }
  if (request === './server') return {
    startServer: () => {
      events.push('server.start');
      if (!startupRace && !startupFailureRace) return Promise.resolve();
      return new Promise((resolve, reject) => {
        releaseServerStart = resolve;
        rejectServerStart = reject;
      });
    },
    stopServer: async () => {
      events.push('server.stop');
      if (startupFailureRace) rejectServerStart?.(new Error('simulated startup failure after shutdown'));
      else releaseServerStart?.();
    },
    getLocalIP: () => '127.0.0.1',
    getServerPort: () => 0,
    isServerRunning: () => false,
  };
  if (request === './kds-server') return {
    startKdsServer: async () => { events.push('kds.start'); },
    stopKdsServer: async () => { events.push('kds.stop'); },
    getKdsPort: () => 0,
    isKdsServerRunning: () => false,
  };
  if (request === './server-app') return {
    startServerApp: async () => { events.push('server-app.start'); },
    stopServerApp: async () => { events.push('server-app.stop'); },
    getServerAppPort: () => 0,
    isServerAppRunning: () => false,
  };
  if (request === './services/cloud-sync') return { cloudSync: { shutdown: async () => { events.push('cloud.shutdown'); } } };
  if (request === './services/telemetry') return {
    telemetry: {
      start() { events.push('telemetry.start'); },
      stop: () => { events.push('telemetry.stop'); },
    },
    sendEvent: async (name, payload) => { events.push('telemetry.startup-failed'); telemetryEvents.push({ name, payload }); return true; },
  };
  if (request === './services/google-drive') return {
    googleDrive: {
      start() { events.push('drive.start'); },
      stop: () => { events.push('drive.stop'); },
    },
  };
  if (request === './printers/thermal') return { initPrinter: async () => {}, printReceipt() {}, printKOT() {} };
  if (request === './ipc') return { registerIpcHandlers() {} };
  if (request === './services/whatsapp') return {
    initFromDb() {},
    requestShutdown() {},
    shutdown: async () => { events.push('whatsapp.stop'); },
  };
  return originalLoad.apply(this, arguments);
};

require('../main/index.ts');

if (startupRace || startupFailureRace) {
  setTimeout(() => process.emit('SIGTERM'), 0);
}

setTimeout(() => {
  const expectedOrder = startupRace || startupFailureRace
    ? [
      'database.init',
      'server.start',
      'server-app.stop',
      'server.stop',
      'kds.stop',
      'cloud.shutdown',
      'telemetry.stop',
      'drive.stop',
      'whatsapp.stop',
      'database.admission',
      'database.close',
    ]
    : [
      'database.init',
      'dialog.showErrorBox',
      'telemetry.startup-failed',
      'server-app.stop',
      'server.stop',
      'kds.stop',
      'cloud.shutdown',
      'telemetry.stop',
      'drive.stop',
      'whatsapp.stop',
      'database.admission',
      'database.close',
    ];
  const orderMatches = expectedOrder.every((event, index) => events[index] === event);
  const passed = orderMatches && (startupFailureRace
    ? exitCodes.length === 1 && exitCodes[0] === 1 && !events.includes('telemetry.start') && !events.includes('drive.start')
    : startupRace
    ? exitCodes.length === 1 && exitCodes[0] === 0 && !events.includes('telemetry.start') && !events.includes('drive.start')
    : exitCodes.length === 1 && exitCodes[0] === 1);
  process.stdout.write(JSON.stringify({ passed, events, exitCodes, dialogs, telemetryEvents }) + '\n');
  fs.rmSync(testDir, { recursive: true, force: true });
  Module._load = originalLoad;
  realProcessExit(passed ? 0 : 1);
}, startupRace || startupFailureRace ? 100 : 50);
