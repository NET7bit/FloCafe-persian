# FloCafe operations runbook

Operator-facing procedures for a live restaurant installation: daily health, local backup
policy, failure visibility, an incident playbook, the LAN trust boundary, Persian printing
status, restore rehearsal policy, and the repeatable restaurant-day UAT procedure.

Companion documents: [API.md](reference/api.md) (endpoints, ports, rate limits) ·
[printers.md](printers.md) (printer setup/troubleshooting) ·
[printing.md](architecture/printing.md) (non-Latin decision record) ·
[maintainers/upgrade-testing.md](maintainers/upgrade-testing.md) (installed-artifact upgrade evidence).

---

## 1. Daily health check

| # | Check | Expected |
| --- | --- | --- |
| 1 | App starts and the window opens | `[Flo] Initializing...` → `[DB] Opening database at: …` → `[DevServer]/[Server] … running on http://localhost:3001` (KDS `:3002`, Server App `:3003`) |
| 2 | Database opens clean | `[DB] integrity_check: ok` and `[DB] foreign_key_check: clean` |
| 3 | POS reachable from a second device on the shop LAN | `http://<host-ip>:3001` loads the POS; `http://<host-ip>:3002` serves KDS |
| 4 | Shift opened | Cash session `open` with the shift opening float |
| 5 | End of day | Shift close then day close; variance is the counted-versus-expected drawer difference |
| 6 | Accounting after close | Trial balance difference `0`, integrity report `ok` in the Accounting screens |

---

## 2. Local backup policy

Backups are written to the application data directory under `backups/`
(`…/Flo Cafe/backups` on Windows, the platform equivalent elsewhere). The file name carries the
creation stamp and a random suffix; pre-migration snapshots add `-pre-v<schema>`.

### What runs automatically

| Mechanism | When | Notes |
| --- | --- | --- |
| Pre-migration snapshot | Before any schema upgrade | Always on; the recovery point for a failed upgrade |
| Retention prune | App start and every scheduler tick (30 min) | Filesystem-only; never touches the live database |
| Daily local backup | Opt-in (see below), at most once per 24 h | Implemented by `main/services/backup-scheduler.ts` |

### Retention policy

- Keep the newest **14** managed backups (`flo-backup-*.db`).
- Never prune anything younger than **24 h**, so a busy day of manual backups cannot delete the
  copy an operator just made.
- Never prune a file outside the managed naming scheme, and never prune a backup whose timestamp
  cannot be read.
- A prune failure (locked file, permissions) is logged and skipped; pruning never aborts startup.

### Daily local backup (opt in)

```text
auto_backup_enabled = true     # setting; absent/false leaves the schedule off
auto_backup_last_at            # written by the app after a successful automatic backup
```

While enabled, the app takes a local backup when the last successful automatic one is older than
24 h, checked on start and every 30 minutes. A missing or unreadable `auto_backup_last_at` counts
as "due", so a damaged setting can never silently disable backups.

### Failure behaviour

| Situation | Behaviour |
| --- | --- |
| Backup fails (locked file, permissions, disk full) | The failure is logged, no partial file is published, the app keeps operating on the live database, and the next tick retries |
| Disk full | Same as above; free space or disable `auto_backup_enabled` — never delete the live database |
| Retention scan fails | Logged; no file is deleted |

### Restore verification policy

- Rehearse a restore on an **isolated copy**, never beside the live database (see §7).
- After any restore: verify `integrity_check`, `foreign_key_check`, the schema version, and the
  trial-balance difference before returning the terminal to service.
- Keep at least one backup from before the incident until the day's numbers are confirmed.

---

## 3. Logs and failure visibility

- File log: `main.log` in the application logs directory (open it from the tray menu →
  *Open Logs Folder*). Rotation is bounded (~1 MB with one archived copy), so logs cannot grow
  without limit.
