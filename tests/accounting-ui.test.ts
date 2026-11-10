/**
 * Accounting UI contract test (Milestone I).
 *
 * The accounting surface is read-mostly frontend code with no unit-test
 * harness, so this suite guards the contract it depends on, the same way the
 * RTL and translation suites guard theirs:
 *
 *   1. Every endpoint the UI calls exists as a real backend route — the UI
 *      must never invent an API. Calls are read from the accounting data layer
 *      and matched against the routes actually registered by
 *      `main/routes/accounting.ts` and `main/routes/fiscal-periods.ts`.
 *   2. The page and its sections exist, and the mandated access levels are
 *      applied (owner/manager to read, owner-only to post a manual journal).
 *   3. Each report surface keeps its loading, error and empty states — a
 *      report that silently renders nothing on failure is a regression.
 *   4. The accounting screens use logical direction utilities (RTL-safe) and
 *      every static `accounting.*` label they reference is defined in en.json.
 *   5. The sidebar exposes the accounting entry to owner/manager only.
 *   6. The fiscal-period badge mirrors the backend gate: only a covering
 *      `closed` period blocks posting, an uncovered business date stays
 *      postable.
 *
 * Run: npm run test:accounting-ui
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const ACCOUNTING_DIR = path.join(ROOT, 'frontend/src/components/accounting');
const PAGE_FILE = path.join(ROOT, 'frontend/src/app/(dashboard)/accounting/page.tsx');
const LIB_FILE = path.join(ROOT, 'frontend/src/lib/accounting.ts');
const SIDEBAR_FILE = path.join(ROOT, 'frontend/src/components/layout/Sidebar.tsx');
const MESSAGES_FILE = path.join(ROOT, 'frontend/src/lib/i18n/messages/en.json');
const ROUTES_ACCOUNTING = path.join(ROOT, 'main/routes/accounting.ts');
const ROUTES_FISCAL = path.join(ROOT, 'main/routes/fiscal-periods.ts');
const LIB_FISCAL_PERIODS = path.join(ROOT, 'frontend/src/lib/fiscal-periods.ts');

const SECTION_FILES = [
  'shared.tsx',
  'OverviewTab.tsx',
  'ChartOfAccountsTab.tsx',
  'GeneralLedgerTab.tsx',
  'TrialBalanceTab.tsx',
  'ProfitLossTab.tsx',
  'BalanceSheetTab.tsx',
  'ReconciliationTab.tsx',
  'IntegrityTab.tsx',
  'ManualJournalTab.tsx',
  'OpeningBalanceTab.tsx',
  'FiscalPeriodsTab.tsx',
];

/** Ranged report surfaces that must render loading/error/empty states. */
const RANGED_SECTIONS = [
  'GeneralLedgerTab.tsx',
  'TrialBalanceTab.tsx',
  'ProfitLossTab.tsx',
  'BalanceSheetTab.tsx',
  'ReconciliationTab.tsx',
];

const PHYSICAL_UTIL_RE =
  /\b(ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|left|right)-[0-9a-zA-Z.]+|\btext-(left|right)\b/g;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function read(file: string): string {
  assert(fs.existsSync(file), `missing file: ${path.relative(ROOT, file)}`);
  return fs.readFileSync(file, 'utf8');
}

/** `METHOD /api/<path>` set declared by one route module under a mount prefix. */
function declaredRoutes(file: string, prefix: string): Set<string> {
  const source = read(file);
  const routes = new Set<string>();
  const regex = /router\.(get|post|put|delete|patch)\(\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const [, method, routePath] = match;
    const full = `${prefix}${routePath}`.replace(/\/+$/, '');
    routes.add(`${method.toUpperCase()} ${full || prefix}`);
  }
  return routes;
}

