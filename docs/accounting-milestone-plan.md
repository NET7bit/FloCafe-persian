# Accounting Implementation Milestone Plan (Stage 5 — Planning-only)

> Status: **Stage 5 deliverable — no production code, schema, migration, test, refactor, commit, or push.**
> Basis: [accounting-current-state.md](accounting-current-state.md) (Stage 2) ·
> [accounting-architecture-plan.md](accounting-architecture-plan.md) (Stage 3, Integrity PASS) ·
> [accounting-scope-review.md](accounting-scope-review.md) (Stage 4, Final Verification PASS: 123 lines, all canonical counts).
> Repository evidence re-checked: module files listed per milestone exist at HEAD (`main/services/*`, `main/routes/*`).

---

## 1. Executive Summary

Nine milestones (A–I) implement Accounting v1 strictly inside the approved scope. **A** builds the
append-only ledger core (migration v102). **B** adds opening/manual journals (owner-only). **C**
integrates the untouched sales core through a post-commit adapter. **D–F** wire the modern v93–v99
services inline. **G** (COGS) is **blocked by default** until pricing evidence exists. **H**
delivers reports/reconciliation. **I** delivers the accounting UI. Dependency graph: A → (B, C, D,
E, F) → H → I; G independent-but-blocked. No milestone changes bills/refunds/cash-closure
write-paths, v99 semantics, or the v101 fiscal model.

---

## 2. Planning Constraints (Final Rules — binding for all milestones)

1. Scope creep ممنوع — هر feature فقط از Scope Matrix Stage 4.
2. Multi-branch / multi-warehouse ممنوع.
3. v99 / v101 redesign ممنوع؛ existing migrations rewrite ممنوع (فقط append v102).
4. Duplicate financial state ممنوع — مانده‌ها مشتق، period مشتق.
5. جدول عمومی `payments` ساخته نمی‌شود؛ منبع پرداخت = `bills.payment_details`.
6. تصمیم معماری جدید فقط با ثبت به‌عنوان Open Question (§17).
7. COGS بدون evidence وارد implementation نمی‌شود (G blocked by default).
8. Tax Engine جدید / Wallet accounting / Cash Closure Journal — ممنوع.
9. Existing reports بازنویسی نمی‌شوند — فقط reconcile.
10. هر milestone مستقل: Inspect → Implement → Tests → Integration → Migration/Upgrade → Regression → Lint → Build → Diff Review → Commit (بدون push).
11. **Failure visibility is derived, not stored** — visibility از log/error + derived reconciliation
    query به دست می‌آید و اصلاح آن با explicit reprocess operation انجام می‌شود (مدل کامل: §7.1).

---

## 3. Final v1 Scope Reference (از Stage 4 — بدون تغییر)

**v1:** CoA (seed، بدون `2050`) · GL · Trial Balance · P&L پایه (Revenue+Expense، بدون ادعای سود کامل) · Balance Sheet پایه (`1200` holding) · Manual Journal (owner) · Sales/Payments/Refunds/Receivables/Purchases/Supplier/Returns/Expenses Accounting · Fiscal consumption (`assertNotInClosedPeriod`) · Cash Closure reports/reconciliation (حفظ موجود).
**Later:** COGS/valuation (G) · Tax rules/reversal کامل · Fiscal UI + Opening wizard + aging (I بخشی در H/I).
**Out of scope:** Cash Closure Journal · Wallet accounting · Multi-branch/warehouse/currency · Payroll · Consolidation · ERP/cost-centers · Depreciation · Tax engine.

**Critical Accounting Rules (ثابت — تغییر در این برنامه ممنوع):**

- SoT: Sale = `bills` → Sale Journal؛ ‏charge با `reference=bill_id` = mirror فقط (بدون journal)؛
  پرداخت بعدی روی bill → Collection Journal (seq≥2)؛ ‏`receivable_entries.settlement` →
  Settlement Journal؛ یک payment هرگز هم Collection و هم Settlement نمی‌شود.
