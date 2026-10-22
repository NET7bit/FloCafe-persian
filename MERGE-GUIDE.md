# FloCafe-persian Merge Guide (C1-isolated → real repo)

**Scope**: Integrate upstream `origin/main` (as of `05553096` and later) into the fork
while preserving fork-specific migrations, accounting, customer-account features,
and Persian/Farsi locale.

**Source of truth**: `C:/Users/CofeRoyal/FloCafe-persian-audit/C1-isolated`
(branch `workbuddy/main-28a45223`, 5 local commits on top of merge).

---

## 1. Snapshot the real repo before anything

```bash
cd C:/Users/CofeRoyal/FloCafe-persian
git stash push -m "pre-merge-stash"
git branch backup/main-pre-merge-$(date +%Y%m%d-%H%M%S)
```

---

## 2. Understand the commit topology in C1-isolated

```text
3e3d3ac6  (fork HEAD before merge, 48 files changed, flo.db 2026-10-06)
3adca85a  chore(c2): materialize verified working-tree snapshot on 3e3d3ac6
580e8427  merge: integrate origin/main into the fork snapshot (C2.2 resolution)
9d94b666  fix: post-merge compatibility fixes found by the merged-tree validation
6824e98e  chore: wire the upstream suites that arrived without scripts, and clear the gates they unblocked
0668314a  fix(print): render the delivery customer-details block; complete Thai locale
1cda9302  feat(i18n): complete locale coverage for fork-specific keys  <-- current HEAD
```

*Do NOT cherry-pick these commits directly into the real repo.*  The merge commit
`580e8427` contains 16 resolved conflicts that depend on the exact pre-merge tree.
Instead, replay the **policy** below on a fresh merge in the real repo.

---

## 3. Merge strategy (recommended: rebase-then-merge or direct merge)

### Option A — Merge commit (safest, preserves history)

```bash
git fetch origin
git merge origin/main
# resolve conflicts using the policy in §4
git merge --continue
```

### Option B — Rebase onto upstream (cleaner history, harder)

```bash
git fetch origin
git rebase origin/main
# resolve conflicts using the policy in §4
```

**Recommendation**: Option A.  The fork has 92 local migrations and 11 feature
commits; a merge commit makes rollback easier.

---

## 4. Conflict-resolution policy (C2.2, verified in C1-isolated)

| Area | Policy | Rationale |
|------|--------|-----------|
| **Migrations** | Fork registry `1..1012` wins. Upstream `v93..v104` are **ignored** in the fork. | The fork renumbered upstream post-v92 migrations to `1002..1012` to avoid collision. |
| **Protected print files** | Keep fork versions (`printers/document-classic.ts`, `document-compact.ts`, `document-compact-v2.ts`, `document-webusb.ts`, `document-browser.ts`). | These carry Persian shaping, toman invoice, and compact-renderer fixes. |
| **Manifest / orchestrator** | Accept upstream `scripts/ci/test-suites.json` **plus** insert the 10 upstream-only suites before the tail entry `test:accounting-ui`. | Upstream added suites without `package.json` scripts; the orchestrator must still enumerate them. |
| **Business-date callers** | Accept upstream deletions; rewire any remaining internal callers to `@shared/business-date`. | Upstream extracted business-date logic into a shared module. |
| **API breaks** | See §5. | |

---

## 5. Known API breaks and required rewiring

| Break | Location | Fix |
|-------|----------|-----|
| `requirePermission` reads live `users` table | `main/ipc.ts` and permission gates | After DB wipe / import, tokens reference missing users → 403. Re-create placeholder users or clear tokens after restore. |
| `ipcMain.handle` sender check | Every `ipcMain.handle` registration | Upstream added `trusted localhost sender` guard. If any fork IPC is called from a non-localhost origin, it will 403. Verify fork IPC callers. |
| `createSchema()` ships v93-v98 objects | Test fixtures / setup code | Fork "pre-v93" fixtures must strip the two settings rows (`country`, `currency`) that upstream now injects. |
| `OrderSnapshot` requires `deliveryAddress` | Any code constructing `OrderSnapshot` | Add `deliveryAddress: null` or real value. |
| `required-checks-gate` needs `docs-checks` | `.github/workflows/*.yml` | Add `needs: docs-checks` to the required-checks gate job. |