/** `METHOD /api/<path>` set the accounting UI actually calls. */
function uiCalls(): Array<{ method: string; url: string }> {
  const source = read(LIB_FILE);
  const calls: Array<{ method: string; url: string }> = [];
  const regex = /api\.(get|post|put|delete|patch)\(\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    calls.push({ method: match[1].toUpperCase(), url: `/api${match[2]}`.replace(/\/+$/, '') });
  }
  // Template-literal calls (e.g. `/accounting/journals/${id}`) normalise to a
  // `:id` segment so they are checked against the declared route pattern too.
  const templateRegex = /api\.(get|post|put|delete|patch)\(\s*`([^`]+)`/g;
  while ((match = templateRegex.exec(source)) !== null) {
    const normalized = match[2].replace(/\$\{[^}]+\}/g, ':id');
    calls.push({ method: match[1].toUpperCase(), url: `/api${normalized}`.replace(/\/+$/, '') });
  }
  return calls;
}

function run(): void {
  console.log('Accounting UI contract checks:');

  // 1. Every endpoint the UI calls is a real, mounted backend route.
  const available = new Set([
    ...declaredRoutes(ROUTES_ACCOUNTING, '/api/accounting'),
    ...declaredRoutes(ROUTES_FISCAL, '/api/fiscal-periods'),
  ]);
  const calls = uiCalls();
  assert(calls.length >= 9, `expected the accounting data layer to call at least 9 endpoints, found ${calls.length}`);
  for (const call of calls) {
    assert(available.has(`${call.method} ${call.url}`), `UI calls undeclared endpoint ${call.method} ${call.url}`);
  }
  console.log(`  ✓ all ${calls.length} UI endpoints exist in the mounted backend routes`);

  // 2. Page + sections exist, with the mandated access levels.
  assert(fs.existsSync(PAGE_FILE), 'accounting page is missing');
  for (const file of SECTION_FILES) {
    assert(fs.existsSync(path.join(ACCOUNTING_DIR, file)), `accounting section is missing: ${file}`);
  }
  const page = read(PAGE_FILE);
  assert(page.includes('ROLE_ACCESS.ownerManager'), 'accounting page must guard reads with ROLE_ACCESS.ownerManager');
  assert(page.includes('hasRole('), 'accounting page must resolve the role with hasRole');
  assert(page.includes("t('noAccess')"), 'accounting page must render the no-access state');
  const manualJournal = read(path.join(ACCOUNTING_DIR, 'ManualJournalTab.tsx'));
  assert(manualJournal.includes('ROLE_ACCESS.owner'), 'manual journal posting must require ROLE_ACCESS.owner');
  assert(manualJournal.includes("t('ownerOnly')"), 'manual journal must explain the owner-only restriction');
  const openingBalance = read(path.join(ACCOUNTING_DIR, 'OpeningBalanceTab.tsx'));
  assert(openingBalance.includes('ROLE_ACCESS.owner'), 'opening balance posting must require ROLE_ACCESS.owner');
  assert(openingBalance.includes("t('ownerOnly')"), 'opening balance must explain the owner-only restriction');
  assert(openingBalance.includes('createOpeningBalance'), 'opening balance must call the dedicated API helper');
  assert(openingBalance.includes('fetchJournal'), 'opening balance must retrieve the posted journal');
  assert(openingBalance.includes('isDateInClosedPeriod'), 'opening balance must project the fiscal closed-period gate');
  assert(openingBalance.includes('accountingErrorMessage'), 'opening balance must surface backend 400/409 errors');
  assert(page.includes('OpeningBalanceTab'), 'accounting page must render the opening balance tab');
  assert(page.includes("tabOpeningBalance"), 'accounting page must label the opening balance tab');
  const libSource = read(LIB_FILE);
  assert(libSource.includes("api.post('/accounting/opening-balance'"), 'data layer must call POST /accounting/opening-balance');
  assert(libSource.includes('/accounting/journals/'), 'data layer must call GET /accounting/journals/:id');
  console.log('  ✓ page and sections exist with owner/manager read and owner-only posting');

  // 3. Reference data is fetched once per surface (no duplicated financial state).
  const ledger = read(path.join(ACCOUNTING_DIR, 'GeneralLedgerTab.tsx'));
  assert(ledger.includes('latest_balance'), 'general ledger must render the backend-provided running balance');
  assert(!/latest_balance\s*[-+]/.test(ledger), 'general ledger must not recompute the running balance');
  const accounts = read(path.join(ACCOUNTING_DIR, 'ChartOfAccountsTab.tsx'));
  assert(accounts.includes('normal_side'), 'chart of accounts must show the backend normal_side');
  console.log('  ✓ reports render backend figures without recomputing them');

  // 4. Loading / error / empty states on every ranged report surface.
  for (const file of RANGED_SECTIONS) {
    const source = read(path.join(ACCOUNTING_DIR, file));
    assert(source.includes('<AccountingLoading'), `${file} must render a loading state`);
    assert(source.includes('<AccountingError'), `${file} must render an error state`);
    assert(
      source.includes('<AccountingEmpty') || source.includes("t('emptyReport')"),
      `${file} must render an empty state`,
    );
    assert(source.includes('AccountingRangeFilters'), `${file} must use the shared range filter`);
  }
  const overview = read(path.join(ACCOUNTING_DIR, 'OverviewTab.tsx'));
  assert(overview.includes('<AccountingLoading'), 'overview must render a loading state');
  assert(overview.includes('<AccountingError'), 'overview must render an error state');
  console.log('  ✓ every accounting surface renders loading, error and empty states');

  // 5. RTL-safe utilities and defined labels.
  for (const file of SECTION_FILES) {
    const source = read(path.join(ACCOUNTING_DIR, file));
    const matches = source.match(PHYSICAL_UTIL_RE) ?? [];
    assert(matches.length === 0, `${file} uses physical direction utilities: ${[...new Set(matches)].join(', ')}`);
  }
  const pageMatches = page.match(PHYSICAL_UTIL_RE) ?? [];
  assert(pageMatches.length === 0, `accounting page uses physical direction utilities: ${[...new Set(pageMatches)].join(', ')}`);
  console.log('  ✓ accounting screens use logical direction utilities');

  const messages = JSON.parse(read(MESSAGES_FILE)) as { accounting?: Record<string, string>; nav?: Record<string, string> };
  const labels = messages.accounting ?? {};
  assert(Object.keys(labels).length > 0, 'en.json is missing the accounting namespace');
  const labelConsumers = [...SECTION_FILES.map((file) => path.join(ACCOUNTING_DIR, file)), PAGE_FILE];
  for (const filePath of labelConsumers) {
    const source = read(filePath);
    const keyRegex = /\bt\(\s*'([a-zA-Z0-9_]+)'/g;
    let match: RegExpExecArray | null;
    while ((match = keyRegex.exec(source)) !== null) {
      assert(labels[match[1]] !== undefined, `${path.basename(filePath)} references undefined accounting key '${match[1]}'`);
    }
    assert(!/\bt\(\s*`/.test(source), `${path.basename(filePath)} uses a dynamic template-literal translation key`);
  }
  console.log(`  ✓ all referenced accounting labels exist (${Object.keys(labels).length} keys)`);

  // 6. Sidebar exposes accounting to owner/manager only.
  const sidebar = read(SIDEBAR_FILE);
  const navEntry = sidebar.split('\n').find((line) => line.includes("href: '/accounting'"));
  assert(Boolean(navEntry), 'sidebar has no /accounting navigation entry');
  // Upstream moved the sidebar from role lists to permission ids, so the
  // mandate is asserted through the permission registry: the accounting entry
  // must be permitted for exactly owner and manager (a role-list text match
  // would pass for any other entry that happens to name those roles).
  const permissionId = /permission:\s*'([^']+)'/.exec(navEntry!)?.[1];
  assert(Boolean(permissionId), 'sidebar accounting entry declares a permission id');
  const { PERMISSION_BY_ID } = require('../shared/permissions');
  const definition = PERMISSION_BY_ID.get(permissionId);
  assert(Boolean(definition), `sidebar accounting entry uses an unknown permission '${permissionId}'`);
  const roles = definition.defaultRoles as readonly string[];
  assert(
    roles.length === 2 && roles.includes('owner') && roles.includes('manager'),
    'sidebar accounting entry must be owner/manager only',
  );
  console.log('  ✓ sidebar exposes accounting to owner/manager');

  // 7. The fiscal-period badge must match the backend gate (`assertNotInClosedPeriod`
  //    blocks only a covering `closed` period, so an uncovered date is postable).
  const fiscalTab = read(path.join(ACCOUNTING_DIR, 'FiscalPeriodsTab.tsx'));
  assert(!fiscalTab.includes("currentPeriod?.status === 'open'"), 'fiscal tab must not equate "no covering period" with a closed period');
  assert(fiscalTab.includes("from '@/lib/fiscal-periods'"), 'fiscal tab must use the shared closed-period projection');
  assert(/const postable = !isDateInClosedPeriod\(/.test(fiscalTab), 'fiscal tab must derive postable from the closed-period projection');
  const { isDateInClosedPeriod } = require(LIB_FISCAL_PERIODS) as {
    isDateInClosedPeriod: (
      periods: Array<{ status: 'open' | 'closed'; start_date: string; end_date: string }>,
      businessDate: string,
    ) => boolean;
  };
  const businessDate = '2026-10-07';
  const coveringOpen = [{ status: 'open' as const, start_date: '2026-10-01', end_date: '2026-10-31' }];
  const coveringClosed = [{ status: 'closed' as const, start_date: '2026-10-01', end_date: '2026-10-31' }];
  const closedOtherMonth = [{ status: 'closed' as const, start_date: '2026-09-01', end_date: '2026-09-30' }];
  assert(isDateInClosedPeriod(coveringOpen, businessDate) === false, 'F1-A: an open covering period must stay postable');
  assert(isDateInClosedPeriod(coveringClosed, businessDate) === true, 'F1-B: a closed covering period must block posting');
  assert(isDateInClosedPeriod([], businessDate) === false, 'F1-C: no covering period must not be treated as closed');
  assert(isDateInClosedPeriod(closedOtherMonth, businessDate) === false, 'F1-C: a closed period outside the date must not block posting');
  console.log('  ✓ fiscal-period badge matches the backend closed-period gate (open / closed / uncovered)');

  console.log('\n✅ All accounting UI contract checks passed.');
}

run();
