/**
 * COGS accounting adapter (Milestone G): a post-commit projection of supply
 * consumption into the ledger.
 *
 * Cost is frozen on `supply_movements` (migration v104): a priced inflow
 * freezes its purchase price per base unit, every other movement freezes the
 * moving weighted average at that moment, and `total_cost` is signed
 * (`unit_cost × quantity_delta`). An order item's consumption value is the
 * negated sum of the frozen movements that reference it, so the projection is
 * always derived from `supply_movements` — the static `products.cost` column is
 * never read (supply/recipe scope only, no FIFO, no multi-warehouse).
 *
 * Trigger (Option B): COGS is recognized at financial sale recognition — the
 * first payment batch that produces a sale journal (Milestone C). An unpaid
 * sale carries no COGS, and a movement written before migration v104 has no
 * frozen cost, so untouched history is excluded by construction (no backfill).
 *
 * Identity is per `order_item` under the core contract (`source_module =
 * 'cogs'`, `source_id` = order item id, `seq`), so a split bill allocates
 * nothing extra and reversal/re-recognition extend the same event chain:
 * recognition is seq max+1 with no active journal, reversal is the shared core
 * (seq max+1, status flipped). Every projection function is idempotent on its
 * own identity, and failures (closed fiscal period, data gap) are logged and
 * left to reconciliation — the source transaction is never rolled back.
 *
 * Reversal policy:
 * - Item-level refund → reversal of the frozen original COGS (goods returned).
 * - Item cancel that restores inventory → reversal; `void` (no restore) → none.
 * - Item restore that re-consumes inventory → recognition again at seq max+1.
 * - Bill-level refund → no reversal (left to reconciliation).
 */
import { getDatabase, now, withTxn } from '../db';
import { createJournal, getAccountByCode, JournalRecord, reverseJournal } from './accounting';
import { fiscalDateForInstant } from './fiscal-periods';

type Database = ReturnType<typeof getDatabase>;

/** Single ownership point for the COGS account; report classifiers reuse it instead of re-hardcoding. */
export const COGS_ACCOUNT_CODE = '5100';
const INVENTORY_ACCOUNT_CODE = '1200';

interface OrderItemRow { id: number; order_id: string; status: string | null; }

function fail(scope: string, error: unknown): null {
  console.error(`[Accounting] ${scope} failed; left to reconciliation:`, error);
  return null;
}

/**
 * Net frozen consumption value for one order item: depletions are negative
 * `total_cost`, restores positive, so negating the sum yields the cost of the
 * supplies currently consumed. Pre-migration movements are NULL and ignored.
 */
function itemConsumptionCost(db: Database, orderItemId: string | number): number {
  const idText = String(orderItemId);
  const row = db.prepare(`
    SELECT COALESCE(SUM(total_cost), 0) AS net_cost
    FROM supply_movements
    WHERE reference_type = 'order_item'
      AND (reference_id = ? OR reference_id GLOB ?)
  `).get(idText, `${idText}:*`) as { net_cost: number | null } | undefined;
  const net = Number(row?.net_cost ?? 0);
  if (!Number.isFinite(net)) return 0;
  const consumed = Number((-net).toFixed(8));
  return Math.abs(consumed) < 1e-9 ? 0 : consumed;
}

/** The bill that carries this order item AND already has a sale journal. */
function coveringBill(db: Database, orderId: string, orderItemId: string | number): { id: string; created_at: string } | undefined {
  return db.prepare(`
    SELECT b.id, b.created_at
    FROM bills b
    JOIN journal_entries j ON j.source_module = 'sales' AND j.source_id = b.id AND j.seq = 1
    WHERE b.order_id = ?
      AND (
        (b.split_group_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM bill_items bi WHERE bi.bill_id = b.id AND bi.order_item_id = ?
        ))
        OR b.split_group_id IS NULL
      )
    ORDER BY b.created_at, b.id
    LIMIT 1
  `).get(orderId, orderItemId) as { id: string; created_at: string } | undefined;
}

