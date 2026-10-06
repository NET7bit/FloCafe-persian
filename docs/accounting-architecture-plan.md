# Accounting Architecture Plan (Stage 3 — Design-only)

> Status: **Stage 3 deliverable — no production code, schema, migration, test, or commit was made.**
> Basis: [accounting-current-state.md](accounting-current-state.md) (Stage 2, evidence-backed, HEAD `c8308f8`).
> Facts trace to the Stage 2 Repository Evidence Table; everything else here is an explicit
> architecture decision, labeled as such.

---

## 1. Executive Summary

Accounting v1 is a **minimal double-entry core**: a small seeded chart of accounts, an immutable
append-only `journal_entries` table with balanced debit/credit lines, **derived balances**, and
event integrations that live **inside the existing `withTxn` write paths** of the modern v93–v99
modules and — by explicit decision — an **adapter/projection for the untouched sales core**
(bills/refunds/cash-closures are not modified; see §8). Fiscal gating reuses v101's
`assertNotInClosedPeriod` unchanged. Money is stored in **main currency units as REAL** (OQ8).
COGS is **out of Accounting v1** (OQ2) — the quantity infrastructure exists but movement rows carry
no money; it is deferred to a documented follow-up. Manual journals are supported (owner-only,
balanced, fiscal-gated). Nothing existing is rewritten; reports reconcile, they do not migrate.

---

## 2. Architecture Principles

1. **Append-only truth.** Journal entries are never edited or deleted; corrections are reversals.
2. **Derived balances.** No stored account balances anywhere (matches the receivables v99 pattern).
3. **Reuse the calendar.** Fiscal membership = `assertNotInClosedPeriod` +
   `resolveDocumentBusinessDate` (v101); no new date logic, no stored period FK (one nullable
   informational column is added, see §9).
4. **Existing modules stay authoritative.** Accounting observes; it never becomes the write path
   for POS operations.
5. **One currency unit** (main units, REAL) with cents→unit conversion only at ingestion borders.
6. **No ERP.** Single level of accounts plus sub-ledgers that already exist (customers/suppliers).
7. **Scope creep = defect.** Every integration is a small, testable, reversible seam.

---

## 3. OQ1–OQ9 Decisions