- Console mirrors the same lines with `debug` level for development runs.
- Useful markers: `[DB]` (open, integrity, backup, restore), `[Backup]` (retention, automatic
  backup), `[Accounting] skipped: …` (an accounting projection was deliberately skipped and is
  left to reconciliation), `[Printing]`/`print.` failure codes (a print refusal reports
  `failure_class`, `code`, `stage`, and a `correlation_id`).
- Collector: support tickets may attach a bounded `log_tail` (see
  [cloud-integrations.md](architecture/cloud-integrations.md)).

---

## 4. Incident playbook

| Symptom | First check | Safe action | Escalate when |
| --- | --- | --- | --- |
| Application will not start | Log tail for `[DB]` errors and the last startup line; is another FloCafe instance holding ports 3001–3003? | Close the other instance; retry. If the database failed integrity, restore the newest pre-migration or manual backup into place (§7) | Database file is missing/corrupt and no backup validates |
| Database unavailable / locked | `flo.db-wal` and `flo.db-shm` permissions; antivirus or backup software holding the file | Close the app cleanly, let the lock release, reopen; never delete `flo.db` | Repeated lock errors with no third-party process |
| Printer unavailable | Printer powered, on the shop LAN, same IP/port as configured; test page from the printer settings | Re-run the test page; re-match the correct profile (paper width and model) | Refusals persist for every profile (`print.receipt.failed`) |
| Backup failed | Free disk space; `[Backup]` lines; backups directory permissions | Free space or disable `auto_backup_enabled`; take a manual backup once healthy | Backups fail repeatedly with free space |
| Accounting mismatch | Accounting → Reconciliation report: which domain reports `MISMATCH`, and the `details` counters | Do not edit journals. Record the domain, difference, and window; keep the day open | Any mismatch in a money domain |
| Fiscal period issue | Fiscal periods screen: is a closed period covering today's business date? | Post into an open/uncovered date, or reopen the period deliberately | A closed period must be reopened for a legitimate correction |
| LAN client cannot connect | Host IP unchanged; Windows Firewall allows inbound 3001/3002/3003 on the private profile; client on the same subnet | Add/repair the firewall rule for the private network profile | Clients connect but are rejected by authentication |
| Restore required | Newest validated backup, schema version, and the day's Z-report numbers | Restore on the terminal, then re-verify integrity and trial balance (§7) | The restore target is not validated |

---

## 5. LAN trust boundary policy

FloCafe binds its local servers to `0.0.0.0` so POS terminals, KDS screens, and the server app can
reach the host over the shop network. There is **no TLS on the LAN** in this configuration; the
transport is trusted-network only.

Operator policy:

1. **Private LAN only.** Run FloCafe on a dedicated shop network or VLAN that has no route to the
   public internet for the POS ports.
2. **Firewall restricted.** Allow inbound 3001 (API), 3002 (KDS) and 3003 (server app) only on the
   private network profile, and only from shop devices.
3. **Never port-forward** these ports on a router or expose them through a tunnel.
4. **Strong credentials.** Owner account uses a long password and a non-trivial PIN; PINs are what
   authorize refunds and destructive flows.
5. **Client isolation** between guest networks and the POS LAN (separate SSID/VLAN).
6. Per-IP rate limits already protect the API surface (see [API.md](reference/api.md)); they are not a
   substitute for the boundary above.

If your environment requires encrypted transport between terminals and the host, that is an
architecture decision to raise with maintainers rather than a per-install toggle.

---

## 6. Persian thermal printing — current status

Persian receipts are printed through the capability-gated raster path: lines that cannot be
represented in the printer's native character set are rendered on the host (Chromium surface) and
emitted as `GS v 0` bitmap bands, interleaved with native ESC/POS text for Latin/numeric content.
Shipped profiles enable raster with the paper width derived from the configurable paper width.

Status to carry into a go-live decision:

- The raster path renders shaped, right-to-left Persian with correct digits and right-aligned
  financial rows, and every emitted band stays inside the profile width and height limits; the
  receipt assembly reports no render failures and no warnings for a full mixed Persian receipt.