- Financial Date: Revenue = تاریخ صدور bill؛ Collection/Settlement = تاریخ رویداد وصول خودشان؛
  `paid_at` هرگز تاریخ Revenue نیست.
- Tax: فقط `bill.tax_amount` موجود → Cr `2100`؛ بدون engine/rule جدید؛ reversal کامل خارج از v1.
- Cash Closure Journal = OUT OF SCOPE؛ Reports/Reconciliation = IN SCOPE؛ هیچ مسیر غیرمستقیمی
  closure را به accounting event تبدیل نمی‌کند.
- Wallet = OUT OF SCOPE (بدون account/journal/mapping).
- `1200` = فقط purchase/inventory holding؛ نه valuation و نه COGS.
- Fiscal period فقط از `journal_entries.entry_date` مشتق می‌شود — بدون `fiscal_note`، بدون
  `fiscal_period_id`، بدون duplicated state.

---

## 4. Dependency Graph

```text
Depends On              Milestone                          Enables
────────────────────────────────────────────────────────────────────────
—                       A  Accounting Core (v102)          B, C, D, E, F, H
A                       B  Opening / Manual Journal        H (opening equity), I
A                       C  Sales Accounting (adapter)      H (sales reconciliation)
A                       D  Receivables (inline)            H (AR reconcile)
A                       E  Purchases & Suppliers (inline)  H (AP reconcile), G*
A                       F  Expenses (inline)               H (expense reconcile)
A + E + C/D/F history   G  COGS / Inventory                full inventory reporting
B, C, D, E, F           H  Reports & Reconciliation        I
A–H (API stable)        I  UI / Accounting Operations      —
```

- اصلاح نسبت به ساختار پیشنهادی prompt: **G** به E وابسته است نه فقط A (ارزش‌گذاری برگشت خرید و
  WAC تاریخچه از purchase data می‌آید — Stage 2 §13) و **H** به B وابسته است (opening equity در
  Trial Balance/Balance Sheet باید دیده شود). C و D می‌توانند پس از A موازی اجرا شوند (ماژول‌های
  جدا، صفر تداخل فایل)؛ E و F هم همین‌طور. ترتیب پیشنهادی اجرا: A → B → C → D → E → F → H → I
  (G فقط پس از Unblock).

---

## 5. Milestone A — Accounting Core

1. **Objective:** هسته ledger دوطرفه append-only با fiscal gate و مانده مشتق.
2. **Scope:** فقط schema v102 + سرویس حساب/ژورنال + ایندکس‌ها؛ هیچ integration.
3. **Included:** CoA (seed ۱۲ حسابی بدون wallet)، ‏`journal_entries`، ‏`journal_entry_lines`،
   debit/credit validation، balanced-entry invariant (SUM Dr = SUM Cr در هر journal)،
   append-only + `reverses_journal_id`، derived balances، idempotency
   `UNIQUE(source_module, source_id, seq)`، fiscal enforcement از `entry_date` (تغییری در v101)،
   مهاجرت/upgrade path.
4. **Excluded:** هر integration با ماژول‌ها (B–F)؛ گزارش‌ها (H)؛ UI.
5. **Modules/files:** جدید `main/services/accounting.ts`، `main/routes/accounting.ts`؛ ‏`main/db.ts`
   (append v102)؛ ‏`main/routes/index.ts` (mount)؛ ‏`package.json` (test scripts).
6. **Existing SoT:** — (هیچ جدول موجود تغییر نمی‌کند).
7. **New SoT:** `accounting_accounts`, `journal_entries`, `journal_entry_lines`.
8. **Dependencies:** —.
9. **DB impact:** migration `v102 add_accounting_core` (+۳ جدول + ایندکس‌ها + seed `INSERT OR IGNORE`)؛ بدون ALTER جداول موجود.
10. **API/service impact:** CRUD حساب (owner)؛ create-journal داخلی (برای B–F)؛ list/balances.
11. **UI impact:** —.
12. **Transaction boundaries:** insert journal + lines در یک `withTxn`؛ balanced-check داخل txn.
13. **Fiscal-period behavior:** `assertNotInClosedPeriod(db, entry_date)` قبل از insert؛ بدون FK.
14. **Idempotency:** `UNIQUE(source_module, source_id, seq)`؛ خطای conflict = skip در adapter،
    rollback در inline.