| OQ | وضعیت فعلی (evidence: Stage 2 §13) | گزینه‌ها | تصمیم پیشنهادی | دلیل | اثر | ریسک مهاجرت |
| --- | --- | --- | --- | --- | --- | --- |
| **OQ1 `products.cost`** | stored column, zero backend readers (grep-verified) | a) delete b) keep unused c) wire as menu-item COGS | **b) نگه‌داری، علامت‌گذاری deprecated در doc؛ accounting استفاده نمی‌کند** | حذف ستون = migration بی‌دلیل روی داده مشتریان؛ استفاده = COGS که OQ2 آن را مردود کرد | هیچ | هیچ |
| **OQ2 COGS در v1** | qty ledgers exist (`supply_movements`, `inventory_movements`), **money-less**; WAC on `supplies.cost_price` (v97) | A) v1 بدون COGS B) v1 با COGS | **A) بدون COGS در v1** — deferred با طرح مشخص (§12) | حرکت‌ها مبلغ ندارند؛ افزودن مبلغ یعنی تغییر write-pathهای موجودی (قانون ۴/۶) و نوسان WAC تاریخی؛ P&L v1 با «نمونه حساب‌های خارج از تعادل» نمی‌سازیم. Gross margin فعلاً از گزارش موجود (`financial-summary`/`daily-sales-export`) | v1 ساده‌تر؛ پس‌روی COGS بدون بازطراحی ledger ممکن است چون mapping بعداً به همان journal اضافه می‌شود | کم — هیچ داده ایامولی لازم نیست |
| **OQ3 مبلغ Purchase Return** | return stock leaves at current WAC; return rows store `total` from invoice price | a) invoice price b) current WAC | **a) مبلغ سند برگشت (`purchase_returns.total`)** — در v1 بدون COGS فقط سند مالی معامله با تامین‌کننده journal می‌شود | مقدار بدهی معامله واقعی است؛ valuation داخلی (WAC) موضوع milestone COGS است نه بدهی | فقط Dr/Cr پرداختنی/برگشت خرید | هیچ |
| **OQ4 Cash Closure Variance** | `variance_cents` snapshot per closure | a) journal per closure b) report-only | **b) report-only در v1** | کسری/اضافه صندوق واقعی شامل تسویه‌های شیفتی است که خودشان journal دارند؛ journal دوباره رویداد می‌سازد (double count). بستن مسیر با قانون ۶ هم‌خوان است | هیچ journal | هیچ |
| **OQ5 Loyalty/Wallet** | `loyalty_ledger` two-sided, derived clamped balance | a) journal b) out of scope | **b) خارج از accounting v1** | وفاداری یه تسویه داخلی تخفیف‌گونه است؛ اثرش از قبل در `bills.total` (پس از کسر wallet) و refunds دیده می‌شود؛ حسابداری جدا آن را دو بار می‌شمارد | هیچ | هیچ |
| **OQ6 تاریخ مالی فروش** (بازنگری Stage-3.2) | `bills.created_at` (nullable paid_at) + `receivable_entries.entry_date` | a) همه‌چیز روی paid_at b) همه‌چیز روی created_at c) **تفکیک: revenue در تاریخ صدور bill، وصول‌ها در تاریخ رویداد خودشان** | **c) Revenue = تاریخ کسب‌وکار bill (`resolveDocumentBusinessDate(created_at)`)**؛ وصول‌های بعدی (پرداخت‌های دوم به بعد، settlementها) = تاریخ رویداد خودشان (`paid_at` پرداخت / `entry_date` تسویه) | تاریخ فروش ≠ تاریخ وصول؛ فروش نسیه از روز صدور در AR می‌نشیند نه از روز وصول؛ partial paymentها تاریخ وصول مستقل می‌گیرند؛ همان resolver فیسکال برای همه | revenue-journal با تاریخ صدور؛ settlement-journalها با تاریخ وصول | هیچ — فقط resolver مشترک |
| **OQ7 حرکت موجودی در دوره بسته** | no fiscal gate on movements (deliberate) | a) gate them b) no COGS→no journal c) gate when COGS lands | **b) در v1 بی‌اثر (COGS نیست)؛ در milestone COGS: gate فقط روی journal، نه روی حرکت فیزیکی** | گیت‌کردن فیزیکی موجودی، عملیات رستوران را می‌شکند و قانون ۶ را نقض می‌کند | هیچ در v1 | کم |
| **OQ8 واحد پول** | refunds/cash in cents (INTEGER), v93–v99 in REAL units | a) cents b) REAL units | **b) واحد اصلی REAL** — با قرارداد گرد کردن سمت سرویس (مثل v93+) و تبدیل واحدی cents→unit در ingestion refunds/cash | اکثریت داده مدرن REAL است؛ ledger با سرویس‌های v93 هم‌زبان می‌ماند؛ cents فقط در ۲ مرز ورودی | ستون‌های REAL | کم — فقط conversion function مشترک + تست |
| **OQ9 Sub-ledger** | receivable_entries ledger + invoice.balance stored | a) control accounts only b) control + sub-ledger detail | **b) Control accounts + sub-ledger detail از جداول موجود** (`AR_AGGREGATE` = SUM derived از receivable_entries؛ `AP_AGGREGATE` = SUM invoice.balance) — هیچ sub-ledger جدیدی ساخته نمی‌شود | هر دو side-ledger از قبل ledger-likeاند؛ حساب کل فقط مانده کل را ثابت می‌کند و reconcile می‌شود | دو حساب aggregate | هیچ |

هیچ‌کدام از تصمیم‌ها به evidence جدید نیاز نداشت؛ جایی که داده ناکافی بود، تصمیم گرفته نشد
(COGS جزئیات → milestone آینده؛ OQ4/OQ5 دوباره‌بررسی در صورت درخواست گزارش جدید).

---

## 4. Accounting Domain Model

- **Chart of Accounts:** یک سطح حساب کل (control) + دو aggregate حساب که جداول موجود را آینه
  می‌کنند. کد حساب‌ها TEXT خوانا (`1000`…)، seed نسخه‌دار (semantic id)، قابل افزودن توسط owner
  (بدون حذف حسابی که تراکنش دارد — hard block).
- **Sub-ledgers:** مشتری = `receivable_entries`؛ تامین‌کننده = `purchase_invoices`/`supplier_payments`.
  Accounting فقط control account نگه می‌دارد و reconcile-report می‌سازد (§10).
- **Journal:** یک رویداد = یک journal؛ هر journal متعلق به یک source module و source id.
- **Journal Entry:** حداقل ۲ خط، `SUM(debit) = SUM(credit)` (CHECK در سطح کل journal اعمال می‌شود —
  see §6). خطوط با حساب، جهت، مبلغ>0، توضیح اختیاری.
- **Reversal:** journal با `reverses_journal_id` — خطوط آینه، تاریخ = تاریخ reversal (نه تاریخ
  اصل)، داخل همان قیود فیسکال.

---

## 5. Chart of Accounts (seed v1 — پیشنهادی، تعداد حداقلی)

