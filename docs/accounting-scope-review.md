# Accounting Scope Review (Stage 4)

> Status: **Stage 4 deliverable — no production code, schema, migration, test, or commit was made.**
> Basis: [accounting-architecture-plan.md](accounting-architecture-plan.md) (Stage 3, Integrity Check **PASS**)
> و [accounting-current-state.md](accounting-current-state.md) (Stage 2).
> Rule: هر قابلیت دقیقاً در یک ستون است (v1 / بعداً / خارج از scope) — هیچ قابلیت مبهمی بین سطوح
> تقسیم نمی‌شود. «بعداً» همیشه milestone یا پیش‌نیاز مشخص دارد؛ «خارج از scope» دلیل قطعی دارد.

---

## 1. Boundary Statement

**Accounting v1 = حداقل سیستم دوطرفه کارکردی:** Chart of Accounts ثابت + journal append-only +
مشتق‌گیری مانده + integration پنج ماژول مدرن (inline) و هسته فروش (adapter) + manual journal
(owner) + Trial Balance/GL/P&L پایه + fiscal gate بازاستفاده‌شده از v101.

**Accounting v1 نیست:** COGS/valuation، حسابداری wallet، cash-variance journal، aging،
multi-anything، tax engine جدید.

---

## 2. Scope Matrix (ماتریس اصلی)

| قابلیت | v1 | بعداً | خارج از scope | دلیل و شرط مرزی |
| --- | :-: | :-: | :-: | --- |
| Chart of Accounts | ✅ | — | — | flat seed ۱۲ حسابی (بدون `2050`) + افزودن حساب توسط owner؛ حذف حساب تراکنش‌دار ممنوع |
| General Ledger (journal feed per account) | ✅ | — | — | مستقیم از `journal_entries`؛ report-only |
| Trial Balance | ✅ | — | — | SUM direction per account؛ شرط PASS: جمع Dr = جمع Cr |
| P&L | ✅ (فقط Revenue و Expense) | ✅ کامل با COGS | — | **v1 فقط بر اساس Revenue و Expense قابل ارائه است؛ بدون COGS هیچ ادعای Gross Profit یا سود کامل واقعی معتبر نیست** — نسخه کامل در milestone G (نمای P&L v1 برچسب صریح «بدون بهای تمام‌شده» دارد) |
| Balance Sheet | ✅ پایه | ✅ کامل | — | v1 با `1200` فقط وضعیت پایه است و **inventory valuation کامل محسوب نمی‌شود**؛ COGS و inventory valuation کامل همچنان Later (milestone G) هستند |
| Manual Journal | ✅ | — | — | فقط owner + balanced + fiscal gate + reversal-only correction |
| Sales Accounting (bills → journal) | ✅ | — | — | adapter post-commit؛ Sale journal در تاریخ صدور + Collection (seq≥2)؛ **هیچ تغییری در bills.ts write-path** |
| Payments Accounting (خطوط `payment_details`) | ✅ | — | — | parse در adapter؛ جدول عمومی payments ساخته نمی‌شود |
| Receivables Accounting | ✅ | — | — | inline در سرویس v99؛ Mirror Rule: charge با reference هیچ journal نمی‌گیرد |
| Purchases Accounting | ✅ | — | — | inline در post (v94)؛ draft هیچ journal ندارد |
| Supplier Accounting | ✅ | — | — | inline در v95؛ AP control = SUM invoice.balance |
| Expenses Accounting | ✅ | — | — | inline در v98 + reversal همزمان با hard delete؛ mapping دسته→حساب تک‌حسابی در v1 |
| Purchase Returns Accounting | ✅ | — | — | inline در v96 + reversal در soft delete؛ مبلغ = سند برگشت (OQ3) |
| Inventory / COGS | — | ✅ milestone G | — | پیش‌نیاز صریح: evidence برای unit-cost snapshot بدون نقض قانون ۴؛ بدون آن اجرا نمی‌شود |
| Tax — posting مستقیم در v1 | ✅ | — | — | فقط **استفاده از `bill.tax_amount` موجود در Sales Journal** (خط Cr `2100`) — بدون ساخت Tax Engine جدید و بدون هیچ قانون محاسبه مالیات جدید؛ دقیقاً مطابق architecture plan §7.2 |
| Tax — قوانین، engine و tax reversal کامل | — | ✅ | — | نیازمند مشخصات نهایی حسابداری مالیات؛ در v1 ثبت نمی‌شود (بند Refund)؛ tax engine جدید در هیچ مرحله‌ای ساخته نمی‌شود |
| Refund Accounting | ✅ | — | — | adapter روی `refunds`؛ سهم مالیات reversal تا مشخصات نهایی tax در v1 ثبت نمی‌شود |
| Cash Closure Journal | — | — | ✅ | journal ثبت نمی‌کند (OQ4)؛ در صورت تغییر تصمیم، تصمیم معماری جدید لازم است |
| Cash Closure reports / reconciliation | ✅ (حفظ موجود) | — | — | گزارش‌های فعلی حفظ می‌شوند؛ **حذف journal به معنی حذف یا نادیده‌گرفتن داده‌های cash closure نیست**؛ و هیچ مسیر دیگری نباید cash closure را غیرمستقیم به accounting event تبدیل کند |
| Loyalty/Wallet Accounting | — | — | ✅ | OQ5؛ اثرش از قبل در `bills.total`/refunds دیده می‌شود؛ حساب/journal/mapping wallet وجود ندارد |
| Fiscal Periods | ✅ (مصرف) | — | — | فقط بازاستفاده از `assertNotInClosedPeriod`/`resolveDocumentBusinessDate`؛ مدل v101 تغییر نمی‌کند |
| Fiscal UI (بستن/بازکردن دوره) | — | ✅ milestone I | — | API آماده است؛ v1 بدون UI |
| Multi-branch | — | — | ✅ | تک‌شعبه قطعی پروژه |
| Multi-warehouse | — | — | ✅ | تک‌انبار قطعی پروژه |
| Payroll | — | — | ✅ | خارج از دامنه POS رستوران در این نقشه |
| Consolidation / multi-entity | — | — | ✅ | — |
| Multi-currency | — | — | ✅ | FloCafe single-currency (regional snapshot) |
| ERP account trees / cost centers / budgeting | — | — | ✅ | نقض اصل «no ERP» |
| Depreciation / fixed assets | — | — | ✅ | — |
| AR/AP aging | — | ✅ | — | داده sub-ledger آماده است؛ گزارش بعداً |
| Opening balance wizard UI | — | ✅ milestone I | — | v1: manual journal کافی |

