/**
 * Payment attempt identity.
 *
 * A payment request is identified by (bill, exact split, customer, wallet
 * amount). The `Idempotency-Key` belongs to that identity and nothing else:
 * the server rejects a replayed key whose `request_hash` differs
 * (`main/routes/bills.ts`), so reusing a key after the cashier edits an amount
 * would turn a retry into a 409 instead of a safe replay.
 *
 * The key therefore lives next to a fingerprint of the exact payload that was
 * sent. Same fingerprint -> same key -> replay. Different fingerprint -> a new
 * key -> a genuinely new request.
 */

export interface PaymentAttempt {
  /** Value sent as the `Idempotency-Key` header. */
  key: string;
  /** Snapshot of the payload this key was minted for. */
  fingerprint: string;
}

export interface PaymentAttemptPayload {
  billId: string | number;
  /** Normalised split lines: method, optional custom method id, amount. */
  payments: Array<{ method: string; payment_method_id?: number; amount: number }>;
  customerId: string | number | null;
  walletAmount: number;
}

/**
 * Stable string for the payload. Order-sensitive on purpose: two splits that
 * only differ in line order still describe the same money, so lines are sorted
 * by method and amount before hashing.
 */
export function buildPaymentAttemptFingerprint(payload: PaymentAttemptPayload): string {
  const lines = payload.payments
    .map((line) => ({
      method: line.method,
      payment_method_id: line.payment_method_id ?? null,
      amount: Number(line.amount) || 0,
    }))
    .sort((a, b) => (
      a.method.localeCompare(b.method)
      || (a.payment_method_id ?? 0) - (b.payment_method_id ?? 0)
      || a.amount - b.amount
    ));
  return JSON.stringify({
    bill: String(payload.billId),
    lines,
    customer: payload.customerId == null ? null : String(payload.customerId),
    wallet: Number(payload.walletAmount) || 0,
  });
}

/**
 * Returns the attempt to use for this request. An attempt minted for a
 * different payload is discarded rather than reused.
 */
export function resolvePaymentAttempt(
  current: PaymentAttempt | null | undefined,
  fingerprint: string,
  createKey: () => string,
): PaymentAttempt {
  if (current && current.fingerprint === fingerprint) return current;
  return { key: createKey(), fingerprint };
}
