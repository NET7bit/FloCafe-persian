# Accounting Current-State Report (Stage 2 — Inspect-only)

> Status: **Stage 2 deliverable — no code, schema, migration, or test was changed.**
> Scope: FloCafe-persian, branch `main`, HEAD `c8308f8` (Stage 1 hardening).
> Source of truth: **the repository itself**. Where docs and code disagree, code wins and the
> discrepancy is noted. Every finding below is backed by the Repository Evidence Table (§13).

---

## 1. Executive Summary

- FloCafe (single-branch, single-stock, offline-first desktop POS) already stores **every financial
  event needed for a future double-entry ledger**, but has **no accounting model**: there is no
  chart of accounts, no journal, no stored account balances. All money today lives in
  module-local documents and ledgers.
- The money surfaces split into two generations:
  - **Legacy sales core** (v1-era, integer-IDs): `orders → order_items → bills` with
    `paid_amount / balance / payment_status / payment_details` **stored on the bill**, cash
    sessions/closures with cent-based amounts, refunds in `amount_cents`.
  - **Modern financial modules** (v93–v101, string-IDs, service-layered): suppliers,
    purchase invoices (draft→posted lifecycle), supplier payments, purchase returns (soft delete),
    expenses, receivable ledger, fiscal periods — all `withTxn`-wrapped, all with closed-period
    gates where in scope.
- **Balances are mostly derived by design** (receivable balances, customer wallet, supplier
  payable), with exactly two intentional stored-balance exceptions: `bills.paid_amount/balance`
  and `supplies.cost_price` (WAC) — both documented decisions.
- The v101 fiscal-period gate is live on the five modern modules; the sales core (bills/refunds/
  cash-closures) is **deliberately outside** fiscal scope (documented decision), which is the
  single most important constraint for accounting integration.
- Two duplication risks exist (bill paid/balance vs. `payment_details` JSON; product `cost` vs.
  supplies WAC) and two medium gaps (products `cost` unused in code, wallet refund gate on split
  children) — all recorded with evidence, none blocking.

---

## 2. Current Financial Modules

| Module | Version introduced | Service layer | Routes | Write transaction | Fiscal gate (v101) |
| --- | --- | --- | --- | --- | --- |
| Orders / Order items | v1 | no (route-embedded SQL) | `main/routes/orders.ts` | yes (`withTxn`) | no (out of scope) |
| Bills + payments | v1 / extended | `applyPaymentBatch` inside bills routes | `main/routes/bills.ts` | yes (`withTxn`, batch) | no (out of scope) |
| Refunds | v1+ | `main/services/refund.ts` | `main/routes/refunds.ts` | yes (`withTxn`) | no (out of scope) |
| Cash sessions / closures | v90 / v81 | route-embedded | `main/routes/cash-sessions.ts`, `cash-closures.ts` | yes (`withTxn`, SELECT-then-INSERT idempotency) | no (out of scope) |
| Suppliers | v93 | `main/services/suppliers.ts` | `main/routes/suppliers.ts` | yes | n/a (master data) |
| Purchase invoices | v94 | `main/services/purchase-invoices.ts` | `main/routes/purchase-invoices.ts` | yes | yes (post/cancel) |
| Supplier payments | v95 | `main/services/supplier-payments.ts` | `main/routes/supplier-payments.ts` | yes | yes (create/delete) |
| Purchase returns | v96 | `main/services/purchase-returns.ts` | `main/routes/purchase-returns.ts` | yes | yes (create/delete) |
| Expenses | v98 | `main/services/expenses.ts` | `main/routes/expenses.ts` | yes | yes (create/delete) |
| Receivables ledger | v99 | `main/services/receivables.ts` | `main/routes/receivables.ts` | yes | yes (create/delete) |
| Fiscal periods | v101 | `main/services/fiscal-periods.ts` | `main/routes/fiscal-periods.ts` | yes | n/a (is the gate) |
| Inventory (products) | v76-era | `main/services/inventory.ts` | `main/routes/inventory.ts` | yes | no |
| Supplies + WAC | v76 / v97 | `main/services/supplies.ts` | `main/routes/supplies.ts` | yes | no |
| Recipes / depletion | v88/v89 | `main/services/recipes.ts` | `main/routes/recipes.ts` | yes | no |

Roles: money writes are `ownerManager` (modern modules), `ownerManagerCashier` (sales/day-to-day),
`owner` (financial-summary, daily export, fiscal reopen). See §13 permission rows.

---