| Code | Name (fa) | Type | Normal side | تغذیه از |
| --- | --- | --- | --- | --- |
| `1000` | صندوق (Cash on hand) | Asset | Dr | bill payment lines (cash), supplier payments (cash), expenses (cash), settlements (cash), refunds (cash) |
| `1010` | بانک / کارخوان (Bank & card) | Asset | Dr | card payment lines, settlements (card), supplier payments (card) |
| `1100` | حساب‌های دریافتنی — کنترل | Asset | Dr | receivable charges (auto), sale balance if bill partially paid (adapter), refunds to customer_account (credit) |
| `1200` | موجودی کالا (Inventory — purchases holding) | Asset | Dr | Purchase journal فقط؛ **در v1 ارزش خریدهای ثبت‌شده را نگه می‌دارد و معادل ارزش‌گذاری دقیق موجودی پایان دوره یا COGS نیست — تا milestone G نباید از آن به‌عنوان inventory valuation کامل استفاده شود** |
| `2000` | حساب‌های پرداختنی — کنترل | Liability | Cr | purchase post, supplier payment, purchase return |
| `2100` | مالیات فروش وصولی | Liability | Cr | tax portion of sales; Dr on refund |

> Loyalty/Wallet accounting is deferred and is not part of Accounting v1 (OQ5) — هیچ حساب یا
> Journal wallet در v1 وجود ندارد؛ اثر wallet از قبل در `bills.total` و refunds دیده می‌شود.
| `3000` | سرمایه/افتتاحیه (Opening equity) | Equity | Cr | manual opening balance only |
| `4000` | فروش خدمات و کالا | Revenue | Cr | sale adapter (bill totals) |
| `4010` | برگشت از فروش | Revenue-contra | Dr | refund adapter |
| `4020` | تخفیف فروش | Revenue-contra | Dr | (reserved — adapter may need split) |
| `5000` | هزینه‌های عملیاتی | Expense | Dr | expenses integration (دسته→این حساب در v1 تک‌حسابی؛ تفکیک بعداً) |
| `5900` | کسری/اضافه صندوق (reserved) | Expense/Income | Dr/Cr | **خالی در v1** (OQ4) |

قواعد: حساب‌های seed حذف‌ناپذیرند؛ owner می‌تواند حساب هزینه/درآمد اضافه کند؛ mapping دسته هزینه →
حساب = یک mapping رکوردی (`expense category → account id`) که خالی است یعنی همه به `5000`.

---

## 6. Journal Model (منطقی — بدون اجرا)

**`accounting_accounts`** (پیشنهاد schema)
```
id TEXT PK (acct_…), code TEXT UNIQUE, name TEXT NOT NULL,
type TEXT CHECK IN ('asset','liability','equity','revenue','expense'),
normal_side TEXT CHECK IN ('debit','credit'),
is_system INTEGER (seed rows immutable), is_active INTEGER,
created_at, updated_at
```

**`journal_entries`** (پیشنهاد schema — append-only)
```
id TEXT PK (je_…),
entry_date TEXT NOT NULL (YYYY-MM-DD، تاریخ مالی مستند؛ ایندکس شود),
description TEXT,
source_module TEXT CHECK IN ('sales','receivables','refunds','purchases','supplier_payments',
                             'purchase_returns','expenses','manual'),
source_id TEXT NULL (bill/refund/receivable/invoice/… id؛ manual = NULL),
seq INTEGER NOT NULL DEFAULT 1 (شماره event روی یک سند: sale=1، پرداخت‌های بعدی=۲…؛ reversal ورودی = seq بعدی),
reference TEXT NULL,
status TEXT CHECK IN ('posted','reversed') DEFAULT 'posted',
reverses_journal_id TEXT NULL REFERENCES journal_entries(id),
created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL,
UNIQUE (source_module, source_id, seq) — idempotency دقیق حتی برای چند event هم‌روز روی یک سند
lines: journal_entry_lines (
  id TEXT PK, journal_id → journal_entries ON DELETE RESTRICT,
  account_id → accounting_accounts, direction CHECK IN ('debit','credit'),
  amount REAL CHECK (amount > 0), line_description TEXT
) + table-level trigger/tx check: SUM(debit)=SUM(credit) per journal
```
> **Period از `entry_date` مشتق می‌شود و به‌صورت state مستقل ذخیره نمی‌شود؛ بنابراین period
> information به‌صورت duplicated state نگهداری نمی‌شود** (بازنگری Stage-3.4؛ اصل ۲). فیلترینگ
> دوره‌ای مستقیماً روی `entry_date` (ایندکس‌شده) انجام می‌شود.

- **Balance:** مشتق — `SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END)` با جهت
  عادی حساب. هیچ stored balance (مطابق اصل ۲؛ همان الگوی v99).
- **Idempotency:** هر integration قبل از insert با `source_module+source_id(+seq)` چک می‌کند؛
  همان الگوی bill idempotent replay.
- **Currency:** همه خطوط REAL واحد اصلی؛ بدون ستون currency (تک‌ارزی — FloCafe single-currency).

---

## 7. Source-of-Truth Mapping و قاعده Anti-Double-Counting