15. **Reversal/delete:** حذف فیزیکی journal ممنوع؛ فقط reversal.
16. **Required tests:** `migration-v102-accounting-core` (الگوی v101، TARGET_VERSION پویا، ارتقای
    v101→v102، idempotent re-run)، ‏`accounting-core-service` (balanced/reject/fiscal/reversal/derived).
17. **Regression:** schema-health، upgrade-path، ‏npm test.
18. **Migration/upgrade:** backup خودکار `syncBackupBeforeMigration` (موجود) کافی است.
19. **Acceptance:** balanced journal درج می‌شود؛ unbalanced → 400؛ ‏closed-period → 409؛ reversal
    آینه می‌سازد؛ مانده = SUM؛ هیچ ردیف جدول موجود تغییر نکرده.
20. **Risks:** seed حساب‌ها با tenant موجود تداخل code کند → `INSERT OR IGNORE` + تست.
21. **Open Questions:** —.

## 6. Milestone B — Opening / Manual Journal

1. **Objective:** ورود مانده‌های افتتاحیه و اصلاحات دستی owner با کنترل کامل.
2. **Scope:** manual journal route + opening convention؛ هیچ تغییر schema (در صورت نیاز به
   `seq` قراردادی — همان ستون موجود).
3. **Included:** manual journal (multi-line)؛ opening balances via dedicated `createOpeningBalance`
   (source_module=`opening_balance`)؛ balanced validation؛ owner-only؛ fiscal validation؛ reversal؛
   **opening-balance idempotency/source resolved**: `source_module='opening_balance'` with a
   deterministic, service-derived `source_id` (`openingBalanceSourceId`, a hash of the opening's
   lines); the client must not supply `source_id`.
4. **Excluded:** Opening wizard UI (I)؛ wallet/cash accounts جدید.
5. **Modules/files:** `main/routes/accounting.ts` (POST /journals)، ‏`main/services/accounting.ts`.
6. **Existing SoT:** —.
7. **New SoT:** ردیف‌های manual در `journal_entries` (source_module='manual')؛ ردیف‌های opening balance نیز در همان جدول با source_module='opening_balance' ثبت می‌شوند.
8. **Dependencies:** A.
9. **DB impact:** —.
10. **API/service:** ‏`POST /api/accounting/journals` (owner)، ‏`POST /api/accounting/journals/:id/reverse` (owner).
11. **UI impact:** — (I بعداً).
12. **Transaction:** با A مشترک.
13. **Fiscal:** همان gate؛ opening journal به تاریخ افتتاح (کسب‌وکار) نیاز دارد.
14. **Idempotency:** `source_id` افتتاحیه deterministic و service-derived است (`openingBalanceSourceId` روی خطوط سند)؛ client اجازهٔ تعیین آن را ندارد. ثبت تکراری با همان محتوا روی `UNIQUE(source_module, source_id, seq)` برخورد کرده و 409 برمی‌گرداند.
15. **Reversal:** reversal-only.
16. **Tests:** `accounting-manual-journal` (balanced/owner-gate/fiscal/reversal/opening).
17. **Regression:** A suites.
18. **Migration:** —.
19. **Acceptance:** فقط owner 201 می‌گیرد؛ manager → 403؛ unbalanced → 400؛ reversed journal دوباره
    reverse نمی‌شود.
20. **Risks:** OQ#1 اگر تأیید نشود → blocker B-part (پیشنهاد پیش‌فرض ثبت شده).
21. **Open Questions:** #1 (تصمیم پیش‌فرض در همین milestone نهایی می‌شود).

## 7. Milestone C — Sales Accounting (adapter؛ بدون تغییر bills)