## 3. Database/Schema Map

All schema lives in `main/db.ts` (ideal schema + `MIGRATIONS` chain, currently v1…v101, 101
entries + seed; no separate migration files). Creation lines (current HEAD):

| Table | Created | PK (type) | Money/date fields | Status fields | Key relations |
| --- | --- | --- | --- | --- | --- |
| `orders` | db.ts:5770 | `id` INTEGER AUTOINC | `total`, `subtotal`, `tax_amount`, `discount_amount`, `created_at`, `completed_at` | `status` ('pending'…) | `customer_id`→customers (no FK), `user_id`→users |
| `order_items` | db.ts:5807 | `id` INTEGER AUTOINC | `unit_price`, `total`, `tax_amount`, `discount_amount` | `status` ('refunded', 'void_adjustment'…) | `order_id`→orders |
| `bills` | db.ts:5834 | `id` INTEGER AUTOINC | `total`, `paid_amount`, `balance`, `paid_at`, `payment_details` (JSON) | `payment_status` ('unpaid','partial','paid','refunded','partially_refunded') | `order_id`→orders, `customer_id` (no FK) |
| `refunds` | db.ts:4700 | `id` INTEGER AUTOINC | `amount_cents` INTEGER, `created_at` | — | `bill_id`→bills, `order_item_id`, `approved_by`/`created_by`→users |
| `cash_sessions` | db.ts:5165 | `id` INTEGER AUTOINC | `opening_float_cents`, `opened_at`, `closed_at` | `status` ('open','closed') | `closure_id`→cash_closures |
| `cash_closures` | db.ts:4810 | `id` INTEGER AUTOINC | `*_cents` (5), `business_date`, `period_start/end`, `z_number` UNIQUE | — | `closed_by`→users |
| `customers` | db.ts:5734 | `id` TEXT | — (no balance columns) | `is_active` | referenced by orders/bills/receivables |
| `receivable_entries` | db.ts:5446 | `id` TEXT (`rcv_`) | `amount`>0, `entry_date` | `entry_type`+`direction` CHECKed | `customer_id`→customers |
| `purchase_invoices` | db.ts:5252 | `id` TEXT (`pinv_`) | `total`, `paid_amount`, `balance` (stored), `invoice_date`, `due_date` | `status` ('draft','posted','partially_paid','paid','cancelled') | `supplier_id`→suppliers |
| `purchase_invoice_items` | db.ts:5276 | `id` TEXT | `unit_price`, `quantity`, `unit` | — | →invoice, `supply_id`→supplies |
| `supplier_payments` | db.ts:5305 | `id` TEXT | `amount`, `paid_at` (date or datetime) | — | `supplier_id`, optional `purchase_invoice_id` |
| `purchase_returns` | db.ts:5329 | `id` TEXT | `total`, `return_date` | `status` ('completed','deleted') + `deleted_at/by/reason` | →invoice, `supplier_id` |
| `expenses` | db.ts:5423 | `id` TEXT | `amount`, `expense_date`, `payment_method` | — | `created_by`→users |
| `products` | db.ts:5625 | `id` TEXT | `price` (sale), `cost` (legacy, unused), `stock_quantity` | `is_active` | `inventory_product_id` link |
| `inventory_movements` | db.ts:4922 | `id` INTEGER | `quantity_delta`, `stock_after`, `created_at` | `movement_type` ('sale','cancel_restore','adjustment') | `product_id` |
| `supplies` | db.ts:5090 | `id` TEXT | `stock_quantity`, **`cost_price`** (WAC, v97) | `is_active`, `deleted_at` | — |
| `supply_movements` | db.ts:5104 | `id` INTEGER | `quantity_delta`, `unit`, `stock_after`, `created_at` | `movement_type` ('receive','count','adjustment','waste','recipe_depletion','recipe_restore') | `supply_id` |
| `recipes` / `recipe_items` | db.ts:5124 / 5135 | TEXT | `quantity`, `unit` per item; `yield_quantity` | `is_active` | →products, →supplies |
| `loyalty_ledger` | db.ts:5863 | `id` INTEGER | `amount`, `type` ('credit'/'debit'), `expires_at` | — | `customer_id`, `bill_id` |
| `fiscal_periods` | db.ts:5475 | `id` TEXT (`fp_`) | `start_date`, `end_date`, `closed_at` | `status` ('open','closed'), type CHECK | `closed_by`/`reopened_by`→users |