**قاعده حل ابهام:** اگر قابلیتی فقط با تغییر write-path موجود ممکن باشد → یا «خارج از scope» است
یا milestone با پیش‌نیاز evidence. اگر دو ستون plausible بود → پیش‌فرض «بعداً» است مگر v1 بدون آن
ناقص عملیاتی شود (مانند P&L که بدون COGS هم منتشر می‌شود ولی نسخه کاملش «بعداً» است).

---

## 3. چیزهایی که Accounting v1 تغییر نمی‌دهد (مناطق ممنوعه)

1. `bills.ts` write-paths (generate/payment/split-check/refund routes) — فقط adapter پس از commit
2. `receivable_entries` semantics: ledger مشتق + hard delete + Mirror Rule
3. مدل v101 fiscal periods و گیت‌های ۱۱‌گانه + hardening `c8308f8`
4. `MIGRATIONS` — فقط append v102
5. `applySupplyStockChange` و WAC v97
6. ساختن جدول عمومی `payments`
7. آینه `orders`↔`bills`
8. گزارش‌های موجود (`reports.ts`, `daily-sales-export`, cash-closures) — فقط reconcile
9. `ROLE_ACCESS` و نقش‌ها (ownerManager برای ماژول مالی جدید، owner برای manual journal)
10. قرارداد واحد پول (REAL) و گرد کردن سرویس‌محور

---

## 4. Acceptance-Driven Boundary Checks (برای Stage 5/6)

هر آیتم v1 در Stage 5 باید بتواند این چهار سؤال را با «بله» جواب دهد؛ وگرنه از scope خارج می‌شود:

1. آیا بدون تغییر write-pathهای ممنوعه (بند ۳) قابل پیاده‌سازی است؟
2. آیا بدون state تکراری (stored balance/period) ممکن است؟
3. آیا با اصول Stage 3 (append-only، derived، یک SoT) سازگار است؟
4. آیا تست‌پذیر با الگوهای موجود (service/routes/migration/upgrade) است؟

**نتیجه برای موارد مرزی:**

- Tax reversal کامل → سؤال ۳ شکست می‌خورد (spec نهایی ندارد) → «بعداً»؛ Sales/Refund journals در v1 فقط tax amount موجود در سند را منتقل می‌کنند
- Cash variance journal → قاعده double-count می‌شکند → «خارج از scope»
- Wallet journal → اصل one-event-one-journal می‌شکند → «خارج از scope»
- COGS → سؤال ۱ (تغییر supply movement path) → «بعداً» با پیش‌نیاز
- **P&L v1** → فقط Revenue/Expense؛ label «بدون بهای تمام‌شده» اجباری؛ ادعای Gross Profit ممنوع
- **Balance Sheet v1** → پایه با `1200` به‌عنوان holding؛ ادعای full inventory valuation ممنوع
- **Opening Balance** → در v1 فقط با Manual Journal (balanced + fiscal-gated)؛ Wizard UI «بعداً» (milestone I)؛ شناسه/idempotency سند افتتاحیه → Open Question (§6)

---

## 5. خروجی Stage 4

- ماتریس بالا (۱۵ قابلیت الزامی prompt + ۱۴ مورد مکمل) — هر قابلیت دقیقاً یک ستون
- مناطق ممنوعه §3 — مرزهای ثابت برای Stage 5 و 6
- چارچوب Acceptance §4 — فیلتر scope-creep در طول milestoneها

---

## 6. Pass-forward to Stage 5

Stage 5 (Milestone Plan) فقط از قابلیت‌های ستون **v1** ماتریس §2 — گروه‌بندی‌شده بر اساس
ماژول‌ها و dependencyهای واقعی (Core ledger → Manual Journal → Sales/Refunds → Receivables →
Purchases/Suppliers → Expenses → Reports) — و ترتیب A–I prompt اصلی milestone می‌سازد؛ هیچ عدد
شمارشی ملاک scope نیست. آیتم‌های «بعداً» به‌صورت milestone G/H/I با پیش‌نیاز صریح می‌آیند.
آیتم‌های «خارج از scope» در هیچ milestone ظاهر نمی‌شوند.

### Open Questions باقی‌مانده (فقط ثبت — بدون طراحی schema)

1. **Opening-balance idempotency/source:** آیا manual journal افتتاحیه `source_module='manual'`
   با `source_id` قراردادی می‌گیرد یا یک نشانه صریح opening می‌خواهد؟ (تصمیم در Stage 5-A)
2. **COGS pricing evidence** (از Stage 3، پیش‌نیاز milestone G)
3. **Adapter retry UX** (از Stage 3؛ پیشنهاد: فقط reconcile report در v1)

*End of Stage 4 deliverable. No code, schema, migration, test, commit, or push was performed.*