### 7.1 اصل Canonical و قاعده Mirror

**اصل نهایی: هر accounting event فقط یک Source of Truth و دقیقاً یک Journal دارد.**

**پرداخت `customer_account` روی یک bill، هم خط `payment_details` روی bill می‌سازد و هم ردیف
`charge` در `receivable_entries` با `reference = bill_id`** (شواهد Stage 2: bills.ts batch txn؛
تست `bills-customer-account`). این دوگانگی، اگر هر دو مسیر journal بگیرند، Revenue و AR را دوبار
ثبت می‌کند. قاعده:

> **Mirror Rule — `receivable_entries` با `reference = bill_id` mirror/sub-ledger operational
> هستند و accounting integration آنها را journal نمی‌کند؛ accounting event از bill/payment
> event می‌آید.** فقط ردیف‌های بدون reference به سند دیگری (charge دستی / adjustment /
> settlement حسابی) در ماژول خودشان journal می‌گیرند.

نتیجه برای سناریوها: فروش نسیه = فقط Sale Journal (از bill؛ Dr `1100`) — ردیف charge صرفاً
sub-ledger است. تسویه بعدی = فقط Settlement Journal (از `receivable_entries.settlement`؛ ردیف
settlement هرگز reference به bill ندارد چون تسویه حسابی است نه سندبه‌سند). هیچ مسیری Revenue
یا AR را دوباره ثبت نمی‌کند.

### 7.2 جدول نهایی Event → Source → Journal → Debit → Credit → Financial Date

| رویداد | Source of Truth (تک) | Journal | seq | Debit | Credit | تاریخ مالی |
| --- | --- | --- | ---: | --- | --- | --- |
| Sale نقدی/کارت (کامل) | `bills` | Sale Journal | 1 | `1000`/`1010` = total | `4000` خالص + `2100` مالیات | تاریخ صدور bill (business date) |
| Sale نسیه (کامل) | `bills` | Sale Journal | 1 | `1100` = total | `4000` خالص + `2100` مالیات | تاریخ صدور bill |
| Sale نیمه‌نقد/نیمه‌نسیه | `bills` | Sale Journal | 1 | `1000`/`1010` سهم نقد + `1100` سهم نسیه | `4000` خالص + `2100` مالیات | تاریخ صدور bill |
| پرداخت بعدی روی bill (Collection) | payment event خودِ bill (`payment_details` jump) | Collection Journal | 2+ | `1000`/`1010` | `1100` | تاریخ payment event |
| تسویه مستقل customer account (Settlement) | `receivable_entries.settlement` | Settlement Journal | 1 هر تسویه | `1000`/`1010` به method | `1100` | `entry_date` تسویه |
| `receivable_entries.charge` با `reference=bill_id` | mirror/sub-ledger operational — **Source of Truth حسابداری نیست** | **هیچ Journal** | — | — | — | — |
| charge دستی / adjustment (بدون reference) | `receivable_entries` | Manual AR Journal | 1 | بسته به direction | — | `entry_date` |
| Refund (cash/card/customer_account) | `refunds` | Refund Journal | 1 هر refund | `4010`؛ سهم مالیات reversal: Tax reversal behavior requires final tax-accounting specification and is outside the finalized v1 detail unless already supported by existing data | `1000/1010` یا `1100` (customer_account) | `resolveDocumentBusinessDate(created_at)` refund |
| Purchase (post) | `purchase_invoices` posted | Purchase Journal | 1 | `1200` | `2000` | `invoice_date` (تاریخ post) |
| Supplier Payment | `supplier_payments` | Payment-out Journal | 1 | `2000` | `1000/1010` | `resolveDocumentBusinessDate(paid_at)` |
| Purchase Return (completed) | `purchase_returns` | Return-outward Journal | 1 | `2000` | `1200` (مبلغ سند — OQ3) | `return_date` |
| Expense | `expenses` | Expense Journal | 1 | `5000`/mapped | `1000/1010` | `expense_date` |
| Inventory/COGS | — تعلیق (OQ2، milestone G) | — | — | — | — | — |
| Cash Closure | `cash_closures` | **هیچ Journal — report-only** (OQ4) | — | — | — | `business_date` (گزارشی) |

> محدودیت `1200`: در v1 فقط holding account برای ارزش خریدهای ثبت‌شده است و نشان‌دهنده valuation
> واقعی موجودی پایان دوره یا COGS نیست؛ COGS و inventory valuation کامل به Milestone G deferred
> شده‌اند (§12).

### 7.3 تصمیم تاریخ مالی (OQ6)

> تصمیم OQ6: تاریخ Revenue برابر تاریخ صدور bill است و تاریخ Collection/Settlement برابر تاریخ
> رویداد وصول است. بنابراین `paid_at` هرگز برای تعیین تاریخ Revenue استفاده نمی‌شود. تاریخ مالی
> دقیق هر رویداد در ستون Financial Date جدول canonical §7.2 مشخص شده است.