1. **Objective:** Sale/Collection/Refund journals از هسته فروش **بدون تغییر write-path**.
2. **Scope:** ‏`main/services/accounting-sales-adapter.ts` جدید + فراخوانی post-commit از caller‌های
   موجود بدون edit منطق پرداخت؛ failure visibility صرفاً از log/error + derived reconciliation
   query (§7.1).
3. **Included:** cash/card sales؛ credit sales؛ partial payments؛ Sale Journal (seq 1)؛ Collection
   Journal (seq≥2)؛ Refund Journal؛ tax posting از `bill.tax_amount` موجود؛ sales adapter؛
   idempotency؛ reconciliation query.
4. **Excluded:** تغییر `bills.ts` logic؛ Tax engine؛ wallet؛ cash-closure journal.
5. **Modules/files:** جدید `main/services/accounting-sales-adapter.ts`؛ فراخوانی پس از commit در
   `main/routes/bills.ts` **فقط یک خط بعد از `withTxn(...)`** (post-commit، بدون تغییر منطق) و
   `main/routes/refunds.ts` به همین سبک؛ این محدودیت پیش‌تر در Stage 3 §8 تعیین شده است.
6. **Existing SoT:** `bills` (total/tax_amount/payment_details/paid_at/created_at)، ‏`refunds`.
7. **New SoT:** journals با `source_module='sales'`/`'refunds'`.
8. **Dependencies:** A.
9. **DB impact:** — No new accounting-specific failure/retry storage (visibility از log/error +
   derived reconciliation query مطابق §7.1 — **Open Question #3** پیش‌فرض: report-only).
10. **API/service:** داخلی؛ + `GET /api/accounting/reconcile/sales` (owner) در H.
11. **UI impact:** —.
12. **Transaction:** adapter پس از commit اجرا می‌شود؛ هرگز rollback سند POS نمی‌کند (money first).
13. **Fiscal:** closed-period → journal با 409 رد می‌شود؛ سند POS موفق می‌ماند؛ خطا log می‌شود؛
    reconciliation بعداً journal ناموجود را پیدا می‌کند؛ retry/reprocess پس از reopen (هرگز سکوت) —
    دقیقاً مطابق blockquote §7.1 — Stage 3 §9.
14. **Idempotency:** `UNIQUE(source_module='sales', source_id=billId, seq)` — replay امن.
15. **Reversal:** refund = journal مستقل؛ اصلاح bill = manual correction (B).
16. **Tests:** `accounting-sales-adapter` (نقدی/کارت/نسیه/نیمه‌نسیه/partial/Collection seq/Refund/
    tax-only-from-bill/idempotent replay/closed-period missing-journal reconciliation).
17. **Regression:** `bills-customer-account`، ‏`receivables-e2e`، ‏integration-payments، cash-closures.
18. **Migration:** —.
19. **Acceptance:** هر سناریو Stage 3 §7.2 دقیقاً یک journal؛ Revenue تاریخ صدور؛ بدون دست‌زدن به
    diff منطق bills.
20. **Risks:** parsing `payment_details` legacy (R2) → فقط قرارداد مستند فعلی؛ فراخوانی post-commit
    در خطای اجرا → log/error + derived reconciliation + reprocess operation (§7.1).
21. **Open Questions:** #3 (reconciliation report + reprocess operation — §17 و §7.1).

### 7.1 Canonical Failure Visibility Model (الزام مشترک همه milestoneها)

> **Failure visibility is derived, not stored:** Failure visibility is derived from existing
> journals, source documents, application/error logs, and reconciliation queries. Only journals
> and their source documents are persisted. Failure detection is performed by comparing expected
> journals with existing `journal_entries` at read/reconciliation time. Correction is performed
> through an explicit reprocess operation guarded by `source_module + source_id + seq`
> idempotency.

Canonical closed-period flow (identical everywhere):

```text
source committed
        ↓
adapter attempted
        ↓
fiscal gate returns 409
        ↓
source remains successful
        ↓
error/log
        ↓
reconciliation detects missing journal
        ↓
period reopens
        ↓
explicit reprocess
        ↓
idempotent journal creation
```

توضیح فارسی:

- وضعیت accounting هر سند derived است: از مقایسه source documents با `journal_entries` در زمان
  خواندن/reconciliation محاسبه می‌شود.
- «Journal is missing» = condition قابل‌محاسبه reconciliation و مبنای گزارش
  «Adapter Failure / Missing-Journal Reconciliation Report» در Milestone H.

## 8. Milestone D — Receivables Accounting (inline در v99)

1. **Objective:** ‏Charge/Settlement/Manual-AR journals از ledger موجود بدون double-journaling.
2. **Scope:** فراخوانی inline داخل `withTxn` سرویس v99.
3. **Included:** customer credit (mirror rule)؛ settlement؛ تفکیک Collection/Settlement؛ AR control
   reconcile.
4. **Excluded:** تغییر semantics/hard delete v99؛ journal برای charge با reference.
5. **Modules/files:** ‏`main/services/receivables.ts` (createReceivableEntry، deleteReceivableEntry)؛
   `main/routes/bills.ts` نیازی به تغییر ندارد (Mirror Rule در سمت adapter است).
6. **Existing SoT:** `receivable_entries`.
7. **New SoT:** ‏journals `source_module='receivables'`.
8. **Dependencies:** A (+C برای هم‌اهنگی Mirror در ادغام، ولی کد مستقل).
9. **DB impact:** —.
10. **API/service:** فراخوانی داخلی دو تابع سرویس.
11. **UI impact:** —.
12. **Transaction:** همان txn سرویس (insert entry + journal atomic).
13. **Fiscal:** gate دوباره (double-guard: entry خودش gate دارد؛ journal همان `entry_date` را چک
    می‌کند — سازگار، هرگز تناقض).
14. **Idempotency:** ‏`UNIQUE('receivables', entry.id, 1)`.
15. **Reversal:** hard delete entry → reversal همزمان در همان txn (Stage 3 §10).
16. **Tests:** `accounting-receivables-integration` (charge با reference → فقط Sale journal از C؛
    charge دستی → Manual AR؛ settlement → Settlement؛ delete → reversal).
17. **Regression:** receivables-service/-routes، ‏receivables-e2e، ‏bills-customer-account.
18. **Migration:** —.
19. **Acceptance:** مانده `1100` ledger = SUM مشتق journal AR در هر لحظه؛ حذف entry مانده journal را
    هم صفر می‌کند.
20. **Risks:** ترتیب C/D — اگر C مؤخر باشد، charge با reference باید هنگام فعال‌سازی C هم journal
    نشود (Mirror test در C پوشش می‌دهد).
21. **Open Questions:** —.

## 9. Milestone E — Purchases & Suppliers Accounting (inline)

1. **Objective:** ‏Purchase/AP/Payment-out/Return-outward journals.
2. **Scope:** inline در سه سرویس v94/v95/v96.
3. **Included:** posted invoice → Dr `1200`/Cr `2000`؛ supplier payment → Dr `2000`/Cr `1000|1010`؛
   purchase return → Dr `2000`/Cr `1200` (مبلغ سند)؛ reversal rules؛ fiscal enforcement؛ idempotency.
4. **Excluded:** draft journals؛ COGS/valuation؛ wallet.
5. **Modules/files:** ‏`main/services/purchase-invoices.ts` (post)، ‏`supplier-payments.ts`
   (create/delete)، ‏`purchase-returns.ts` (create/delete).
6. **Existing SoT:** سه جدول purchase/supplier.
7. **New SoT:** ‏journals `source_module='purchases'|'supplier_payments'|'purchase_returns'`.
8. **Dependencies:** A.
9. **DB impact:** —.
10. **API/service:** فراخوانی داخلی.
11. **UI impact:** —.
12. **Transaction:** همان txn سرویس‌ها.
13. **Fiscal:** gate موجود + gate journal (همان `invoice_date`/`paid_at→fiscalDate`/`return_date`).
14. **Idempotency:** UNIQUE per event.
15. **Reversal:** delete payment/return → reversal همزمان؛ soft-delete return هم reversal دارد.
16. **Tests:** `accounting-purchases-integration` (post/payment/return/delete-reversal/closed-period).
17. **Regression:** purchase-invoices-*, supplier-payments-*, purchase-returns-* suites (۱۶ سوئیت).
18. **Migration:** —.
19. **Acceptance:** ‏AP control = SUM(invoice.balance) همیشه با SUM مشتق journal سازگار؛ post-only.
20. **Risks:** recompute balance در delete payment — journal reversal باید همان مبلغ اصلی را برگرداند (reference به journal اصلی).
21. **Open Questions:** —.

## 10. Milestone F — Expenses Accounting (inline)

1. **Objective:** expense journals + reversal در hard delete.
2. **Included:** create → Dr `5000`/mapped، Cr `1000|1010`؛ delete → reversal؛ mapping دسته→حساب
   (تک‌حسابی v1، فیلد mapping ساده روی CoA یا lookup — بدون جدول جدید؛ در صورت نیاز Open Question).
3. **Excluded:** expense categories سمت دیگری؛ multi-account mapping.
4. **Modules/files:** ‏`main/services/expenses.ts`.
5. **Existing SoT:** `expenses`.
6. **New SoT:** journals `source_module='expenses'`.
7. **Dependencies:** A.
8. **DB impact:** — (mapping فقط in-code در v1).
9. **API/service:** فراخوانی داخلی.
10. **Transaction/Fiscal/Idempotency/Reversal:** مانند D/E.
11. **Tests:** `accounting-expenses-integration`.
12. **Regression:** expenses-service/-routes.
13. **Acceptance:** حذف expense مانده `5000` را برمی‌گرداند؛ reversal تاریخ امروز (دوره جاری باز است).
14. **Risks:** —.
15. **Open Questions:** mapping table آیا جدول می‌خواهد (پیش‌فرض: خیر در v1).

## 11. Milestone G — COGS / Inventory Accounting (BLOCKED by default)

1. **Objective:** ‏COGS/valuation واقعی.
2. **Status:** **BLOCKED** تا evidence کامل: unit-cost snapshot روی movementها بدون نقض قانون ۴،
   رفتار WAC تاریخی، سازگاری valuation، ارزش‌گذاری برگشت خرید، ‏COGS SoT (Stage 3 §12).
3. **Included (پس از Unblock):** ‏Dr COGS/Cr `1200` در فروش؛ valuation بازنگری؛ برگشت خرید WAC-based.
4. **Excluded:** تا Unblock — هیچ.
5. **Modules:** ‏`main/services/supplies.ts` (تنها در صورت تأیید طراحی snapshot).
6. **Tests:** `accounting-cogs-integration` + بازطراحی WAC tests.
7. **Acceptance/Blockers:** بدون evidence تأییدشده اجرا نمی‌شود (قاعده ۷).

## 12. Milestone H — Reports & Reconciliation

1. **Objective:** گزارش‌های حسابداری v1 + reconcile با گزارش‌های موجود.
2. **Included:** ‏Trial Balance (شرط توازن)؛ ‏GL per account؛ ‏P&L (Revenue−Expense، برچسب «بدون
   بهای تمام‌شده»)؛ ‏Balance Sheet پایه؛ reconciliation sales/accounting؛ «Adapter Failure /
   Missing-Journal Reconciliation Report» (محاسبه mismatch از source documents و `journal_entries`؛
   derived query مطابق §7.1)؛ AR/AP reconcile (control vs sub-ledger).
3. **Excluded:** بازنویسی گزارش‌های عملیاتی موجود؛ aging (Later)؛ tax reports.
4. **Modules/files:** ‏`main/routes/accounting.ts` (گزارش‌ها)؛ خواندن از journal فقط.
5. **Existing SoT مصرفی برای reconcile:** ‏`receivable_entries` (AR)، ‏`purchase_invoices.balance`
   (AP)، ‏`financial-summary`/`daily-sales-export` (فروش)، ‏cash-closures (صندوق).
6. **Dependencies:** B, C, D, E, F.
7. **DB impact:** — (report-only).
8. **API:** ‏`GET /api/accounting/trial-balance|general-ledger|pnl|balance-sheet|reconcile` (owner/ownerManager طبق نقش‌های مالی).
9. **Tests:** `accounting-reports` (توازن، reconciling identityها با tolerance صفر).
10. **Acceptance:** Trial Balance متوازن؛ AR control = SUM(sub-ledger)؛ P&L با financial-summary
    هم‌خوان (در حد تعاریف مستند).
11. **Risks:** اختلاف تعریف فروش گزارش موجود (paid_at-based) با journal (issue-date-based) — در
    reconcile به‌صورت ستون تفکیک مستند می‌شود، نه تغییر گزارش.

## 13. Milestone I — UI / Accounting Operations

1. **Objective:** UI حداقلی v1.
2. **Included:** Chart of Accounts (list/add)؛ Journal list/detail (+reversal action)؛ Manual Journal
   form؛ Opening Balance form؛ accounting reports؛ نمایش fiscal state لازم (دوره بسته).
3. **Excluded:** aging، budget، fiscal-period CRUD UI (بعداً)، wallet، هر expansion دیگر.
4. **Modules/files:** ‏`frontend/src/app/(dashboard)/accounting/*`، کامپوننت‌های مربوط؛ i18n در
   **هر ۱۴ زبان** (قاعده پروژه)؛ نقش‌دار (owner برای manual/opening).
5. **Dependencies:** A–H API stable.
6. **Tests:** RTL suites + translations + typecheck + lint + build:frontend.
7. **Acceptance:** همه مسیرها با نقش درست؛ RTL فارسی صحیح؛ بدون کلید hardcoded.

---

## 14. Implementation Order

| Order | Milestone | بعدی بدون آن ممکن؟ | موازی‌سازی |
| --- | --- | --- | --- |
| 1 | A | خیر — همه به جدول‌های core نیاز دارند | — |
| 2 | B | بله (C–F بدون B) | می‌تواند با C موازی شود |
| 3 | C | بله | با D/E/F موازی (فایل‌های جدا) |
| 4 | D | بله | با C/E/F موازی |
| 5 | E | بله (G فقط به E) | با C/D/F موازی |
| 6 | F | بله | با C/D/E موازی |
| 7 | H | خیر برای گزارش‌های کامل | فقط پس از B–F |
| 8 | I | بله (API بدون UI کار می‌کند) | پس از H |
| — | G | — | BLOCKED؛ مستقل از C–F؛ فقط پس از evidence |

**ترتیب توصیه‌شده:** A → B → C → D → E → F → H → I؛ ‏G در هر نقطه پس از Unblock قابل درج است
(الزام: پس از E).

---

## 15. Cross-Milestone Invariants (در هر commit باید برقرار بماند)

1. `bills.ts` منطق پرداخت/تفکیک تغییر نکرده باشد (فقط فراخوانی post-commit مجاز در C).
2. Mirror Rule: هیچ charge با reference دوبار journal نشود.
3. مانده مشتق؛ هیچ stored balance/period جدید.
4. Fiscal gate روی همه insertها؛ پیام/کد 409 هماهنگ با v101.
5. Adapter هرگز سند POS را rollback نمی‌کند.
6. append-only journals؛ فقط reversal.
7. REAL واحد اصلی؛ cents فقط در مرز refunds/cash.
8. v99/v101 تست‌ها سبز بمانند.
9. Failure visibility صرفاً از log/error + derived reconciliation به دست می‌آید و اصلاح آن فقط با
   explicit reprocess operation انجام می‌شود (قاعده ۱۱ §2، §7.1).

---

## 16. Risk / Blocker Register

| Risk | Impact | Mitigation | Blocker? | Decision Needed? |
| --- | --- | --- | --- | --- |
| Opening-balance idempotency/source | مانده افتتاحیه دوبار ثبت شود | opening_balance + deterministic service-derived source_id (`openingBalanceSourceId`) + UNIQUE(source_module, source_id, seq) → 409 on duplicate | حل‌شده — پیاده‌سازی شده (opening_balance با source_id derived) | خیر |
| Adapter failure / missing journal | journal گم شود | log/error + derived reconciliation + explicit reprocess operation + idempotency (`source_module + source_id + seq`)؛ گزارش H | خیر | بله (پیش‌فرض report-only) |
| Closed-period برای adapter | journal دوران بسته | طبق blockquote §7.1: 409 → سند POS موفق می‌ماند → error/log → reconciliation journal ناموجود را پیدا می‌کند → پس از reopen، reprocess operation → journal idempotent | خیر | خیر |
| Reversal قبل از hard delete | journal یتیم | reversal همزمان در همان txn سرویس (D/E/F) | خیر | خیر |
| Sales/Receivable double-journaling | دوبار Revenue/AR | Mirror Rule + تست cross-milestone C/D | خیر | خیر |
| Bill/payment financial dates | تاریخ Revenue غلط | resolver مشترک؛ `paid_at` فقط برای وصول‌ها | خیر | خیر |
| Tax reversal | ثبت ناقص مالیات برگشتی | صریحاً خارج از v1؛ سند مستند | خیر | بعداً (spec مالیات) |
| Purchase return accounting | ارزش نادرست `1200` | مبلغ سند (OQ3)؛ WAC موضوع G | خیر | خیر (برای v1) |
| Inventory/WAC/COGS evidence | اجرای نادرست COGS | G ماندن BLOCKED | **بله برای G** | بله (evidence لازم) |
| Existing report reconciliation | عدم توازن ظاهری | ستون تفکیک issue-date vs paid-at در reconcile | خیر | خیر |
| Legacy sales core adapter (payment_details JSON) | parse شکننده | فقط قرارداد مستند فعلی + تست‌های شکل JSON | خیر | خیر |
| Migration/upgrade safety | خرابی ارتقا | append-only v102 + تست‌های الگوی v101 + backup خودکار | خیر | خیر |

---

## 17. Open Questions (بدون اختراع تصمیم جدید)

1. **Opening-balance idempotency/source** — **Resolved**: opening balances use
   `source_module='opening_balance'` with a deterministic, service-derived `source_id`
   (`openingBalanceSourceId`, a hash of the opening's lines). Clients must not supply `source_id`; a
   duplicate with identical content returns 409 via `UNIQUE(source_module, source_id, seq)`.
2. **COGS pricing evidence** — پیش‌نیاز G (unit-cost snapshot بدون نقض قانون ۴).
3. **Adapter failure reconciliation/reprocess operation** — نحوه دسترسی owner/operator به گزارش
   mismatch («Adapter Failure / Missing-Journal Reconciliation Report»، H) و اجرای دوباره
   operation پس از رفع علت خطا؛ بدون persistent state (reconciliation = derived query/report؛
   reprocess = operation)؛ تأیید در شروع C — §7.1.

---

## 18. Stage 6 Readiness Checklist

- [x] Dependencyها مشخص (§4)
- [x] Scope هر milestone مشخص (§5–§13)
- [x] Acceptance criteria قابل تست (هر milestone)
- [x] Migration strategy مشخص (v102 append-only + الگوی v101)
- [x] Regression strategy مشخص (سوئیت‌های v93–v101 + کدنویس‌شده در هر milestone)
- [x] Blocker حل‌نشده‌ای که مانع شروع A باشد وجود ندارد (تنها blocker = G، که بعد از A است)

**Stage 6 = READY** — با شروع از Milestone A، به‌محض تأیید شما.

*End of Stage 5 deliverable. No code, schema, migration, test, commit, or push was performed.*
