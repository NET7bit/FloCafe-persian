# Payroll Accounting

FloCafe payroll is a manual, accrual-based module. Each payroll employee is linked to a customer account used for point-of-sale purchases; creating an employee creates a customer record unless the manager selects an existing customer. The migration links existing payroll employees to new customer records without merging them with similarly named customers; a payroll manager can then link an existing customer from the employee list. Employees do not need a POS login. Earnings and manual deductions are entered by an authorized user. The module does not calculate tax, insurance, attendance, or statutory entitlements.

## Workflow

1. Create or deactivate payroll employees in **Payroll → Employees**. Employee records are deactivated rather than deleted so posted payroll history remains available.
2. Ring employee purchases to the linked customer using the existing `customer_account` tender. Those charges appear in the customer's receivable statement.
3. Create a draft run with a period and at least one active employee. Enter one or more earning and manual deduction components through `POST /api/payroll/runs`. The draft snapshots positive receivable balance through the period end and deducts no more than the employee's net pay after manual deductions. Drafts can be edited until posted.
4. Post the run. The posting date is the period end. A closed fiscal period blocks posting. The purchase deduction settles the customer's receivable and reduces payroll payable; any balance above net pay remains due on the customer account. Posting is rejected if the customer's current balance has fallen below the draft's captured deduction.
5. Record employee payments separately against the remaining cash payable after the purchase deduction. Partial payments are allowed; the service rejects payments above the remaining balance.
6. Record withholding remittances separately against the manual deductions payable. Reversing a payroll run adds a compensating customer-ledger entry for any purchase deduction and retains the original receivable event.

All writes record the authenticated actor. Monetary fields use the application's standard major currency units and two-decimal rounding.

## Ledger mapping

| Event | Debit | Credit |
| --- | --- | --- |
| Payroll accrual | 5010 Salaries and Wages — gross | 2010 Payroll Payable — net; 2020 Payroll Withholdings Payable — deductions |
| Employee purchase deduction | 2010 Payroll Payable | 1100 Accounts Receivable |
| Reversal of employee purchase deduction | 1100 Accounts Receivable | 2010 Payroll Payable |
| Employee payment | 2010 Payroll Payable | 1000 Cash or 1010 Bank and Card Clearing |
| Withholding remittance | 2020 Payroll Withholdings Payable | 1000 Cash or 1010 Bank and Card Clearing |

Each source event is projected once into the append-only journal using `source_module='payroll'`. A failed projection remains discoverable through `GET /api/accounting/payroll/unresolved` and can be reprocessed by an accounting manager. Payroll accruals are included in the accounting reconciliation report on account 5010. Corrections use reversal journals; journal rows are not edited or deleted.

## Access and boundaries

`payroll.view` and `payroll.manage` are separate permissions, owner-only by default, and configurable. Payroll endpoints live under `/api/payroll`; ledger recovery endpoints live under `/api/accounting/payroll`. Payroll employees are separate from staff login accounts.

The module does not infer a country's labor, tax, insurance, or payroll rules. It does not create payment transactions with a bank or cash drawer; payment records and their ledger projections are accounting records. Time tracking, production payroll, and payroll exports are outside the current implementation.