### 7.4 مرز Collection و Settlement (صرح‌شده)

- **Collection** = پرداختی که مستقیماً روی همان bill انجام می‌شود (خطوط جدید در
  `payment_details`/jump در `paid_amount`_bill). Journal از bill (sales, billId, seq≥2).
- **Settlement** = تسویه مستقل customer-account/receivable از طریق `receivable_entries`
  (type='settlement'). Journal از همان ردیف settlement (receivables, rcvId, 1).
- هر دو AR را کاهش می‌دهند اما از **دو write-path متفاوت** می‌آیند؛ برای یک پرداخت واحد فقط
  یکی از این دو مسیر رخ می‌دهد، پس هرگز همزمان برای یک پرداخت journal نمی‌سازند (Mirror Rule
  جلوی charge را می‌گیرد؛ تسویه ذاتاً ردیف مستقل جداست).

---

## 8. Sales Integration — گزینه‌ها برای bills/refunds/cash-closures

| گزینه | شرح | مزایا | معایب | تصمیم |
| --- | --- | --- | --- | --- |
| **۱. Inline journal در write-path** | insert journal در همان `withTxn` بیلد/پرداخت | atomic تضمینی؛ بدون تأخیر | **تغییر مستقیم bills.ts** — قانون ۶ را نقض می‌کند؛ ریسک روی حساس‌ترین جریان؛ idempotency پیچیده با replay | ❌ |
| **۲. Integration adapter (out-of-band, after-commit)** | بعد از commit سند (همان caller یا event hook سبک)، integration تلاش می‌کند journal idempotent بسازد؛ در failure retry after-next write | صفر تغییر در bills/refunds؛ گیت فیسکال همان‌جا اعمال؛ crash-safe چون idempotent است | پنجره‌ی کوتاه ناهمگامی؛ نیاز به backfill/reconcile runner | ✅ **برای sales core** |
| **۳. Accounting projection (batch)** | job دوره‌ای جداول سند را می‌خواند و journal می‌سازد | ساده‌ترین | تاخیر؛ double-build risk؛ ردیابی سخت‌تر | ❌ (فقط برای backfill اولیه استفاده می‌شود) |
| **۴. Inline برای ماژول‌های v93–v99** | همان گزینه ۱ ولی روی سرویس‌های مدرن | همان atomic بودن؛ این‌ها service-layer دارند و تست‌محورند | — | ✅ **برای ماژول‌های مدرن** (receivables/purchases/expenses) |

**نتیجه:** sales/refunds = **adapter**؛ ماژول‌های مدرن = **inline در `withTxn` سرویس**. هیچ
write-pathبازطراحی نمی‌شود؛ adapter فقط بعد از commit فراخوانی می‌شود (same-process, post-commit).

---

### 8.1 مدل Partial Payment (نهایی — ابهام ۳)

**هدف:** Revenue فقط یک‌بار، AR فقط یک‌بار، settlement فقط تسویه.

سناریوی مرجع: bill ۱۰۰۰ (مالیات صفر برای سادگی)؛ امروز ۲۰۰ نقد، بقیه نسیه؛ ماه بعد ۵۰۰ تسویه
حسابی؛ سپس ۳۰۰ تسویه نهایی:

| # | رویداد واقعی | SoT | Journal (source_module, source_id, seq) | تاریخ | Dr | Cr |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | صدور bill + ۲۰۰ نقد (bill→partial) | bill | Sale (sales, billId, 1) | تاریخ صدور bill | `1000`=۲۰۰، `1100`=۸۰۰ | `4000`=۱۰۰۰ |
| 2 | تسویه ۵۰۰ (حسابی) | receivable_entries.settlement | Settlement (receivables, rcvId₁, 1) | entry_date تسویه | `1010/1000`=۵۰۰ | `1100`=۵۰۰ |
| 3 | تسویه ۳۰۰ | receivable_entries.settlement | Settlement (receivables, rcvId₂, 1) | entry_date تسویه | `1000`=۳۰۰ | `1100`=۳۰۰ |

- **Revenue یک‌بار** (journal 1). **AR یک‌بار ساخته** (خط `1100`=۸۰۰ در journal 1) و **فقط توسط
  settlementها خنثی** می‌شود (خطوط Cr `1100`). جمع `1100` پس از هر سه = صفر = مانده مشتق ledger.
- اگر به‌جای تسویه حسابی، پرداخت مستقیم روی bill (cash line) ثبت شود → journal «Sale-collection»
  (sales, billId, seq بعدی) با Dr `1000`/Cr `1100` — Mirror Rule جلوی journal شدن charge همزمان
  را می‌دهد.
