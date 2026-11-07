'use client';

import type { FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import {
  SUPPLY_UNITS,
  compatibleUnitsFor,
  type RecipeFormItem,
  type RecipeFormState,
  type RecipeSupplyOption,
  type SupplyUnit,
} from '@/lib/recipe-form';

interface ProductOption {
  id: string;
  name: string;
}

interface RecipeFormDialogProps {
  editing: boolean;
  form: RecipeFormState;
  products: ProductOption[];
  supplies: RecipeSupplyOption[];
  error: string | null;
  onChange: (next: RecipeFormState) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}

/**
 * The single Recipe editor surface used by the inventory page for both create
 * and edit. Validation itself lives in `@/lib/recipe-form` so the exact rules
 * can be unit-tested; this component only renders them (unit options are
 * restricted to the dimension of the chosen supply, duplicate supplies are
 * disabled, and the save button is disabled until at least one item exists).
 */
export default function RecipeFormDialog({
  editing,
  form,
  products,
  supplies,
  error,
  onChange,
  onSubmit,
  onCancel,
}: RecipeFormDialogProps) {
  const t = useTranslations('inventory');
  const tCommon = useTranslations('common');

  const setItem = (index: number, patch: Partial<RecipeFormItem>) => {
    const items = form.items.slice();
    items[index] = { ...items[index], ...patch };
    onChange({ ...form, items });
  };

  const addItem = () => {
    const first = supplies.find((s) => !form.items.some((item) => item.supply_id === s.id)) || supplies[0];
    onChange({
      ...form,
      items: [
        ...form.items,
        {
          supply_id: first?.id || '',
          quantity: '1',
          unit: (first?.base_unit || 'each') as SupplyUnit,
        },
      ],
    });
  };

  const removeItem = (index: number) => {
    onChange({ ...form, items: form.items.filter((_, i) => i !== index) });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card rounded-2xl p-6 w-full max-w-md max-h-[85vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">{editing ? t('editRecipe') : t('addRecipe')}</h2>
          <button type="button" onClick={onCancel} aria-label={tCommon('cancel')}>
            <X size={20} className="text-gray-400" />
          </button>
        </div>
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <select
            aria-label={t('product')}
            value={form.product_id}
            onChange={(e) => onChange({ ...form, product_id: e.target.value })}
            className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
            required
            disabled={editing}
          >
            <option value="">{t('product')}</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input
            type="number"
            step="any"
            min="0"
            aria-label={t('yield')}
            placeholder={t('yield')}
            value={form.yield_quantity}
            onChange={(e) => onChange({ ...form, yield_quantity: e.target.value })}
            className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
            required
          />

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-foreground">{t('components')}</span>
              <Button type="button" variant="outline" size="sm" onClick={addItem}>
                <Plus size={14} /> {t('addComponent')}
              </Button>
            </div>
            {form.items.map((item, index) => {
              const supply = supplies.find((s) => s.id === item.supply_id);
              const units = supply ? compatibleUnitsFor(supply.base_unit) : SUPPLY_UNITS;
              return (
                <div key={index} className="flex gap-2 mb-2">
                  <select
                    aria-label={t('supply')}
                    value={item.supply_id}
                    onChange={(e) => {
                      const target = supplies.find((s) => s.id === e.target.value);
                      setItem(index, {
                        supply_id: e.target.value,
                        unit: (target?.base_unit || 'each') as SupplyUnit,
                      });
                    }}
                    className="flex-1 min-w-0 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
                    required
                  >
                    <option value="">{t('supply')}</option>
                    {supplies.map((s) => (
                      <option
                        key={s.id}
                        value={s.id}
                        disabled={form.items.some((other, i) => i !== index && other.supply_id === s.id)}
                      >
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    aria-label={t('quantity')}
                    placeholder={t('quantity')}
                    value={item.quantity}
                    onChange={(e) => setItem(index, { quantity: e.target.value })}
                    className="w-24 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                    required
                  />
                  <select
                    aria-label={t('unitForComponent')}
                    value={item.unit}
                    onChange={(e) => setItem(index, { unit: e.target.value as SupplyUnit })}
                    className="px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
                  >
                    {units.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t('removeComponent')} onClick={() => removeItem(index)}>
                    <X size={14} />
                  </Button>
                </div>
              );
            })}
          </div>

          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <Button type="submit" className="w-full" disabled={form.items.length === 0}>{tCommon('save')}</Button>
        </form>
      </div>
    </div>
  );
}