Migration chain: single `MIGRATIONS` array in db.ts, append-only enforced by convention and tests
(`test:upgrade-path`, `test:schema-health`); latest = v101 `add_fiscal_periods` (db.ts:5471).

---

## 4. Source-of-Truth Matrix

| Concept | Source of truth | Stored/derived | Notes |
| --- | --- | --- | --- |
| Sale amount | `bills.total` (+ `orders.total` mirror) | stored (×2) | order totals mirror bill fields at generate time; see R1 |
| Sale payment state | `bills.paid_amount`/`balance`/`payment_status` + `payment_details` JSON | **stored, then derived JSON** | paid/balance updated in the same UPDATE that appends `payment_details`; split checks read paid/status per child bill |
| Refund | `refunds.amount_cents` (append-only rows) | stored (ledger-like) | bill `payment_status` flips to refunded/partially_refunded |
| Cash on hand | `cash_closures` (`expected/counted/variance_cents`) | stored snapshot per closure | sessions track open/close only |
| Receivable balance | `SUM(debit) − SUM(credit)` over `receivable_entries` | **derived** | `listCustomerBalances`/`getCustomerBalance`; no stored balance anywhere |
| Customer wallet (loyalty) | `SUM(credit) − SUM(debit)` over `loyalty_ledger` | derived (clamped ≥0 in list) | `MAX(0, credits-debits)` in customers route |
| Supplier payable | implicit: `purchase_invoices.balance` (stored per invoice) | stored per-invoice; **no supplier-level balance** | module-level total = SUM(invoice.balance) for non-cancelled |
| Purchase invoice state | `purchase_invoices.status/paid_amount/balance` | stored, recomputed by payments/returns | recompute logic in supplier-payments service |
| Expense | `expenses.amount` (append-only + hard delete) | stored | no account mapping |
| Product stock | `products.stock_quantity` + `inventory_movements` (movement rows) | stored current + ledger | deduction path in orders/inventory service |
| Supply stock | `supplies.stock_quantity` + `supply_movements` | stored current + ledger | **all writes via `applySupplyStockChange`** (single choke point) |
| Supply cost | `supplies.cost_price` (v97 WAC) | **stored** (recomputed weighted average at each priced inflow) | documented v97 decision; backfilled from purchase history |
| Product cost | `products.cost` column | **stored but dead** — no reads found in backend code | see R3/OQ1 |
| Recipe depletion | `recipes`/`recipe_items` + `supply_movements(type='recipe_depletion')` | ledger | depletion at order time; no monetary posting |
| Fiscal lock | `fiscal_periods` (window rows) + `assertNotInClosedPeriod` | derived membership | no per-document FK |
| Cash drawer movement | `cash_drawer_movements` (v80) | ledger | pulse events |

---

## 5. Financial Events Matrix (analysis only — no implementation)