- Persian output has **not** been proven on physical printer hardware. Before a restaurant goes
  live, print a Persian receipt on the actual model and validate: shaping, right-to-left order,
  digits/currency, wrapping for long item names, alignment of amounts, tear/cut position, and
  legibility on 80 mm (and 58 mm if used). The checklist is in
  [printing.md](architecture/printing.md) §6.
- If a receipt is refused with `print.receipt.failed`, that is the safety contract working: a
  financial row would have lost content. Re-check the selected profile and paper width rather than
  reprinting blind.

---

## 7. Restore rehearsal

1. Take a fresh backup of the live database.
2. Copy the database (plus `-wal`/`-shm`) into an isolated directory, never next to the live file.
3. Restore the backup into the isolated copy and record: schema version, table count, row counts
   for the financial tables, journal and journal-line counts, `integrity_check`,
   `foreign_key_check`, and trial-balance difference.
4. Compare against the pre-restore numbers; any count difference is a failure to investigate.
5. Rehearse at a realistic database size. Small databases restore in well under a second; a
   production-sized shop database has not been measured yet, so schedule the rehearsal during
   off-hours until it has been.

---

## 8. Repeatable restaurant-day UAT

Run on an **isolated database** (a dedicated application data directory), never on the shop's live
data, and drive it through the real API/UI paths so the evidence stays production-relevant.

| # | Step | Expected | Evidence |
| --- | --- | --- | --- |
| 1 | First-run setup (language, country, currency, timezone, profile) | Setup completes; system accounts seeded | Settings snapshot |
| 2 | Owner + manager logins | Correct roles returned | Login responses |
| 3 | Menu/catalog and customer setup | Demo or shop menu visible; customer created | Catalog/customer ids |
| 4 | Open shift with float | Session `open`, expected cash = float | Session snapshot |
| 5 | Cash sale | Bill paid; one sale journal; cash increased | Bill + journal + reconciliation |
| 6 | Card sale | Bill paid; bank/card journal | Same |
| 7 | Split payment | One bill, one batch, one journal with both tenders | Batch id + journal |
| 8 | Customer credit (`customer_account`) | Bill paid via AR; one sale journal with the AR debit; receivable `charge` mirror | Bill, journal, receivable row |
| 9 | Customer settlement | Settlement entry; AR nets to zero | Receivable row + journal |
| 10 | KDS flow (order → preparing → ready → completed, bill settled) | Kitchen visibility and transitions succeed | KDS responses |
| 11 | Recipe depletion | Supply stock decreases by the recipe quantity | Supply movements |
| 12 | Purchase (invoice + post) | Stock and cost move; purchase journal | Invoice + journal |
| 13 | Supplier payment | AP decreases; separate payment journal | Payment + journal |
| 14 | Purchase return | Stock/AP corrected; return journal | Return + journal |
| 15 | Expenses (cash and bank) | Expense journals per method | Expense + journal |
| 16 | Refund (full) and over-refund attempt | Refund posts; over-refund is refused | Refund + journal + 400 response |
| 17 | Second (partial) refund | Partial refund posts; bill status `partially_refunded` | Refund + journal |
| 18 | Shift close then day close | Variance computed; day closed once | Closure payloads |
| 19 | Reports | Trial balance difference `0`; P&L and balance sheet consistent | Report payloads |
| 20 | Reconciliation | Every reconcilable domain `MATCH` (cash is reported as not reconcilable by design) | Reconciliation payload |
| 21 | Integrity | No unbalanced journals, orphans, or duplicate identities | Integrity payload |
| 22 | Backup and restore rehearsal | Backup hash recorded; restore reproduces counts (§7) | Backup/restore outputs |

Record for every step: step, expected, actual, status (`PASS`/`FAIL`/`NOT VERIFIED`/`BLOCKED`),
and the raw evidence. A step that cannot be exercised in the environment (for example a physical
printer) is recorded as `NOT VERIFIED` — never as a pass.