function activeItemJournal(db: Database, orderItemId: string | number): JournalRecord | undefined {
  return db.prepare(
    "SELECT * FROM journal_entries WHERE source_module = 'cogs' AND source_id = ? AND status = 'posted' AND reverses_journal_id IS NULL ORDER BY seq DESC LIMIT 1",
  ).get(String(orderItemId)) as JournalRecord | undefined;
}

function latestItemJournal(db: Database, orderItemId: string | number): JournalRecord | undefined {
  return db.prepare(
    "SELECT * FROM journal_entries WHERE source_module = 'cogs' AND source_id = ? ORDER BY seq DESC LIMIT 1",
  ).get(String(orderItemId)) as JournalRecord | undefined;
}

function nextCogsSeq(db: Database, orderItemId: string | number): number {
  const row = db.prepare(
    "SELECT MAX(seq) AS m FROM journal_entries WHERE source_module = 'cogs' AND source_id = ?",
  ).get(String(orderItemId)) as { m: number | null };
  return (row.m ?? 0) + 1;
}

/**
 * Reverses one order item's active COGS journal through the shared core;
 * returns null (logged) when there is nothing to reverse.
 */
function reverseItemCogsJournal(orderItemId: string | number, actorUserId: string, entryDate: string): JournalRecord | null {
  try {
    const db = getDatabase();
    const journal = activeItemJournal(db, orderItemId);
    if (!journal) return null;
    return reverseJournal(journal.id, actorUserId, entryDate);
  } catch (error) {
    return fail(`COGS reversal for order item ${orderItemId}`, error);
  }
}

/**
 * Recognition journal for one order item: `Dr 5100 COGS` / `Cr 1200 Inventory`
 * for the frozen consumption value, seq max+1, dated by the covering bill (or
 * the supplied override). Returns the existing active journal when already
 * recognized, and null when the sale is not yet recognized or nothing was
 * consumed from supply stock.
 */
export function createItemCogsJournal(
  orderItemId: string | number,
  actorUserId: string,
  entryDateOverride?: string,
): JournalRecord | null {
  try {
    const db = getDatabase();
    const item = db.prepare('SELECT id, order_id, status FROM order_items WHERE id = ?').get(orderItemId) as OrderItemRow | undefined;
    if (!item) return null;
    const existing = activeItemJournal(db, item.id);
    if (existing) return existing;
    const bill = coveringBill(db, item.order_id, item.id);
    if (!bill) return null;
    const amount = itemConsumptionCost(db, item.id);
    if (amount <= 0) return null;
    const entryDate = entryDateOverride || fiscalDateForInstant(bill.created_at);
    const seq = nextCogsSeq(db, item.id);
    return withTxn(() => createJournal({
      entryDate,
      description: `COGS item ${item.id}`,
      sourceModule: 'cogs',
      sourceId: String(item.id),
      seq,
      reference: String(bill.id),
      actorUserId,
      lines: [
        { accountId: getAccountByCode(COGS_ACCOUNT_CODE).id, direction: 'debit', amount, lineDescription: 'cost of goods sold' },
        { accountId: getAccountByCode(INVENTORY_ACCOUNT_CODE).id, direction: 'credit', amount, lineDescription: 'inventory consumed' },
      ],
    }));
  } catch (error) {
    return fail(`COGS journal for order item ${orderItemId}`, error);
  }
}

/** Post-commit hook for a bill payment batch: recognizes COGS for each item on the bill. Never throws. */
export function recordBillCogsAccounting(billId: string | number | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (billId === undefined || billId === null || actorUserId === undefined || actorUserId === null) return;
    const db = getDatabase();
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
    if (!bill) return;
    // COGS follows the sale journal: no recognition before the sale is posted.
    const saleJournal = db.prepare(
      "SELECT id FROM journal_entries WHERE source_module = 'sales' AND source_id = ? AND seq = 1",
    ).get(String(bill.id));
    if (!saleJournal) return;
    const items = bill.split_group_id
      ? db.prepare('SELECT order_item_id AS id FROM bill_items WHERE bill_id = ?').all(bill.id) as Array<{ id: number }>
      : db.prepare('SELECT id FROM order_items WHERE order_id = ?').all(bill.order_id) as Array<{ id: number }>;
    for (const item of items) {
      createItemCogsJournal(item.id, actorUserId);
    }
  } catch (error) {
    console.error('[Accounting] bill COGS accounting failed:', error);
  }
}