- هر پرداخت جدید روی bill = seq جدید؛ replay idempotent با UNIQUE(source_module, source_id, seq).
- این مدل با رفتار واقعی کد سازگار است: `applyPaymentBatch` paid/balance را per-event آپدیت
  می‌کند و settlementها مستقل‌اند (Stage 2 §5).

---

## 9. Fiscal Period Integration

- **تاریخ journal:** `entry_date` = تاریخ مالی مستند از `resolveDocumentBusinessDate` (OQ6)؛
  هرگز datetime.
- **Resolve period:** از تاریخ — `assertNotInClosedPeriod(db, entry_date)` **قبل از هر insert
  (inline و adapter و manual و reversal)**؛ همان تابع v101، بدون تغییر.
- **فیسکال FK ندارد** (اصل ۳ — عدم تغییر مدل v101)؛ period membership همیشه از `entry_date`
  مشتق می‌شود؛ ستون اطلاعاتی حذف شد (بازنگری Stage-3.4 در §6).
- **Closed period:** هر تلاش journal در دوره بسته → **409** (همان پیام v101)؛ در inline path یعنی
  کل تراکنش سند rollback می‌شود (منسجم با gate های موجود)؛ در adapter path یعنی journal نمی‌سازد و
  در صف retry می‌ماند تا reopen (هرگز سکوت نشود؛ وضعیت در گزارش reconcile دیده می‌شود).
- **Reopen:** قفل باز می‌شود؛ adapter های pending در اولین فرصت journal می‌سازند.
- **Manual journal:** فقط `owner` (route-level) + balanced + `assertNotInClosedPeriod` + audit
  (created_by).
- **Reversal در دوره بسته:** reversal باید در **دوره جاری** ثبت شود (تاریخ reversal = امروز)، نه
  دوره سند؛ اگر امروز داخل دوره بسته‌ای باشد که بسته شده (نادر: بستن دوره جاری ممنوع است — G3)،
  همان 409 می‌دهد. پس reversal همیشه ممکن است چون دوره شامل امروز هرگز بسته نیست (استدلال F2 در
  Stage 2، اکنون تصمیم).

---

## 10. Delete / Reversal Policy (R7)

| سند | رفتار فعلی | policy accounting v1 |
| --- | --- | --- |
| `receivable_entries` | hard delete (تصمیم v99 — تغییر نمی‌کند) | integration **قبل از** delete، journal سند را با reversal خنثی می‌کند (در همان فراخوانی، بعد از commit delete؟ — نه: ترتیب = سرویس delete همانجا integration را صدا می‌زند و هر دو در یک `withTxn` می‌مانند چون ماژول مدرن است). نتیجه: ledger حذف شده ولی journal history حفظ است |
| `expenses` | hard delete | مثل بالا — reversal همزمان با delete در همان txn |
| `purchase_returns` | soft delete (`status='deleted'`) | reversal journal با `source_id` همان return؛ created_by = deleted_by |
| `purchase_invoices` cancel (draft) | status flip؛ هرگز posted نبوده | journalی وجود نداشته؛ هیچ |
| `purchase_invoices` (posted) | هیچ مسیر delete حذف نیست | اعمال نمی‌شود |
| bills (sale) | refunds فقط؛ bill حذف نمی‌شود | refund → journal جدا از adapter؛ اصلاح bill → manual correction (owner) |
| Manual journal | — | فقط با reversal؛ حذف فیزیکی ندارد |

**Correction entry:** = manual journal + `reverses_journal_id` به journal اشتباه (اگر خودی باشد)
یا مستقل (اگر crossing-system باشد).

---

## 11. Currency Decision (OQ8)

- Ledger: **REAL واحد اصلی** (مطابق v93–v99). گرد کردن: هر خط amount با `Math.round(x*100)/100`.
- مرزهای cents→unit: `refunds.amount_cents/100`، `cash_closures.*_cents/100` — در adapter.
- هیچ تبدیل ارزی وجود ندارد؛ FloCafe single-currency است (regional snapshot).

---

## 12. Inventory / COGS Decision (OQ2)

| | گزینه A — v1 بدون COGS | گزینه B — v1 با COGS |
| --- | --- | --- |
| داده موجود | qty ledgers + WAC ستون | همان |
| داده کم | **مبلغ در movement ردیف‌ها نیست**؛ recipe depletion قیمت ندارد | همان + نیاز به snapshot WAC لحاظ حرکت |
| روش محاسبه | — | لازم: افزودن unit cost snapshot به `supply_movements` یا محاسبه بازگشتی از `cost_price` تاریخچه — هر دو تغییر در مسیر موجودی |
| WAC استفاده | تعلیق | مصرف در زمان sale/depletion |
| Purchase Return valuation | مبلغ سند (OQ3) | باید تصمیم WAC-at-return بگیرد |
| ریسک | P&L ناقص (بدون بهای تمام‌شده) — کاربر با `financial-summary` جبران می‌کند | تغییر write-path موجودی (قانون ۴)، نوسان تاریخی WAC، scope بزرگ |

