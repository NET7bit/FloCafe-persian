'use client';

import { useCallback, useEffect, useState } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import toast from 'react-hot-toast';
import { Plus, Search, X, Edit, Trash2, ArrowDownCircle, ArrowUpCircle, PackageMinus, ClipboardList, Scale } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { tenantCan } from '@/lib/permissions';
import RecipeFormDialog from '@/components/inventory/RecipeFormDialog';
import {
  SUPPLY_UNITS,
  validateRecipeForm,
  type RecipeFormError,
  type RecipeFormState,
  type RecipeSupplyOption,
  type SupplyUnit,
} from '@/lib/recipe-form';

interface Supply {
  id: string;
  name: string;
  base_unit: SupplyUnit;
  stock_quantity: number;
  cost_price: number | null;
  low_stock_threshold: number | null;
  is_active: number;
  is_low_stock?: number;
}

interface SupplyMovement {
  id: number;
  supply_id: string;
  supply_name: string | null;
  quantity_delta: number;
  movement_type: string;
  unit: SupplyUnit;
  stock_after: number;
  unit_cost: number | null;
  total_cost: number | null;
  reason: string | null;
  actor_name: string | null;
  created_at: string;
}

interface RecipeItem {
  supply_id: string;
  supply_name: string;
  base_unit: SupplyUnit;
  quantity: number;
  unit: SupplyUnit;
  quantity_in_base: number;
}

interface Recipe {
  id: string;
  product_id: string;
  product_name: string | null;
  yield_quantity: number;
  is_active: number;
  items: RecipeItem[];
}

interface Product {
  id: string;
  name: string;
}

const movementTypeIcons: Record<string, typeof ArrowUpCircle> = {
  receive: ArrowUpCircle,
  count: Scale,
  adjustment: Edit,
  waste: PackageMinus,
  recipe_depletion: ArrowDownCircle,
  recipe_restore: ArrowUpCircle,
};