/** Post-commit hook for an item-level refund: reverses the frozen original COGS. Bill-level refunds stay unresolved. */
export function recordRefundCogsAccounting(refundId: string | number | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (refundId === undefined || refundId === null || actorUserId === undefined || actorUserId === null) return;
    const db = getDatabase();
    const refund = db.prepare('SELECT id, order_item_id, created_at FROM refunds WHERE id = ?').get(refundId) as
      | { id: number; order_item_id: number | null; created_at: string }
      | undefined;
    if (!refund || refund.order_item_id === null || refund.order_item_id === undefined) return;
    const entryDate = refund.created_at ? fiscalDateForInstant(refund.created_at) : fiscalDateForInstant(now());
    reverseItemCogsJournal(refund.order_item_id, actorUserId, entryDate);
  } catch (error) {
    console.error('[Accounting] refund COGS accounting failed:', error);
  }
}

/** Post-commit hook for an item cancel that restores inventory: reverses the item's COGS. Never throws. */
export function recordItemCancelCogsAccounting(orderItemId: string | number | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (orderItemId === undefined || orderItemId === null || actorUserId === undefined || actorUserId === null) return;
    reverseItemCogsJournal(orderItemId, actorUserId, fiscalDateForInstant(now()));
  } catch (error) {
    console.error('[Accounting] item cancel COGS accounting failed:', error);
  }
}

/** Post-commit hook for an order cancel that restores inventory: reverses every active item COGS. Never throws. */
export function recordOrderCancelCogsAccounting(orderId: string | number | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (orderId === undefined || orderId === null || actorUserId === undefined || actorUserId === null) return;
    const db = getDatabase();
    const items = db.prepare('SELECT id FROM order_items WHERE order_id = ?').all(orderId) as Array<{ id: number }>;
    const entryDate = fiscalDateForInstant(now());
    for (const item of items) {
      reverseItemCogsJournal(item.id, actorUserId, entryDate);
    }
  } catch (error) {
    console.error('[Accounting] order cancel COGS accounting failed:', error);
  }
}

/** Post-commit hook for an item restore that re-consumes inventory: recognizes COGS again at seq max+1. */
export function recordItemRestoreCogsAccounting(orderItemId: string | number | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (orderItemId === undefined || orderItemId === null || actorUserId === undefined || actorUserId === null) return;
    createItemCogsJournal(orderItemId, actorUserId);
  } catch (error) {
    console.error('[Accounting] item restore COGS accounting failed:', error);
  }
}

export type UnresolvedCogsState = 'missing_journal' | 'missing_reversal';

export interface UnresolvedCogsEvent {
  event_id: string;
  state: UnresolvedCogsState;
  order_id: string | null;
  order_item_status: string | null;
  /** Frozen consumption value (missing_journal) or journal debit total (missing_reversal). */
  amount: number | null;
}

export type CogsReprocessStatus =
  | 'recognized'
  | 'already_recognized'
  | 'reversal_created'
  | 'already_reversed'
  | 'nothing_to_do';

export interface CogsReprocessResult {
  order_item_id: string;
  status: CogsReprocessStatus;
  journal_id?: string;
}

/**
 * Read-only discovery of unresolved G events, derived from state: consumed
 * order items whose sale is recognized but carry no COGS journal, and active
 * COGS journals for refunded items that were never reversed. Never mutates.
 */