**تصمیم: گزینه A برای v1؛ COGS به milestone G موکول می‌شود با پیش‌نیاز صریح: evidence برای روش
pricing (WAC snapshot vs historical). اگر آن evidence تأمین نشد، COGS اجرا نمی‌شود** (به Stage 5
حمل می‌شود).

---

## 13. Reports Architecture

| گزارش | Source → Calculation | Dependency | سازگاری با گزارش فعلی |
| --- | --- | --- | --- |
| Trial Balance | accounts ← SUM(direction) per account | جدید، فقط از journal | — (جدید؛ جایگزین هیچ‌چیز) |
| General Ledger (per account) | journal lines by account | جدید | — |
| Account Statement | sub-ledger مستقیم (`receivable_entries`) یا control SUM | جدید + موجود | **دقیقاً همان خروجی `/receivables/statement`** — reconcile می‌شود |
| P&L | revenue − expense accounts (بدون COGS در v1) | جدید | باید با `financial-summary`/`daily-sales-export` هم‌خوان شود (tolerance صفر) |
| Balance Sheet | assets − liabilities + equity (v1: بدون inventory تا COGS) | جدید | با cash-closures reconcile |

هیچ گزارش فعلی بازنویسی/حذف نمی‌شود (اصل ۴). reconcile report اولین خروجی مشترک است.

---

## 14. Migration Strategy (طرح — بدون اجرا)

- **v102 `add_accounting_core`** (پیشنهاد): `accounting_accounts` + `journal_entries` +
  `journal_entry_lines` + ایندکس‌ها؛ **seed chart** داخل همان migration (idempotent با
  `INSERT OR IGNORE` روی code).
- بدون ALTER روی جداول موجود؛ بدون backfill (v1 از لحظه فعال‌سازی جلو می‌رود؛ opening balance با
  manual journal توسط owner).
- تست‌های migration طبق الگوی v101 (TARGET_VERSION dynamic, v101→v102 upgrade, idempotent re-run).

---

## 15. Backward Compatibility

- بدون ستون جدید روی جداول موجود؛ هیچ service امضای شکسته؛ adapter ها پس از commit مستقل.
- اگر accounting integration fail شود (به جز closed-period)، عملیات POS اصلی **باید موفق بماند**
  (log + retry) — ترتیب "money first" حفظ است؛ فقط inline path های ماژول‌های مدرن (که همین امروز
  گیت فیسکال دارند) transaction واحد می‌مانند.
- گزارش‌های فعلی دست‌نخورده.

---

## 16. Scope Boundaries

**خارج از design:** multi-branch، multi-warehouse، payroll، consolidation، multi-currency،
tax-engine جدید، budgeting، cost centers، ERP account trees، depreciation، AR/AP aging.

**نباید بازطراحی شوند:** bills/refunds/cash-closures write paths؛ receivable_entries semantics؛
v101 fiscal model؛ MIGRATIONS append-only؛ `applySupplyStockChange`؛ گزارش‌های فعلی؛ `ROLE_ACCESS`.

---

## 17. Decision Matrix (نهایی)