| Event | Source | Amount | Date | Counterparty | وضعیت فعلی | اثر حسابداری پیشنهادی اولیه (فقط تحلیل) |
| --- | --- | --- | --- | --- | --- | --- |
| Sale | `bills` (+ items via order) | `bills.total` | `paid_at` (دقیق‌ترین) یا `created_at` | customer (nullable) | stored paid/balance روی bill | Dr دریافت‌ها/بانک/حساب مشتری، Cr فروش + Cr مالیات — لازم: تفکیک مالیات از `tax_amount` |
| Cash payment (bill) | خطوط `payment_details` با method 'cash' | مبلغ خط | `paid_at` | — | بخشی از batch پرداخت bill | Dr صندوق، Cr دریافتنی — نیاز به تصمیم: آیا سطح event = خط پرداخت است |
| Card/wallet/customer_account lines | همان `payment_details` | مبلغ خط | `paid_at` | customer (wallet/customer_account) | بدون جدول عمومی payments | Cr به‌تفکیک وسیله پرداخت — به `payment_details` JSON وابسته است |
| Customer credit (charge) | `receivable_entries(type=charge)` | `amount` | `entry_date` | customer | ledger موجود، گیت فیسکال دارد | Dr حساب مشتری، Cr فروش نسیه — منبع: همین ledger |
| Customer settlement | `receivable_entries(type=settlement)` | `amount` | `entry_date` | customer | ledger + payment_method اجباری | Dr صندوق/بانک، Cr حساب مشتری |
| Refund | `refunds.amount_cents` | amount_cents | `created_at` | customer (غیرمستقیم) | append-only + bill status | Dr برگشت فروش (+Cr صندوق یا Cr حساب مشتری برای customer_account) — به cents |
| Purchase (post) | `purchase_invoices` posted | `total` (+ items) | `invoice_date` | supplier | گیت فیسکال دارد | Dr موجودی/هزینه، Cr پرداختنی — snap زمان post |
| Supplier payment | `supplier_payments` | `amount` | `paid_at` (date یا datetime) | supplier | گیت دارد؛ balance فاکتور recompute | Dr پرداختنی، Cr صندوق/بانک |
| Purchase return | `purchase_returns` (completed؛ soft delete) | `total` | `return_date` | supplier | گیت دارد؛ stock برمی‌گردد با WAC جاری | Dr پرداختنی، Cr موجودی/برگشت خرید — تنش با WAC ثبت‌شده قبلی (OQ3) |
| Expense | `expenses` | `amount` | `expense_date` | — | گیت دارد؛ category آزاد | Dr هزینه، Cr صندوق/بانک — نگاشت دسته→حساب لازم |
| Cash closure | `cash_closures` | `variance_cents` و جمع‌ها | `business_date`/`period_start..end` | — | snapshot؛ Z یونیک | Dr/Cr کسری/اضافه صندوق — گزارشی؛ آیا journal لازم؟ (OQ4) |
| Inventory movement (product) | `inventory_movements` | quantity فقط؛ **مبلغ ندارد** | `created_at` | — | ledger مقداری | اگر COGS v1 خواسته شود باید مقدار×قیمت شود (OQ2) |
| Supply movement | `supply_movements` | quantity + unit؛ **مبلغ ندارد** (اما `cost_price` روی supply) | `created_at` | — | ledger مقداری + WAC ستون | منبع COGS مواد برای آینده |
| Recipe depletion | `supply_movements(type='recipe_depletion')` | quantity | `created_at` | — | هنگام فروش کم می‌شود | منبع COGS سطح آیتم منو |
| Loyalty credit/debit | `loyalty_ledger` | `amount` | `created_at` | customer | derived wallet | Cr/Cr داخلی وفاداری — احتمالاً خارج v1 (OQ5) |

---

## 6. Existing Balance/Ledger Analysis

**Ledger-like (append-only rows) موجود:**

1. `receivable_entries` — v99، دوطرفه (debit/credit) با CHECK ساختاری؛ نزدیک‌ترین چیز به journal
   در سیستم؛ مانده مشتق.
2. `refunds` — append-only (حذف ندارد).
3. `supply_movements` / `inventory_movements` — مقداری با `stock_after`؛ **مبلغ ندارند**.
4. `loyalty_ledger` — دوطرفه ('credit'/'debit').
5. `cash_drawer_movements` (v80) — رویداد کشوی پول.

**Stored balances (عمدی/مستند):**

- `bills.paid_amount/balance` — تصمیم تاریخی سیستم؛ در همان UPDATE با `payment_details` به‌روز
  می‌شود (بills.ts:2022) → ناسازگاری عملی ریسک پایین.
- `purchase_invoices.balance` — recompute از SUM پرداخت‌ها (v95 تصمیم).
- `supplies.cost_price` — WAC v97.

**Derived balances:** receivable، wallet، supplier-total (پروجکشن).

**Duplicated-state risks:**

- **R1** — `orders.total/subtotal/tax_amount` آینه‌ی bill است (در generate نوشته می‌شود). دو نسخه
  می‌تواند واگرا شود (addons بعدی، void adjustments). accounting باید فقط از **bill** بخواند.
- **R2** — `payment_details` (JSON آرایه خطوط پرداخت روی bill) تنها منبع تفکیک وسیله پرداخت است؛
  **جدول عمومی payments وجود ندارد** (بررسی شد؛ مطابق قاعده‌ی پروژه ساخته نشده). هر accounting
  integration باید این JSON را parse کند؛ در related bill updates همیشه همزمان به‌روز می‌شود، ولی
  parsing-dependency یک ریسک ساختاری است.
- **R3** — `products.cost` (legacy) هیچ خواننده‌ای در بک‌اند ندارد؛ هزینه‌ی واقعی مواد
  `supplies.cost_price` (v97 WAC) است. دو مفهوم "cost" موازی — یکی مرده. accounting نباید از
  `products.cost` استفاده کند بدون تصمیم.
- **R4** — `paid_at` nullable است تا اولین پرداخت؛ "تاریخ فروش" بین `created_at` (bill) و
  `paid_at` تفکیک معنایی دارد (accrual vs cash) — تصمیم حسابداری لازم (OQ6).