export default function InventoryPage() {
  const { currentTenant } = useAuthStore();
  const t = useTranslations('inventory');
  const tProducts = useTranslations('products');
  const tNav = useTranslations('nav');
  const tCommon = useTranslations('common');
  const { formatDate } = useFormatDate();
  const fmtNum = useFormatNumber();
  const canManage = tenantCan(currentTenant, 'supplies.manage');

  const [tab, setTab] = useState('supplies');
  const [supplies, setSupplies] = useState<Supply[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [movements, setMovements] = useState<SupplyMovement[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [showSupplyForm, setShowSupplyForm] = useState(false);
  const [editingSupply, setEditingSupply] = useState<Supply | null>(null);
  const [supplyForm, setSupplyForm] = useState({ name: '', base_unit: 'each' as SupplyUnit, stock_quantity: '0', low_stock_threshold: '' });

  const [movementSupply, setMovementSupply] = useState<Supply | null>(null);
  const [movementForm, setMovementForm] = useState({ movement_type: 'receive', quantity: '', unit: 'each' as SupplyUnit, reason: '' });

  const [showRecipeForm, setShowRecipeForm] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);
  const [recipeForm, setRecipeForm] = useState<RecipeFormState>({ product_id: '', yield_quantity: '1', items: [] });
  const [recipeError, setRecipeError] = useState<string | null>(null);
  // The recipe editor needs every non-deleted supply, including inactive ones:
  // the supplies tab filters (search / low stock / active only) must not hide a
  // component that an existing recipe already references.
  const [recipeSupplies, setRecipeSupplies] = useState<RecipeSupplyOption[]>([]);

  const [deletingSupply, setDeletingSupply] = useState<Supply | null>(null);
  const [deletingRecipe, setDeletingRecipe] = useState<Recipe | null>(null);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    const params: Record<string, string> = {};
    if (search) params.search = search;
    if (lowStockOnly) params.low_stock = 'true';
    if (includeInactive) params.include_inactive = 'true';
    api.get('/supplies', { params, signal: controller.signal })
      .then(({ data }) => setSupplies(data.supplies || []))
      .catch((err: unknown) => {
        if (!(err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))) toast.error(t('loadFailed'));
      });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, lowStockOnly, includeInactive, refreshKey, canManage]);

  useEffect(() => {
    if (!canManage || tab !== 'recipes') return;
    const controller = new AbortController();
    Promise.all([
      api.get('/recipes', { signal: controller.signal }),
      api.get('/products', { signal: controller.signal }),
      api.get('/supplies', { params: { include_inactive: 'true' }, signal: controller.signal }),
    ])
      .then(([recipesRes, productsRes, suppliesRes]) => {
        setRecipes(recipesRes.data.recipes || []);
        setProducts(productsRes.data.products || []);
        // Keep inactive supplies available so editing an existing recipe never
        // silently drops a component; deleted supplies stay excluded by the API.
        setRecipeSupplies((suppliesRes.data.supplies || []).map((s: Supply) => ({
          id: s.id,
          name: s.name,
          base_unit: s.base_unit,
        })));
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))) toast.error(t('loadFailed'));
      });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, refreshKey, canManage]);

  const loadMovements = useCallback(async (cursor?: number | null) => {
    try {
      const params: Record<string, string | number> = { per_page: 50 };
      if (cursor) params.before_id = cursor;
      const { data } = await api.get('/supplies/movements', { params });
      setMovements((prev) => (cursor ? [...prev, ...(data.movements || [])] : data.movements || []));
      setNextCursor(data.nextCursor ?? null);
    } catch {
      toast.error(t('loadFailed'));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => {
    if (!canManage || tab !== 'movements') return;
    const controller = new AbortController();
    api.get('/supplies/movements', { params: { per_page: 50 }, signal: controller.signal })
      .then(({ data }) => {
        setMovements(data.movements || []);
        setNextCursor(data.nextCursor ?? null);
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))) toast.error(t('loadFailed'));
      });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, refreshKey, canManage]);

  const openAddSupply = () => {
    setEditingSupply(null);
    setSupplyForm({ name: '', base_unit: 'each', stock_quantity: '0', low_stock_threshold: '' });
    setShowSupplyForm(true);
  };

  const openEditSupply = (s: Supply) => {
    setEditingSupply(s);
    setSupplyForm({
      name: s.name,
      base_unit: s.base_unit,
      stock_quantity: String(s.stock_quantity),
      low_stock_threshold: s.low_stock_threshold === null ? '' : String(s.low_stock_threshold),
    });
    setShowSupplyForm(true);
  };

  const handleSaveSupply = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = {
        name: supplyForm.name,
        base_unit: supplyForm.base_unit,
        stock_quantity: Number(supplyForm.stock_quantity),
        low_stock_threshold: supplyForm.low_stock_threshold === '' ? null : Number(supplyForm.low_stock_threshold),
      };
      if (editingSupply) {
        await api.put(`/supplies/${editingSupply.id}`, {
          name: payload.name,
          low_stock_threshold: payload.low_stock_threshold,
        });
        toast.success(tCommon('save'));
      } else {
        await api.post('/supplies', payload);
        toast.success(tCommon('save'));
      }
      setShowSupplyForm(false);
      refresh();
    } catch (err: unknown) {
      const message = err instanceof Error && 'response' in err
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
        : undefined;
      toast.error(message || t('saveFailed'));
    }
  };

  const handleRecordMovement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!movementSupply) return;
    try {
      await api.post(`/supplies/${movementSupply.id}/movements`, {
        movement_type: movementForm.movement_type,
        quantity: Number(movementForm.quantity),
        unit: movementForm.unit,
        reason: movementForm.reason || undefined,
      });
      toast.success(tCommon('save'));
      setMovementSupply(null);
      setMovementForm({ movement_type: 'receive', quantity: '', unit: 'each', reason: '' });
      refresh();
      if (tab === 'movements') loadMovements(null);
    } catch (err: unknown) {
      const message = err instanceof Error && 'response' in err
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
        : undefined;
      toast.error(message || t('saveFailed'));
    }
  };

  const recipeErrorMessages: Record<RecipeFormError, string> = {
    productRequired: t('recipeErrorProductRequired'),
    yieldInvalid: t('recipeErrorYield'),
    itemsRequired: t('recipeErrorItems'),
    supplyRequired: t('recipeErrorSupply'),
    quantityInvalid: t('recipeErrorQuantity'),
    unitInvalid: t('recipeErrorUnit'),
    duplicateSupply: t('recipeErrorDuplicate'),
  };

  const openAddRecipe = () => {
    setEditingRecipe(null);
    setRecipeForm({ product_id: '', yield_quantity: '1', items: [] });
    setRecipeError(null);
    setShowRecipeForm(true);
  };

  const openEditRecipe = (r: Recipe) => {
    setEditingRecipe(r);
    setRecipeForm({
      product_id: r.product_id,
      yield_quantity: String(r.yield_quantity),
      items: r.items.map((item) => ({ supply_id: item.supply_id, quantity: String(item.quantity), unit: item.unit })),
    });
    setRecipeError(null);
    setShowRecipeForm(true);
  };

  const handleSaveRecipe = async (e: React.FormEvent) => {
    e.preventDefault();
    // Preserve activation state: an inactive recipe stops Recipe Depletion, so
    // re-saving it must not silently turn depletion back on.
    const isActive = editingRecipe ? editingRecipe.is_active === 1 : true;
    const validation = validateRecipeForm(recipeForm, recipeSupplies, isActive);
    if (!validation.ok) {
      const message = recipeErrorMessages[validation.error];
      setRecipeError(message);
      toast.error(message);
      return;
    }
    setRecipeError(null);
    try {
      await api.put(`/recipes/product/${recipeForm.product_id}`, validation.payload);
      toast.success(tCommon('save'));
      setShowRecipeForm(false);
      refresh();
    } catch (err: unknown) {
      const message = err instanceof Error && 'response' in err
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
        : undefined;
      setRecipeError(message || t('saveFailed'));
      toast.error(message || t('saveFailed'));
    }
  };

  const handleDeleteSupply = async () => {
    if (!deletingSupply) return;
    try {
      await api.delete(`/supplies/${deletingSupply.id}`);
      toast.success(tCommon('delete'));
      setDeletingSupply(null);
      refresh();
    } catch (err: unknown) {
      const message = err instanceof Error && 'response' in err
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
        : undefined;
      toast.error(message || t('deleteFailed'));
    }
  };

  const handleDeleteRecipe = async () => {
    if (!deletingRecipe) return;
    try {
      await api.delete(`/recipes/product/${deletingRecipe.product_id}`);
      toast.success(tCommon('delete'));
      setDeletingRecipe(null);
      refresh();
    } catch (err: unknown) {
      const message = err instanceof Error && 'response' in err
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
        : undefined;
      toast.error(message || t('deleteFailed'));
    }
  };

  if (!canManage) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <h1 className="text-xl font-bold text-foreground mb-2">{tNav('inventory')}</h1>
        <p className="text-muted-foreground">{t('noAccess')}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-foreground">{tNav('inventory')}</h1>
        {tab === 'supplies' && (
          <Button onClick={openAddSupply}><Plus size={16} className="me-1" /> {t('addSupply')}</Button>
        )}
        {tab === 'recipes' && (
          <Button onClick={openAddRecipe}><Plus size={16} className="me-1" /> {t('addRecipe')}</Button>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="supplies">{t('tabSupplies')}</TabsTrigger>
          <TabsTrigger value="recipes">{t('tabRecipes')}</TabsTrigger>
          <TabsTrigger value="movements">{t('tabMovements')}</TabsTrigger>
        </TabsList>

        <TabsContent value="supplies">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="relative flex-1 min-w-48">
              <Search size={18} className="absolute start-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder={tCommon('search')}
                className="w-full ps-10 pe-4 py-2.5 bg-card border border-border rounded-lg focus:ring-2 focus:ring-brand outline-none"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap">
              <input type="checkbox" checked={lowStockOnly} onChange={(e) => setLowStockOnly(e.target.checked)} />
              {t('lowStockOnly')}
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap">
              <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
              {t('includeInactive')}
            </label>
          </div>

          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('supplyName')}</th>
                  <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{t('baseUnit')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('stock')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('threshold')}</th>
                  <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{tCommon('active')}</th>
                  <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{t('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {supplies.map((s) => (
                  <tr key={s.id} className="hover:bg-muted">
                    <td className="p-4 font-medium text-foreground">
                      {s.name}
                      <p className="text-xs font-normal text-muted-foreground">
                        {tProducts('costLabel', {
                          value: s.cost_price != null && Number(s.cost_price) > 0
                            ? `${fmtNum(Number(s.cost_price))} / ${s.base_unit}`
                            : tCommon('unknown'),
                        })}
                      </p>
                      {s.is_low_stock === 1 && (
                        <Badge variant="destructive" className="ms-2">{t('lowStock')}</Badge>
                      )}
                    </td>
                    <td className="p-4 text-center text-sm text-muted-foreground">{s.base_unit}</td>
                    <td className={`p-4 text-end text-sm font-medium ${Number(s.stock_quantity) < 0 ? 'text-red-600' : ''}`}>{fmtNum(Number(s.stock_quantity))} {s.base_unit}</td>
                    <td className="p-4 text-end text-sm text-muted-foreground">
                      {s.low_stock_threshold === null ? '—' : fmtNum(Number(s.low_stock_threshold))}
                    </td>
                    <td className="p-4 text-center text-sm">
                      {s.is_active === 1 ? tCommon('active') : tCommon('inactive')}
                    </td>
                    <td className="p-4 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => {
                          setMovementSupply(s);
                          setMovementForm({ movement_type: 'receive', quantity: '', unit: s.base_unit, reason: '' });
                        }} title={t('recordMovement')}>
                          <ArrowDownCircle size={14} />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEditSupply(s)} title={tCommon('edit')}>
                          <Edit size={14} />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeletingSupply(s)} title={tCommon('delete')}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {supplies.length === 0 && <p className="text-center text-muted-foreground py-12">{t('emptySupplies')}</p>}
          </div>
        </TabsContent>

        <TabsContent value="recipes">
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('product')}</th>
                  <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{t('yield')}</th>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('components')}</th>
                  <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{t('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recipes.map((r) => (
                  <tr key={r.id} className="hover:bg-muted">
                    <td className="p-4 font-medium text-foreground">
                      {r.product_name || r.product_id}
                      {r.is_active !== 1 && (
                        <Badge variant="secondary" className="ms-2">{tCommon('inactive')}</Badge>
                      )}
                    </td>
                    <td className="p-4 text-center text-sm">{fmtNum(Number(r.yield_quantity))}</td>
                    <td className="p-4 text-sm text-muted-foreground">
                      <ul className="space-y-0.5">
                        {r.items.map((item) => (
                          <li key={item.supply_id}>
                            {item.supply_name}: {fmtNum(Number(item.quantity))} {item.unit}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="p-4 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEditRecipe(r)} title={tCommon('edit')}>
                          <Edit size={14} />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeletingRecipe(r)} title={tCommon('delete')}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {recipes.length === 0 && <p className="text-center text-muted-foreground py-12">{t('emptyRecipes')}</p>}
          </div>
        </TabsContent>

        <TabsContent value="movements">
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('date')}</th>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('supply')}</th>
                  <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{t('movementType')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('quantity')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('costPerUnit')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('totalCost')}</th>
                  <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase">{t('stockAfter')}</th>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('reason')}</th>
                  <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase">{t('actor')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {movements.map((m) => {
                  const Icon = movementTypeIcons[m.movement_type] || ClipboardList;
                  const labelKey = m.movement_type === 'recipe_depletion' ? 'recipeDepletion'
                    : m.movement_type === 'recipe_restore' ? 'recipeRestore'
                    : m.movement_type;
                  return (
                    <tr key={m.id} className="hover:bg-muted">
                      <td className="p-4 text-sm text-muted-foreground whitespace-nowrap">{formatDate(m.created_at)}</td>
                      <td className="p-4 text-sm font-medium text-foreground">{m.supply_name || m.supply_id}</td>
                      <td className="p-4 text-center text-sm">
                        <span className="inline-flex items-center gap-1.5">
                          <Icon size={14} className="text-muted-foreground" />
                          {t(labelKey as 'receive' | 'count' | 'adjustment' | 'waste' | 'recipeDepletion' | 'recipeRestore')}
                        </span>
                      </td>
                      <td className={`p-4 text-end text-sm font-medium whitespace-nowrap ${Number(m.quantity_delta) < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                        {Number(m.quantity_delta) > 0 ? '+' : ''}{fmtNum(Number(m.quantity_delta))} {m.unit}
                      </td>
                      <td className="p-4 text-end text-sm text-muted-foreground whitespace-nowrap">
                        {m.unit_cost == null || Number(m.unit_cost) <= 0
                          ? tCommon('unknown')
                          : `${fmtNum(Number(m.unit_cost))} / ${m.unit}`}
                      </td>
                      <td className="p-4 text-end text-sm text-muted-foreground whitespace-nowrap">
                        {m.total_cost == null || m.unit_cost == null || Number(m.unit_cost) <= 0
                          ? tCommon('unknown')
                          : fmtNum(Number(m.total_cost))}
                      </td>
                      <td className="p-4 text-end text-sm text-muted-foreground whitespace-nowrap">{fmtNum(Number(m.stock_after))} {m.unit}</td>
                      <td className="p-4 text-sm text-muted-foreground">{m.reason || '—'}</td>
                      <td className="p-4 text-sm text-muted-foreground">{m.actor_name || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {movements.length === 0 && <p className="text-center text-muted-foreground py-12">{t('emptyMovements')}</p>}
            {nextCursor !== null && (
              <div className="text-center py-3 border-t border-border">
                <Button variant="outline" size="sm" onClick={() => loadMovements(nextCursor)}>{t('loadMore')}</Button>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {showSupplyForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{editingSupply ? t('editSupply') : t('addSupply')}</h2>
              <button onClick={() => setShowSupplyForm(false)}><X size={20} className="text-gray-400" /></button>
            </div>
            <form onSubmit={handleSaveSupply} className="space-y-4">
              <input type="text" placeholder={t('supplyName')} value={supplyForm.name}
                onChange={(e) => setSupplyForm({ ...supplyForm, name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required />
              {!editingSupply && (
                <>
                  <select value={supplyForm.base_unit}
                    onChange={(e) => setSupplyForm({ ...supplyForm, base_unit: e.target.value as SupplyUnit })}
                    className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card">
                    {SUPPLY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <input type="number" step="any" min="0" placeholder={t('stock')} value={supplyForm.stock_quantity}
                    onChange={(e) => setSupplyForm({ ...supplyForm, stock_quantity: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required />
                </>
              )}
              <input type="number" step="any" min="0" placeholder={t('threshold')} value={supplyForm.low_stock_threshold}
                onChange={(e) => setSupplyForm({ ...supplyForm, low_stock_threshold: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
              <Button type="submit" className="w-full">{tCommon('save')}</Button>
            </form>
          </div>
        </div>
      )}

      {movementSupply && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('recordMovement')}</h2>
              <button onClick={() => setMovementSupply(null)}><X size={20} className="text-gray-400" /></button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{movementSupply.name}</p>
            <form onSubmit={handleRecordMovement} className="space-y-4">
              <select value={movementForm.movement_type}
                onChange={(e) => setMovementForm({ ...movementForm, movement_type: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card">
                <option value="receive">{t('receive')}</option>
                <option value="count">{t('count')}</option>
                <option value="adjustment">{t('adjustment')}</option>
                <option value="waste">{t('waste')}</option>
              </select>
              <div className="flex gap-2">
                <input type="number" step="any" min={movementForm.movement_type === 'adjustment' ? undefined : 0} placeholder={t('quantity')} value={movementForm.quantity}
                  onChange={(e) => setMovementForm({ ...movementForm, quantity: e.target.value })}
                  className="flex-1 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required />
                <select value={movementForm.unit}
                  onChange={(e) => setMovementForm({ ...movementForm, unit: e.target.value as SupplyUnit })}
                  className="px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card">
                  {SUPPLY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <input type="text" placeholder={t('reason')} value={movementForm.reason}
                onChange={(e) => setMovementForm({ ...movementForm, reason: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                required={movementForm.movement_type === 'adjustment' || movementForm.movement_type === 'waste'} />
              <Button type="submit" className="w-full">{tCommon('save')}</Button>
            </form>
          </div>
        </div>
      )}

      {showRecipeForm && (
        <RecipeFormDialog
          editing={Boolean(editingRecipe)}
          form={recipeForm}
          products={products}
          supplies={recipeSupplies}
          error={recipeError}
          onChange={(next) => { setRecipeForm(next); setRecipeError(null); }}
          onSubmit={handleSaveRecipe}
          onCancel={() => setShowRecipeForm(false)}
        />
      )}

      {deletingSupply && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <h2 className="text-lg font-bold mb-2">{tCommon('delete')}</h2>
            <p className="text-sm text-muted-foreground mb-4">{t('confirmDeleteSupply', { name: deletingSupply.name })}</p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setDeletingSupply(null)}>{tCommon('cancel')}</Button>
              <Button variant="destructive" onClick={handleDeleteSupply}>{tCommon('delete')}</Button>
            </div>
          </div>
        </div>
      )}

      {deletingRecipe && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <h2 className="text-lg font-bold mb-2">{tCommon('delete')}</h2>
            <p className="text-sm text-muted-foreground mb-4">{t('confirmDeleteRecipe', { name: deletingRecipe.product_name || deletingRecipe.product_id })}</p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setDeletingRecipe(null)}>{tCommon('cancel')}</Button>
              <Button variant="destructive" onClick={handleDeleteRecipe}>{tCommon('delete')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
