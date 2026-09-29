import { randomBytes } from 'crypto';
import { getDatabase, now, withTxn } from '../db';

export class SupplierServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'SupplierServiceError';
    this.statusCode = statusCode;
  }
}

export interface SupplierRecord {
  id: string;
  name: string;
  code: string | null;
  phone: string | null;
  mobile: string | null;
  national_id: string | null;
  economic_code: string | null;
  address: string | null;
  notes: string | null;
  is_active: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSupplierInput {
  id?: string;
  name: string;
  code?: string | null;
  phone?: string | null;
  mobile?: string | null;
  nationalId?: string | null;
  economicCode?: string | null;
  address?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export interface UpdateSupplierInput {
  name?: string;
  code?: string | null;
  phone?: string | null;
  mobile?: string | null;
  nationalId?: string | null;
  economicCode?: string | null;
  address?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

const MAX_NAME_LENGTH = 200;
const MAX_CODE_LENGTH = 64;
const MAX_PHONE_LENGTH = 32;
const MAX_NATIONAL_ID_LENGTH = 32;
const MAX_ECONOMIC_CODE_LENGTH = 32;
const MAX_ADDRESS_LENGTH = 500;
const MAX_NOTES_LENGTH = 1000;

function newId(): string {
  return `supp_${randomBytes(12).toString('hex')}`;
}

function trimToNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function assertFieldLength(value: string | null, maxLength: number, field: string): string | null {
  if (value === null) return null;
  if (value.length > maxLength) throw new SupplierServiceError(400, `${field} is too long`);
  return value;
}

function normalizeContactFields(input: {
  phone?: string | null;
  mobile?: string | null;
  nationalId?: string | null;
  economicCode?: string | null;
  address?: string | null;
  notes?: string | null;
}) {
  return {
    phone: assertFieldLength(trimToNull(input.phone), MAX_PHONE_LENGTH, 'phone'),
    mobile: assertFieldLength(trimToNull(input.mobile), MAX_PHONE_LENGTH, 'mobile'),
    nationalId: assertFieldLength(trimToNull(input.nationalId), MAX_NATIONAL_ID_LENGTH, 'national_id'),
    economicCode: assertFieldLength(trimToNull(input.economicCode), MAX_ECONOMIC_CODE_LENGTH, 'economic_code'),
    address: assertFieldLength(trimToNull(input.address), MAX_ADDRESS_LENGTH, 'address'),
    notes: assertFieldLength(trimToNull(input.notes), MAX_NOTES_LENGTH, 'notes'),
  };
}

function assertUniqueCode(db: ReturnType<typeof getDatabase>, code: string | null, excludeId?: string): void {
  if (code === null) return;
  const existing = excludeId === undefined
    ? (db.prepare('SELECT id FROM suppliers WHERE code = ? AND deleted_at IS NULL').get(code) as { id: string } | undefined)
    : (db.prepare('SELECT id FROM suppliers WHERE code = ? AND id != ? AND deleted_at IS NULL').get(code, excludeId) as
      | { id: string }
      | undefined);
  if (existing) throw new SupplierServiceError(409, 'A supplier with this code already exists');
}

function rowToSupplier(row: SupplierRecord): SupplierRecord {
  return {
    ...row,
    code: row.code ?? null,
    phone: row.phone ?? null,
    mobile: row.mobile ?? null,
    national_id: row.national_id ?? null,
    economic_code: row.economic_code ?? null,
    address: row.address ?? null,
    notes: row.notes ?? null,
  };
}

export function getSupplier(db: ReturnType<typeof getDatabase>, id: string): SupplierRecord {
  const row = db.prepare('SELECT * FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(id) as
    | SupplierRecord
    | undefined;
  if (!row) throw new SupplierServiceError(404, 'Supplier not found');
  return rowToSupplier(row);
}

export function listSuppliers(
  db: ReturnType<typeof getDatabase>,
  filters: { includeInactive?: boolean; search?: string } = {},
): SupplierRecord[] {
  const conditions = ['deleted_at IS NULL'];
  const params: (string | number)[] = [];
  if (!filters.includeInactive) conditions.push('is_active = 1');
  if (filters.search) {
    conditions.push('(name LIKE ? OR code LIKE ? OR mobile LIKE ? OR phone LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term, term, term);
  }
  return db.prepare(`
    SELECT * FROM suppliers
    WHERE ${conditions.join(' AND ')}
    ORDER BY name COLLATE NOCASE
  `).all(...params) as SupplierRecord[];
}

export function createSupplier(db: ReturnType<typeof getDatabase>, input: CreateSupplierInput): SupplierRecord {
  const name = String(input.name || '').trim();
  if (!name) throw new SupplierServiceError(400, 'name is required');
  if (name.length > MAX_NAME_LENGTH) throw new SupplierServiceError(400, 'name is too long');

  const code = assertFieldLength(trimToNull(input.code), MAX_CODE_LENGTH, 'code');
  const contacts = normalizeContactFields(input);
  const id = input.id || newId();
  const timestamp = now();
  const isActive = input.isActive === false ? 0 : 1;

  withTxn(() => {
    assertUniqueCode(db, code);
    db.prepare(`
      INSERT INTO suppliers (
        id, name, code, phone, mobile, national_id, economic_code, address, notes,
        is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, code, contacts.phone, contacts.mobile, contacts.nationalId, contacts.economicCode,
      contacts.address, contacts.notes, isActive, timestamp, timestamp);
  });

  return getSupplier(db, id);
}

export function updateSupplier(
  db: ReturnType<typeof getDatabase>,
  id: string,
  input: UpdateSupplierInput,
): SupplierRecord {
  const supplier = getSupplier(db, id);

  const name = input.name === undefined ? supplier.name : String(input.name).trim();
  if (!name) throw new SupplierServiceError(400, 'name is required');
  if (name.length > MAX_NAME_LENGTH) throw new SupplierServiceError(400, 'name is too long');

  const code = input.code === undefined ? supplier.code : assertFieldLength(trimToNull(input.code), MAX_CODE_LENGTH, 'code');
  const phone = input.phone === undefined ? supplier.phone : trimToNull(input.phone);
  const mobile = input.mobile === undefined ? supplier.mobile : trimToNull(input.mobile);
  const nationalId = input.nationalId === undefined ? supplier.national_id : trimToNull(input.nationalId);
  const economicCode = input.economicCode === undefined ? supplier.economic_code : trimToNull(input.economicCode);
  const address = input.address === undefined ? supplier.address : trimToNull(input.address);
  const notes = input.notes === undefined ? supplier.notes : trimToNull(input.notes);
  const isActive = input.isActive === undefined ? supplier.is_active : (input.isActive ? 1 : 0);

  const normalized = normalizeContactFields({ phone, mobile, nationalId, economicCode, address, notes });

  withTxn(() => {
    assertUniqueCode(db, code, id);
    db.prepare(`
      UPDATE suppliers SET
        name = ?, code = ?, phone = ?, mobile = ?, national_id = ?, economic_code = ?,
        address = ?, notes = ?, is_active = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(name, code, normalized.phone, normalized.mobile, normalized.nationalId, normalized.economicCode,
      normalized.address, normalized.notes, isActive, now(), id);
  });

  return getSupplier(db, id);
}

export function softDeleteSupplier(db: ReturnType<typeof getDatabase>, id: string): void {
  getSupplier(db, id);
  const timestamp = now();
  withTxn(() => {
    db.prepare('UPDATE suppliers SET is_active = 0, deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(timestamp, timestamp, id);
  });
}