---

## 7. Fiscal Period Compatibility (v101)

| Event source | Gate امروز | وضعیت |
| --- | --- | --- |
| receivable_entries (create/delete) | ✅ دارد (`assertNotInClosedPeriod`) | آماده |
| expenses (create/delete) | ✅ دارد | آماده |
| supplier_payments (create/delete) | ✅ دارد (`paid_at→fiscalDateForInstant`) | آماده |
| purchase_invoices post/cancel | ✅ دارد (`invoice_date`) | آماده |
| purchase_invoices **draft create/update** | ❌ عمداً آزاد (تصمیم Stage-1 ماتریس، تست `fiscal-hardening`) | در scope بسته بودن post کافی است؛ accounting باید مثل post رفتار کند نه draft |
| purchase_returns (create/delete) | ✅ دارد (`return_date`) | آماده |
| bills (generate/payment/split) | ❌ ندارد — **عمدی** (قانون ۶ پروژه) | نباید در v1 تغییر کند |
| refunds | ❌ ندارد — عمدی | نباید در v1 تغییر کند |
| cash_closures | ❌ ندارد — عمدی؛ خودش `business_date` آینده‌نگر را 409 می‌کند | نباید در v1 تغییر کند |
| inventory/supply movements | ❌ ندارد | حرکت موجودی در دوره بسته ممکن است — برای accounting فقط اثر پولی مهم است؛ تصمیم آینده (OQ7) |
| fiscal reopen | owner+PIN+rate-limit | — |

**قاعده کلیدی برای accounting:** هر journal که از این رویدادها ساخته شود باید از **همان
`assertNotInClosedPeriod`** با **همان تاریخ مالی** (`resolveDocumentBusinessDate`) استفاده کند تا
regime واحد بماند؛ و این مشمول قانون «bills را تغییر نده» است — یعنی journal فروش یا در
write-path bills گره می‌خورد (نیازمند تصمیم صریح) یا فقط از snapshotهای تمیز تغذیه می‌شود.

---

## 8. Existing Reports (financial)

| Report | Route | Source of truth مصرفی | Balance محاسبه می‌کند؟ | قابل استفاده برای accounting؟ | حفظ/جایگزینی |
| --- | --- | --- | --- | --- | --- |
| daily-stats | `/reports/daily-stats` | bills.paid_at ± refunds | جمع جریان نقدی روز | به‌عنوان cross-check | حفظ |
| summary | `/reports/summary` | orders/bills | — | خیر (عملیاتی) | حفظ |
| **financial-summary** | `/reports/financial-summary` (owner) | bills+refunds+**expenses** (COALESCE جمع‌ها) | بله — quasi-P&L | **بله — نزدیک‌ترین گزارش به P&L**؛ باید با ledger آینده reconcile شود | حفظ؛ بعداً با ledger تطبیق |
| sales / topProducts / recentOrders / insights | `/reports/*` | orders/items | — | خیر | حفظ |
| x-report / z-report | `/reports/x-report`, `/z-report` | cash_closures + session | بله (صندوق) | برای درست بودن صندوق | حفظ |
| daily-sales/export | `/reports/daily-sales/export` (owner) | bills+items+refunds | هویت‌های reconciliation مستند (`docs/daily-sales-export.md`) | **بله — قرارداد حسابداری فروش موجود**؛ accounting باید با آن هم‌خوان باشد | حفظ |
| cash-closures list/detail | `/cash-closures` | cash_closures | بله | منبع درست بودن نقد | حفظ |
| receivables balances/summary/statement | `/receivables/*` | receivable_entries | بله (مشتق) | **مستقیم قابل استفاده** — ledger همان منبع journal آینده است | حفظ |

هیچ گزارش موجود به "accounts" فکر نمی‌کند؛ همه مستقیم از جداول سند می‌خوانند. accounting v1 باید
این گزارش‌ها را بازنویسی نکند — فقط باید بتواند با آن‌ها **reconcile** شود.

---

## 9. Integration Points (نیاز ثبت‌شده — نه طراحی)

قالب خواسته‌شده: `Existing Module → Source of Truth → Accounting Event → Fiscal Date → Required Journal (تحلیل اولیه)`

