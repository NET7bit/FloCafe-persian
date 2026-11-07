/**
 * Pure contract for the inventory Recipe editor.
 *
 * This mirrors the two backend contracts the form must satisfy:
 *   - `main/services/units.ts` (unit dimensions / convertibility)
 *   - `main/services/recipes.ts` (`saveRecipe` validation + payload shape)
 *
 * It deliberately has no React, DOM, backend or network imports so the exact
 * rules used by the UI can be exercised directly by the test suite. The
 * dimension map is a projection of the backend's private `UNIT_DIMENSIONS`;
 * `tests/recipe-ui.test.ts` asserts parity across every unit pair.
 */

export const SUPPLY_UNITS = ['each', 'g', 'kg', 'ml', 'l'] as const;
export type SupplyUnit = (typeof SUPPLY_UNITS)[number];

export type UnitDimension = 'count' | 'mass' | 'volume';

const UNIT_DIMENSIONS: Record<SupplyUnit, UnitDimension> = {
  each: 'count',
  g: 'mass',
  kg: 'mass',
  ml: 'volume',
  l: 'volume',
};

export function isSupplyUnit(value: unknown): value is SupplyUnit {
  return typeof value === 'string' && (SUPPLY_UNITS as readonly string[]).includes(value);
}

/**
 * Units the backend can convert into the supply's base unit. Choosing a unit
 * from a different dimension (e.g. `ml` for a `g` supply) is rejected by
 * `convertQuantity` at save time, so the form must never offer it.
 */
export function compatibleUnitsFor(baseUnit: string): SupplyUnit[] {
  if (!isSupplyUnit(baseUnit)) return [];
  const dimension = UNIT_DIMENSIONS[baseUnit];
  return SUPPLY_UNITS.filter((unit) => UNIT_DIMENSIONS[unit] === dimension);
}

export interface RecipeFormItem {
  supply_id: string;
  quantity: string;
  unit: SupplyUnit;
}

export interface RecipeFormState {
  product_id: string;
  yield_quantity: string;
  items: RecipeFormItem[];
}

export interface RecipeSupplyOption {
  id: string;
  name: string;
  base_unit: SupplyUnit;
}

export type RecipeFormError =
  | 'productRequired'
  | 'yieldInvalid'
  | 'itemsRequired'
  | 'supplyRequired'
  | 'quantityInvalid'
  | 'unitInvalid'
  | 'duplicateSupply';

/** The exact snake_case body accepted by PUT /api/recipes/product/:productId. */
export interface RecipePayload {
  yield_quantity: number;
  is_active: boolean;
  items: { supply_id: string; quantity: number; unit: SupplyUnit }[];
}

export type RecipeValidation =
  | { ok: true; payload: RecipePayload }
  | { ok: false; error: RecipeFormError };

/** Mirrors `assertPositiveFinite`: finite, strictly greater than zero. */
export function parsePositiveQuantity(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Validate the editor state and build the API payload in one step, so an
 * invalid form can never be submitted. `isActive` is passed separately because
 * the editor preserves the activation state of an existing recipe: silently
 * re-activating an inactive recipe would change Recipe Depletion behaviour.
 */
export function validateRecipeForm(
  form: RecipeFormState,
  supplies: RecipeSupplyOption[],
  isActive = true,
): RecipeValidation {
  if (typeof form.product_id !== 'string' || !form.product_id.trim()) {
    return { ok: false, error: 'productRequired' };
  }
  const yieldQuantity = parsePositiveQuantity(form.yield_quantity);
  if (yieldQuantity === null) return { ok: false, error: 'yieldInvalid' };
  if (!form.items || form.items.length === 0) {
    return { ok: false, error: 'itemsRequired' };
  }

  const seen = new Set<string>();
  const items: RecipePayload['items'] = [];
  for (const item of form.items) {
    const supplyId = typeof item.supply_id === 'string' ? item.supply_id.trim() : '';
    if (!supplyId) return { ok: false, error: 'supplyRequired' };
    const supply = supplies.find((candidate) => candidate.id === supplyId);
    if (!supply) return { ok: false, error: 'supplyRequired' };
    const quantity = parsePositiveQuantity(item.quantity);
    if (quantity === null) return { ok: false, error: 'quantityInvalid' };
    if (!isSupplyUnit(item.unit) || !compatibleUnitsFor(supply.base_unit).includes(item.unit)) {
      return { ok: false, error: 'unitInvalid' };
    }
    if (seen.has(supplyId)) return { ok: false, error: 'duplicateSupply' };
    seen.add(supplyId);
    items.push({ supply_id: supplyId, quantity, unit: item.unit });
  }

  return {
    ok: true,
    payload: { yield_quantity: yieldQuantity, is_active: isActive, items },
  };
}