| موضوع | واقعیت فعلی | گزینه‌ها | تصمیم پیشنهادی | دلیل | اثر DB | اثر Backend | اثر UI | ریسک مهاجرت |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chart of Accounts | هیچ | flat / ERP tree / dynamic-only | **flat seed ۱۲ حسابی + افزودن owner** | حداقل کافی؛ ERP ممنوع | جدول جدید | service | صفحه CoA بعداً (Stage 5-I) | کم |
| Journal | هیچ | per-event inline / adapter / projection | **مدرن=inline، sales=adapter** | قانون ۶ + atomicity ماژول‌های مدرن | جدول جدید | integration seams | — | کم |
| Journal Entries | هیچ | editable / append-only | **append-only + reversal** | auditability | جدول جدید | — | — | کم |
| Account Balance | هیچ | stored / derived | **derived** | اصل ۲، الگوی v99 | هیچ | SUM queries | — | هیچ |
| Customer Sub-ledger | receivable_entries | new table / use existing | **use existing + control `1100`** | sub-ledger از قبل ledger است | هیچ | reconcile query | موجود | هیچ |
| Supplier Sub-ledger | invoice.balance stored | new ledger / use existing | **use existing + control `2000`** | همان | هیچ | reconcile query | — | کم (recompute موجود) |
| Sales Integration | bills untouched | inline / adapter / projection | **adapter post-commit idempotent؛ Sale journal در تاریخ صدور، collectionها seq≥2** (بازنگری Stage-3.2/3) | قانون ۶ + OQ6-c + §8.1 | هیچ روی bills | adapter + retry | — | متوسط (idempotency باید محکم تست شود) |
| Payments Integration | JSON lines روی bill | parse adapter / جدول payments | **parse در adapter** (جدول payments ممنوع) | قاعده پروژه | هیچ | parse util | — | متوسط (JSON شکل legacy) |
| Receivables | ledger مشتق | reuse / duplicate | **reuse، inline journal در create** | همان بافت txn | هیچ | ۲ فراخوانی | موجود | کم |
| Purchases | post lifecycle | inline | **inline در post** | همان بافت | هیچ | ۱ فراخوانی | — | کم |
| Supplier Payments | بافت txn | inline | **inline** | همان | هیچ | ۱ فراخوانی | — | کم |
| Purchase Returns | soft delete | inline + reversal | **inline + reversal در delete** | R7 | هیچ | ۲ فراخوانی | — | کم |
| Expenses | hard delete | inline + reversal | **inline + reversal در delete** | R7 | هیچ | ۲ فراخوانی | — | کم |
| Inventory / COGS | money-less ledgers | v1 without / with | **بدون COGS در v1** (OQ2) | scope + قانون ۴ | هیچ | هیچ در v1 | — | به milestone G |
| Cash Closure | snapshot cents | journal / report-only | **report-only** (OQ4) | double-count risk | هیچ | هیچ | — | هیچ |
| Refunds | cents rows | adapter | **adapter + cents→unit** | قانون ۶ + OQ8 | هیچ | adapter | — | متوسط |
| Fiscal Period | v101 gates | extend model / reuse resolver | **reuse resolver، بدون FK و بدون ستون اطلاعاتی** (بازنگری Stage-3.4) | اصل ۲+۳ — state تکراری ممنوع | هیچ | تماس با همان تابع | — | هیچ |
| Anti-Double-Counting (Mirror Rule) | charge همزمان با bill payment ثبت می‌شود (Stage 2 §5) | journal هر دو /Mirror Rule | **Mirror Rule — sub-ledger با reference هرگز journal نمی‌گیرد** | جلوگیری قطعی از دوبار Revenue/AR (§7.1) | هیچ | شرط reference در integrationها | — | کم |
| Currency | دوگانه cents/REAL | cents / REAL | **REAL واحد اصلی** (OQ8) | هم‌زبانی با v93+ | — | conversion utils | — | کم |
| Delete/Reversal | R7 risks | rebuild / reversal | **reversal-only** | اصل ۱ | هیچ | integration در delete paths | — | کم |
| Existing Reports | document-readers | rewrite / reconcile | **reconcile-only** | اصل ۴ | هیچ | گزارش جدید جدا | صفحه جدید جدا | هیچ |

---

## 18. Remaining Open Questions

1. **COGS pricing evidence** (پیش‌نیاز milestone G): آیا `unit_cost` snapshot روی
   `supply_movements` قابل افزودن است بدون نقض قانون ۴؟ (طرح در Stage 5 تعیین می‌شود)
2. **Adapter retry UX:** آیا وضعیت pending journalها برای owner نمایش داده شود؟ (پیشنهاد: فقط
   گزارش reconcile در v1)
3. **Opening balance wizard:** manual journal ساده کافی است یا UI لازم است؟ (Stage 5-I)

---

## 19. Stage 3 Final Validation

- [x] جدول canonical Event→Source→Journal→Debit→Credit→Financial Date فقط یک بار در §7.2 وجود دارد؛ §7.3 جدول ندارد
- [x] هیچ duplicate section/table باقی نمانده
- [x] هر accounting event فقط یک Source of Truth دارد (§7.2؛ Sale فقط `bills`)
- [x] هر accounting event فقط یک Journal دارد (§7.1، §7.2)
- [x] Mirror Rule با Source of Truth تناقض ندارد — charge با reference mirror است، نه Source (§7.1)
- [x] Collection و Settlement کاملاً متمایزند — دو write-path، هرگز همزمان (§7.4، §8.1)
- [x] هیچ ستون یا state تکراری برای period ذخیره نمی‌شود — period فقط از `entry_date` مشتق است (§6، §9)
- [x] هیچ حساب wallet و هیچ ردیف/mapping آن در Accounting v1 وجود ندارد (§5، OQ5)
- [x] Revenue date و Collection/Settlement dates مشخص هستند (§7.2 ستون Financial Date؛ §7.3 خلاصه)
- [x] Refund tax wording بدون عبارت مبهم — tax reversal خارج از v1 مشخصات (§7.2)
- [x] محدودیت `1200` و COGS کاملاً مشخص است (§5، §7.2، §12)
- [x] هیچ production/schema/migration/test/refactor/commit/push تغییر نکرده است

---

*End of Stage 3 deliverable. No code, schema, migration, test, commit, or push was performed.*