1. `bills + payment_details → bills.paid_amount/total/paid_at → Sale (per bill) → paid_at یا created_at (تصمیم OQ6) → Dr دریافتنی/صندوق به‌تفکیک خط، Cr فروش/مالیات`
2. `receivable_entries → charge/settlement rows → Charge / Settlement → entry_date → Dr/Cr حساب مشتری`
3. `refunds → amount_cents/method → Refund → created_at → Dr برگشت فروش، Cr صندوق|حساب مشتری`
4. `purchase_invoices (post) → total/items → Purchase → invoice_date → Dr موجودی/هزینه، Cr پرداختنی`
5. `supplier_payments → amount/paid_at → Supplier Payment → paid_at → Dr پرداختنی، Cr صندوق/بانک`
6. `purchase_returns (completed) → total/return_date → Purchase Return → return_date → Dr پرداختنی، Cr موجودی/برگشت خرید`
7. `expenses → amount/category/expense_date → Expense → expense_date → Dr هزینه، Cr صندوق/بانک`
8. `supply_movements (+cost_price) → qty×WAC → Inventory/COGS (مشروط به OQ2) → created_at → Dr COGS، Cr موجودی`
9. `inventory_movements → qty (بدون مبلغ) → (فقط اگر OQ2 حل شود) → created_at → —`
10. `cash_closures → variance/business_date → Cash over/short (اختیاری، OQ4) → business_date → Dr/Cr کسری صندوق`

هیچ‌کدام از این‌ها طراحی یا ایجاد نشده؛ فقط نقشه نیاز integration است.

---

## 10. Risks / Inconsistencies

- **R1** (بالا) — آینه‌ی orders↔bills؛ accounting باید تک‌منبع: bill.
- **R2** — پرداخت‌ها فقط در JSON روی bill؛ نقد و غیرنقد فقط با parse تفکیک می‌شوند.
- **R3** — `products.cost` مرده ولی موجود؛ سوءاستفاده آینده محتمل اگر مستند نشود.
- **R5** — واحدهای پول دوگانه: `refunds`/`cash_*` به **cents (INTEGER)**، ماژول‌های v93–v99 به
  **REAL واحد اصلی**. هر ledger آینده باید قرارداد واحد صریح انتخاب کند.
- **R6** — `paid_at`/`invoice_date`/`entry_date`/`expense_date` قراردادهای تاریخ ناهمگن (datetime
  nullable vs date)؛ `resolveDocumentBusinessDate` باید تنها نقطه نرمال‌سازی باشد.
- **R7** — حذف فیزیکیِ expenses و receivable_entries یعنی تاریخچه‌ی قابل journal شدن حذف می‌شود؛
  اگر journal منتشرشده باشد، حذف سندِ دوره باز باید journal معکوس بسازد یا منع شود (تصمیم آینده).
- **R8** — wallet refund gate (split children) — TODO مستقل موجود؛ به accounting ربط مستقیم ندارد
  ولی در همان مسیر refund است.

---

## 11. Open Architectural Questions (برای Stage 3)

1. **OQ1 — تکلیف `products.cost`:** حذف/نگه‌داری/استفاده؟ (الان dead است)
2. **OQ2 — COGS در v1؟** زیرساخت مقداری آماده است (`supply_movements` + WAC) ولی مبالغ در
   movementها نیست؛ inventory_movements هیچ مبلغی ندارد. اگر v1 بدون COGS باشد، P&L ناقص می‌شود
   (فروش بدون بهای تمام‌شده).
3. **OQ3 — برگشت خرید و WAC:** `cost_price` فعلی با میانگین جاری کم می‌شود؛ journal برگشت باید با
   چه مبلغی ثبت شود (WAC لحظه برگشت یا مبلغ فاکتور اصلی)؟
4. **OQ4 — cash closure variance:** آیا رویداد حسابداری است یا صرفاً گزارشی؟
5. **OQ5 — loyalty/wallet:** در v1 حسابداری شود یا مستثنا؟
6. **OQ6 — تاریخ فروش:** `created_at` (accrual-like) یا `paid_at` (cash-like)؟ و برای نسیه
   صریحاً `receivable_entries.entry_date`؟ (پیشنهاد: event-date = تاریخ مالی مستند، همان
   `resolveDocumentBusinessDate`.)
7. **OQ7 — حرکت موجودی در دوره بسته:** gate ندارند؛ اگر COGS journal بسازد، نیاز به تصمیم دارد.
8. **OQ8 — واحد پول ledger آینده:** cents (مطابق cash/refunds) یا واحد اصلی (مطابق v93+)؟
9. **OQ9 — حساب مشتری/تامین‌کننده به‌صورت sub-ledger یا control account؟** (receivable_entries و
   purchase_invoices.balance هر دو amاده‌ی نقش sub-ledger هستند.)