export function listUnresolvedCogsEvents(): UnresolvedCogsEvent[] {
  const db = getDatabase();
  const missingJournals = db.prepare(`
    SELECT oi.id AS order_item_id, oi.order_id, oi.status
    FROM order_items oi
    WHERE EXISTS (
      SELECT 1 FROM bills b
      JOIN journal_entries j ON j.source_module = 'sales' AND j.source_id = b.id AND j.seq = 1
      WHERE b.order_id = oi.order_id
        AND (
          (b.split_group_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM bill_items bi WHERE bi.bill_id = b.id AND bi.order_item_id = oi.id
          ))
          OR b.split_group_id IS NULL
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM journal_entries c
      WHERE c.source_module = 'cogs' AND c.source_id = CAST(oi.id AS TEXT)
        AND c.status = 'posted' AND c.reverses_journal_id IS NULL
    )
    AND COALESCE((
      SELECT -SUM(m.total_cost) FROM supply_movements m
      WHERE m.reference_type = 'order_item'
        AND (m.reference_id = CAST(oi.id AS TEXT) OR m.reference_id GLOB CAST(oi.id AS TEXT) || ':*')
    ), 0) > 0.000000001
    ORDER BY oi.id
  `).all() as Array<{ order_item_id: number; order_id: string; status: string | null }>;

  const missingReversals = db.prepare(`
    SELECT j.id AS journal_id, j.source_id AS order_item_id, oi.order_id, oi.status, j.entry_date
    FROM journal_entries j
    JOIN order_items oi ON oi.id = CAST(j.source_id AS INTEGER)
    WHERE j.source_module = 'cogs' AND j.status = 'posted' AND j.reverses_journal_id IS NULL
      AND oi.status = 'refunded'
    ORDER BY j.entry_date DESC, j.id DESC
  `).all() as Array<{ journal_id: string; order_item_id: string; order_id: string; status: string | null; entry_date: string }>;

  const debitTotal = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount END), 0) AS amount
    FROM journal_entry_lines WHERE journal_id = ?
  `);

  return [
    ...missingJournals.map((row) => ({
      event_id: String(row.order_item_id),
      state: 'missing_journal' as const,
      order_id: row.order_id ?? null,
      order_item_status: row.status ?? null,
      amount: itemConsumptionCost(db, row.order_item_id),
    })),
    ...missingReversals.map((row) => ({
      event_id: String(row.order_item_id),
      state: 'missing_reversal' as const,
      order_id: row.order_id ?? null,
      order_item_status: row.status ?? null,
      amount: Number((debitTotal.get(row.journal_id) as { amount: number }).amount),
    })),
  ];
}

/**
 * Completes exactly one missing projection for one order item: the COGS journal
 * when the sale is recognized without one, else the missing reversal when the
 * item still carries an active journal but was refunded. Everything else is a
 * no-op; identity stays `cogs + order item id + seq`.
 */
export function reprocessCogsAccounting(orderItemId: string, actorUserId: string): CogsReprocessResult {
  try {
    const db = getDatabase();
    const item = db.prepare('SELECT id, order_id, status FROM order_items WHERE id = ?').get(orderItemId) as OrderItemRow | undefined;

    if (item) {
      const active = activeItemJournal(db, item.id);
      if (active) {
        if (item.status === 'refunded') {
          const reversal = reverseJournal(active.id, actorUserId, fiscalDateForInstant(now()));
          return { order_item_id: orderItemId, status: 'reversal_created', journal_id: reversal.id };
        }
        return { order_item_id: orderItemId, status: 'already_recognized', journal_id: active.id };
      }
      // A refunded item is never re-recognized: its reversed COGS stays reversed.
      if (item.status === 'refunded') {
        const latest = latestItemJournal(db, item.id);
        return latest
          ? { order_item_id: orderItemId, status: 'already_reversed', journal_id: latest.id }
          : { order_item_id: orderItemId, status: 'nothing_to_do' };
      }
      const created = createItemCogsJournal(item.id, actorUserId);
      return created
        ? { order_item_id: orderItemId, status: 'recognized', journal_id: created.id }
        : { order_item_id: orderItemId, status: 'nothing_to_do' };
    }

    const orphan = activeItemJournal(db, orderItemId);
    if (!orphan) return { order_item_id: orderItemId, status: 'nothing_to_do' };
    const reversal = reverseJournal(orphan.id, actorUserId, fiscalDateForInstant(now()));
    return { order_item_id: orderItemId, status: 'reversal_created', journal_id: reversal.id };
  } catch (error) {
    console.error('[Accounting] COGS reprocess failed; left to reconciliation:', error);
    return { order_item_id: orderItemId, status: 'nothing_to_do' };
  }
}