---

## 6. Post-merge mechanical fixes (apply in this order)

These are **not** conflicts; they are tree-wide adjustments that must be done
after the merge resolves cleanly.

### 6.1 Print renderers — add the customer-details block

Upstream `PrintDocument` now carries a `customer` block with `heading`,
`address`, and `addressLabel`.  The fork's backend renderers predate this block.

**Files to edit**:

- `main/printers/document-classic.ts`
- `main/printers/document-compact.ts`

**Changes** (see commit `0668314a` in C1-isolated for exact diffs):

1. Re-import `pushWrapped` from `shared/print/formatting-helpers` if not present.
2. In the `'customer'` case block, render `block.heading` as a centered bold line.
3. After the phone line, render `block.address` with label prefix and wrapping.

### 6.2 i18n — complete missing fork keys for every locale

Upstream added 9 new locales. Each ships with only upstream's key set.
The fork adds ~130 accounting/customer-account keys that must be present.

**Fastest path**: copy the prepared translations from C1-isolated:

```bash
# In C1-isolated:
cp c2-tmp/i18n/*.json /tmp/fork-i18n/
# In real repo (after merge):
node scripts/apply-fork-i18n.cjs   # or manually merge the 130 keys per locale
```

**Verification**:

```bash
node -e "const d=require('./frontend/src/lib/i18n/messages'); /* parity check */"
```

All 11 locales must show **2893 keys** parity with `en.json`.

### 6.3 Test assertion updates

- `tests/accounting-ui.test.ts`: the sidebar moved from role-list strings to
  permission-id checks. Assert the mandate through the permission registry
  (entry's permission must be permitted for exactly `owner` and `manager`).

---

## 7. Validation gates (must all pass before push)

Run these in order.  Do **not** skip steps.

| Gate | Command | Expected |
|------|---------|----------|
| Type-check | `npm run tsc -- --noEmit` | 0 errors |
| Migration convergence | `npm run test:migration-registry` | 335/335 checks, `user_version=1012` |
| FK/KDS gate | `npm run test:kds-contract` + `test:kds-integration` | pass |
| Import/restore atomicity | `npm run test:import-restore-y1-y2-hardening` | pass |
| Startup-restore | `npm run test:import-restore-y1-y2-hardening` (includes startup path) | 141/141 checks |
| Print parity | `npm run test:print-parity` | pass |
| Print document | `npm run test:print-document` | pass |
| Accounting UI | `npm run test:accounting-ui` | pass |
| i18n parity | custom script (see §6.2) | all locales 2893 keys |
| Full suite run | `npm test` (219 suites) | acceptable failure rate* |

*Electron-based suites may `EBUSY` fail in sandbox/CI; run them individually
with `node_modules/.bin/ts-node --transpile-only -P tests/tsconfig.json <file>`
if needed.

---

## 8. Divergence decision (owner must choose)

The real repo is currently **+31 / -90** vs `origin/main`.  After this merge:

- Accept upstream deletions → divergence shrinks.
- Keep fork-only files (accounting, customer-account, Persian print patches) →
  divergence never reaches zero.

**Recommended**: merge now, then decide later whether to upstream the accounting
module or maintain it as a permanent fork.

---

## 9. Emergency rollback

If the merge breaks the real repo:

```bash
cd C:/Users/CofeRoyal/FloCafe-persian
git reset --hard backup/main-pre-merge-<timestamp>
git stash pop
```

The isolated clone (`C1-isolated`) remains untouched and can be re-used for a
second attempt.

---

*Generated from C1-isolated validation run on 2026-10-18.*
*All 19/19 gates passed in the isolated clone at the time of writing.*