---

## 12. چیزهایی که نباید در Accounting تغییر کنند

1. `bills/refunds/cash-closures` write-paths و schema (قانون ۶) — accounting فقط مصرف‌کننده.
2. `receivable_entries` به‌عنوان ledger با مانده مشتق + hard delete (تصمیم v99).
3. `fiscal_periods` v101 — schema، گیت‌ها، reopen owner+PIN (تازه hardening شده `c8308f8`).
4. `MIGRATIONS` append-only؛ هیچ migration قبلی.
5. `applySupplyStockChange` به‌عنوان تنها مسیر stock و WAC v97.
6. جداول عمومی payments ساخته نشود (تصمیم پروژه) — payment_details منبع می‌ماند.
7. orders به‌عنوان آینه‌ی bill بازطراحی نشود.
8. بدون multi-branch / multi-warehouse / جدول accounts موازی با products/supplies.
9. گزارش‌های موجود بازنویسی نشوند (فقط reconcile).
10. قرارداد نقش‌ها (ownerManager برای ماژول مالی جدید) و `ROLE_ACCESS` دست‌نخورده.

---

## 13. Repository Evidence Table

| Area | Finding | Repository Evidence | Evidence Type | Exact Location | Confidence |
| --- | --- | --- | --- | --- | --- |
| Sales (orders) | order totals mirror bill fields; status lifecycle | `orders` columns `total/subtotal/tax_amount/status/created_at/completed_at` | schema | `main/db.ts:5770-5805` | High |
| Sales (order_items) | per-item money + refund/void statuses + recipe snapshot | `order_items` columns incl. `status`, `recipe_snapshot` (v89) | schema | `main/db.ts:5807-5832`, migration v89 `main/db.ts:5145-5149` | High |
| Sales (bills) | stored paid/balance + JSON payment lines; single UPDATE writes both | `UPDATE bills SET paid_amount…payment_details…` in applyPaymentBatch | service | `main/routes/bills.ts:2022`, schema `main/db.ts:5834-5861` | High |
| Payments | no generic payments table (by design); methods cash/card/wallet/customer_account internal | `PAYMENT_METHODS`/`preparePaymentBatch` in bills routes; no `CREATE TABLE payments` | route/schema | `main/routes/bills.ts:1686-1831` (gate at 1824-1831), db.ts (absence verified by grep) | High |
| Payments (cash gate) | cash tender requires an open cash session | `requireOpenSessionForCashTender` + `isCashTender` | service | `main/services/shift-session-gate.ts:42-72` | High |
| Refunds | append-only cent amounts, dual attribution, idempotency | `refunds` table + `refund_idempotency`; `createRefund` in `withTxn` | schema/transaction | `main/db.ts:4700-4730`, `main/routes/refunds.ts:113`, `main/services/refund.ts:77` | High |
| Cash closures | cent-based snapshot, business-date uniqueness, SELECT-then-INSERT | `cash_closures` columns; uniqueness comment; closure insert in txn | schema/transaction | `main/db.ts:4810-4838`, `main/routes/cash-closures.ts:23,164,775` | High |
| Cash sessions | open/closed lifecycle gating cash tenders | `cash_sessions` table | schema | `main/db.ts:5165-5180` | High |
| Receivables | ledger with derived balances; CHECK-structured; hard delete | `receivable_entries` CHECKs; `listCustomerBalances` derived SUM; `deleteReceivableEntry` | schema/service | `main/db.ts:5446-5467`, `main/services/receivables.ts:116-129,312-323` | High |
| Customer account (neesie) | bill payment posts charge in same txn; refund posts credit | `applyPaymentBatch` charge insert; refund credit path | service | `main/routes/bills.ts` (charge insert in batch txn), `main/services/refund.ts:241-255` | High |
| Purchases (invoices) | draft→posted lifecycle; stored balance recomputed; stock only via post | statuses CHECK; `postPurchaseInvoice` uses `applySupplyStockChange`; gates at post/cancel | schema/service | `main/db.ts:5252-5275`, `main/services/purchase-invoices.ts:332-393` | High |
| Suppliers (payments) | payments recompute invoice balance; fiscal gate on paid_at | `createSupplierPayment`/`deleteSupplierPayment` + gate | service | `main/services/supplier-payments.ts:196-260` (gate 207, 247) | High |
| Purchase returns | soft delete with audit columns; stock restore via WAC choke point | `purchase_returns` status/deleted_*; `deletePurchaseReturn` | schema/service | `main/db.ts:5329-5350`, `main/services/purchase-returns.ts:352-400` | High |
| Suppliers | master data, soft delete, no supplier-level stored balance | `suppliers` service; grep payable/balance → none | service | `main/services/suppliers.ts:197-213` (absence verified) | High |
| Expenses | append + hard delete; free-form category; fiscal gate | `expenses` table; gate lines; `withTxn` | schema/service | `main/db.ts:5423-5440`, `main/services/expenses.ts:220,232,250-252` | High |
| Inventory (products) | stock current + quantity-only movements (no money) | `products.cost/stock_quantity`; `inventory_movements` money-less | schema | `main/db.ts:5625-5650 (price/cost/stock)`, `main/db.ts:4922-4945` | High |
| Inventory (supplies) | single choke point for stock; WAC `cost_price` v97 | `applySupplyStockChange` with `unitCost`; migration v97 guard | service/migration | `main/services/supplies.ts:219-260`, migration v97 `main/db.ts:5382-5416` | High |
| Recipes / raw materials | recipe depletion via supply movements; no monetary posting | `recipes`/`recipe_items`; movement type 'recipe_depletion' | schema | `main/db.ts:5124-5153`, `main/db.ts:5104-5117` | High |
| Cost calculation | WAC stored on supplies; product `cost` has no backend readers | v97 backfill posted-only; grep `products.cost` readers → none | migration/other | `main/db.ts:5382-5416` (backfill SQL), absence verified by grep in `main/**` | High |
| Fiscal periods | month/year lock windows, CHECKs, UNIQUE, derived membership | `fiscal_periods` DDL; `assertNotInClosedPeriod` | schema/service | `main/db.ts:5475-5493`, `main/services/fiscal-periods.ts:96-108` | High |
| Fiscal write gates | 11 gate sites across 5 modules; sales core excluded | grep of `assertNotInClosedPeriod` sites | service | `main/services/receivables.ts:258,321`, `expenses.ts:220,252`, `supplier-payments.ts:207,247`, `purchase-invoices.ts:349,387`, `purchase-returns.ts:252,368` | High |
| Business date / timezone | single calendar primitive used by closures/reports/fiscal | `dayBoundsInTimezone`/`localDateInTimezone`/`tenantBusinessDayStartTime` + `business_day_start_time` seed | configuration | `main/db.ts:340-344,6571-6610,6202` | High |
| Permissions | fixed roles; owner-only financial summary/export/reopen | `ROLE_ACCESS` + route usages counts | permission | `shared/role-permissions.ts:25-31`, `main/routes/reports.ts:204,774`, `main/routes/fiscal-periods.ts` (reopen owner) | High |
| Existing reports | all read documents directly; financial-summary is quasi-P&L; daily export contract | route list; financial-summary SQL; export doc | report | `main/routes/reports.ts:99-780`, `docs/daily-sales-export.md` | High |
| Migration chain | single append-only MIGRATIONS, v1…v101, upgrade-path/schema-health tests | `MIGRATIONS` array; tests | migration/test | `main/db.ts:3009-3012 (registry header), 5471 (v101)`, `tests/upgrade-path.test.ts`, `tests/schema-health.test.ts` | High |
| Transaction patterns | every financial write wrapped in `withTxn`; SELECT-then-INSERT idempotency idiom | `withTxn` sites; closure comment | transaction | `main/routes/cash-closures.ts:775,857-861`, `main/routes/bills.ts:2077,2108`, `main/routes/refunds.ts:113` | High |
| Loyalty (wallet) | two-sided ledger, derived clamped balance | `loyalty_ledger`; `MAX(0, credits-debits)` | schema/route | `main/db.ts:5863-5870`, `main/routes/customers.ts:157` | High |

---

## 14. Cross-check Notes

- بررسی‌ها با grep مستقیم روی HEAD (`c8308f8`) انجام شد؛ هیچ یافته‌ای صرفاً از naming حدس زده
  نشده است. موارد بدون شواهد صریح به‌عنوان OQ ثبت شدند (OQ1, OQ2, OQ4, OQ5).
- تناقض documentation/code دیده‌نشده؛ `docs/daily-sales-export.md` با کد سازگار بود (هویت‌های
  reconciliation مستند و اجرا در `test:daily-sales-export`).
- Evidence coverage: تمام ۲۴ مورد الزامی §Required Evidence Coverage پوشش داده شد (جدول §13).
