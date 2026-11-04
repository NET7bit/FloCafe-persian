import type { getDatabase } from '../db';

/**
 * Resolves and validates item add-ons against the catalog so pricing is always
 * authoritative: the price a client sends is never trusted, only the catalog row
 * the add-on id points at.
 *
 * Lives here rather than in the orders route because both the order endpoint and
 * the tax preview need the same answer. Keeping one implementation is the point:
 * two copies drifted once already (preview priced the client's number, the order
 * priced the catalog), and a preview that disagrees with the stored order is a
 * money bug, not a display bug.
 *
 * Throws plain `Error` with a caller-facing message for every validation failure;
 * callers decide the HTTP shape.
 */
export function resolveItemAddons(
  db: ReturnType<typeof getDatabase>,
  productId: string,
  addons: { id?: string; name?: string; price?: number; quantity?: number }[] | null | undefined,
): { id: string; name: string; price: number; quantity: number }[] {
  const addonInputs = Array.isArray(addons) ? addons : [];

  const product = db.prepare('SELECT category_id FROM products WHERE id = ?').get(productId) as { category_id: string | null } | undefined;
  const productGroupIds = (db.prepare('SELECT addon_group_id FROM addon_group_product WHERE product_id = ?').all(productId) as { addon_group_id: string }[])
    .map((row) => row.addon_group_id);
  const categoryGroupIds = product?.category_id
    ? (db.prepare('SELECT addon_group_id FROM category_addon_groups WHERE category_id = ?').all(product.category_id) as { addon_group_id: string }[])
      .map((row) => row.addon_group_id)
    : [];
  const linkedGroupIds = new Set([...productGroupIds, ...categoryGroupIds]);

  const resolved: { id: string; name: string; price: number; quantity: number }[] = [];
  const groupSelections = new Map<string, { totalQty: number; hasMultiQty: boolean }>();

  for (const addon of addonInputs) {
    if (!addon) continue;
    if (!addon.id || typeof addon.id !== 'string') {
      throw new Error('Each add-on must reference a valid catalog add-on ID');
    }
    const catalog = db.prepare(`
      SELECT addons.*, addon_groups.is_active AS addon_group_is_active
      FROM addons LEFT JOIN addon_groups ON addon_groups.id = addons.addon_group_id
      WHERE addons.id = ?
    `).get(addon.id) as
      | { id: string; addon_group_id: string | null; name: string; price: number; is_active: number; addon_group_is_active: number | null }
      | undefined;
    if (!catalog) {
      throw new Error(`Add-on "${addon.id}" was not found`);
    }
    if (catalog.is_active !== 1 || (catalog.addon_group_id !== null && catalog.addon_group_is_active !== 1)) {
      throw new Error(`Add-on "${catalog.name}" is not available`);
    }
    const addonGroupId = catalog.addon_group_id;
    if (!addonGroupId || !linkedGroupIds.has(addonGroupId)) {
      throw new Error(`Add-on "${catalog.name}" is not available for this product`);
    }

    const quantity = addon.quantity ?? 1;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`Invalid add-on quantity for "${catalog.name}": must be a positive integer`);
    }

    resolved.push({ id: catalog.id, name: catalog.name, price: Number(catalog.price) || 0, quantity });

    const qty = Math.max(1, Math.floor(quantity));
    const current = groupSelections.get(addonGroupId) || { totalQty: 0, hasMultiQty: false };
    groupSelections.set(addonGroupId, {
      totalQty: current.totalQty + qty,
      hasMultiQty: current.hasMultiQty || qty > 1,
    });
  }

  // Validate every group linked to the product, not just ones with a selection —
  // otherwise a required group (e.g. Size) can be silently skipped by omitting `addons`.
  for (const groupId of linkedGroupIds) {
    const group = db.prepare('SELECT * FROM addon_groups WHERE id = ? AND is_active = 1').get(groupId) as
      | { name: string; is_required: number; min_selection: number | null; max_selection: number | null; allow_multiple_quantities: number }
      | undefined;
    if (!group) continue;
    const selection = groupSelections.get(groupId) || { totalQty: 0, hasMultiQty: false };

    if (!group.allow_multiple_quantities && selection.hasMultiQty) {
      throw new Error(`Add-on group "${group.name}" does not allow multiple quantities`);
    }

    if (group.max_selection !== null && group.max_selection !== undefined && selection.totalQty > group.max_selection) {
      throw new Error(`Total add-on quantity for group "${group.name}" exceeds maximum allowed (${group.max_selection})`);
    }

    const requiredMin = group.is_required ? Math.max(1, group.min_selection || 1) : (group.min_selection || 0);
    if (requiredMin > 0 && selection.totalQty < requiredMin) {
      throw new Error(`Selection for group "${group.name}" requires at least ${requiredMin} item(s)`);
    }
  }

  return resolved;
}
