'use client';

import axios, { AxiosInstance } from 'axios';
import toast from 'react-hot-toast';
import { Bell, CheckCircle2, ChefHat, Circle, Flame, LogOut, Minus, Plus, RefreshCw, Search, Send, Smartphone, Trash2, UserRound } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { parsePhone } from '@/lib/phone';
import { useSyncServerLanguage } from '@/lib/i18n';
import { useTranslations, type AppConfig } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { toastApiError } from '@/lib/api-error';
import { useAuthStore } from '@/store/auth';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { Product, Addon, Order, Tenant } from '@/lib/types';
import AddonModal from '@/components/pos/AddonModal';
import { generateCartItemId } from '@/lib/cart-identity';
import { buildAppendItemsFingerprint } from '@/lib/append-attempt';

type User = { id: string; name: string; email: string; role: string };
type Category = { id: string; name: string };
type Table = { id: string; name?: string; number?: string; status?: string; activeOrder?: Order | null; current_order?: Order | null };
type DraftLine = { id: string; product: Product; quantity: number; note: string; addons: Addon[] };

type ServerAppKey = keyof AppConfig['Messages']['serverApp'];

const TOKEN_KEY = 'flocafe:server-app-token';
const DRAFTS_KEY = 'flocafe:server-app-drafts';

/** Funciona en el origen HTTP plano de la LAN, donde no existe crypto.randomUUID. */
function newIdempotencyKey(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `server-app-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createApi(): AxiosInstance {
  const api = axios.create({ baseURL: window.location.origin, timeout: 10000 });
  api.interceptors.request.use((config) => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  });
  api.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 401) localStorage.removeItem(TOKEN_KEY);
      return Promise.reject(error);
    },
  );
  return api;
}

function itemStatusIcon(status: string, t: (key: ServerAppKey) => string) {
  if (status === 'preparing') return <Flame size={15} className="text-orange-500" aria-label={t('statusPreparing')} />;
  if (status === 'ready') return <Bell size={15} className="text-emerald-600" aria-label={t('statusReady')} />;
  if (status === 'served') return <CheckCircle2 size={15} className="text-blue-600" aria-label={t('statusServed')} />;
  return <Circle size={15} className="text-gray-400" aria-label={t('statusWaiting')} />;
}

function setTenantFromSettings(data: Record<string, unknown>) {
  const store = useAuthStore.getState();
  const merged: Record<string, unknown> = { ...store.currentTenant, ...data };
  useAuthStore.setState({ currentTenant: merged as unknown as Tenant });
}

export default function ServerStandalonePage() {
  // Syncs tenant language preference from /api/server-app/info.
  useSyncServerLanguage('/api/server-app/info');
  const t = useTranslations('serverApp');
  const tAuth = useTranslations('auth');
  const tOrders = useTranslations('orders');
  const tTables = useTranslations('tables');
  const tPos = useTranslations('pos');
  const tNav = useTranslations('nav');
  const fmt = useFormatCurrency();
  const tenantCountry = useAuthStore((state) => state.currentTenant?.country) ?? 'IN';

  // Fall back to caller-supplied localized message for server-app errors without dotted error codes.
  const apiErrorT = (key: string): string => key;
  const api = useMemo(() => (typeof window !== 'undefined' ? createApi() : null), []);
  const sendAttemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [disabled, setDisabled] = useState(false);

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedTableId, setSelectedTableId] = useState<string>('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all');
  const [query, setQuery] = useState('');
  // Los borradores se rehidratan al montar para que bloquear el teléfono o
  // recargar la página no borre la ronda que el mesero venía armando.
  const [draftsByTable, setDraftsByTable] = useState<Record<string, DraftLine[]>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const stored = window.localStorage.getItem(DRAFTS_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });
  const [addonProduct, setAddonProduct] = useState<Product | null>(null);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [currentOrder, setCurrentOrder] = useState<Order | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [sending, setSending] = useState(false);

  const draft = useMemo(() => draftsByTable[selectedTableId] || [], [draftsByTable, selectedTableId]);

  // Una sesión vencida devuelve a la pantalla de inicio de sesión, en vez de
  // dejar al mesero tocando botones que ya no responden.
  useEffect(() => {
    if (!api) return;
    const interceptor = api.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) setUser(null);
        return Promise.reject(error);
      },
    );
    return () => api.interceptors.response.eject(interceptor);
  }, [api]);

  // El borrador pertenece a la mesa: cambiar de mesa nunca arrastra la ronda anterior.
  function setDraft(next: DraftLine[] | ((lines: DraftLine[]) => DraftLine[])) {
    if (!selectedTableId) return;
    setDraftsByTable((all) => {
      const lines = typeof next === 'function' ? next(all[selectedTableId] || []) : next;
      const updated = { ...all };
      if (lines.length === 0) delete updated[selectedTableId];
      else updated[selectedTableId] = lines;
      return updated;
    });
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(draftsByTable));
    } catch {
      // Modo privado o cuota llena: los borradores siguen solo en memoria.
    }
  }, [draftsByTable]);

  async function loadAll() {
    if (!api) return;
    const [categoriesRes, productsRes, tablesRes, settingsRes] = await Promise.all([
      api.get('/api/categories', { params: { active: 'true' } }),
      api.get('/api/products', { params: { active: 'true' } }),
      api.get('/api/tables', { params: { active: 'true' } }),
      api.get('/api/settings/business'),
    ]);
    setCategories(categoriesRes.data.categories || []);
    setProducts(productsRes.data.products || []);
    const loadedTables = tablesRes.data.tables || [];
    setTables(loadedTables);
    setSelectedTableId((current) => current || loadedTables[0]?.id || '');
    setTenantFromSettings(settingsRes.data);
  }

  async function loadOrder(tableId: string) {
    if (!api || !tableId) return;
    const res = await api.get('/api/orders', {
      params: { table_id: tableId, type: 'dine_in', status: 'pending,preparing,ready', per_page: 1 },
    });
    const order = res.data.orders?.[0] || null;
    setCurrentOrder(order);
    if (order?.customer) {
      setCustomerName(order.customer.name || '');
      setCustomerPhone(order.customer.phone || '');
    } else {
      setCustomerName('');
      setCustomerPhone('');
    }
  }

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.get('/api/server-app/info')
      .then(() => api.get('/api/auth/me'))
      .then((res) => {
        if (!cancelled) setUser(res.data.user);
      })
      .catch((error) => {
        if (error.response?.status === 404) setDisabled(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (!user || !api) return;
    let cancelled = false;
    Promise.all([
      api.get('/api/categories', { params: { active: 'true' } }),
      api.get('/api/products', { params: { active: 'true' } }),
      api.get('/api/tables', { params: { active: 'true' } }),
      api.get('/api/settings/business'),
    ]).then(([categoriesRes, productsRes, tablesRes, settingsRes]) => {
      if (cancelled) return;
      setCategories(categoriesRes.data.categories || []);
      setProducts(productsRes.data.products || []);
      const loadedTables = tablesRes.data.tables || [];
      setTables(loadedTables);
      setSelectedTableId((current) => current || loadedTables[0]?.id || '');
      setTenantFromSettings(settingsRes.data);
    }).catch(() => toast.error(t('couldNotLoadData')));
    return () => { cancelled = true; };
  }, [api, user, t]);

  useEffect(() => {
    if (!selectedTableId || !user || !api) return;
    let cancelled = false;
    api.get('/api/orders', {
      params: { table_id: selectedTableId, type: 'dine_in', status: 'pending,preparing,ready', per_page: 1 },
    }).then((res) => {
      if (cancelled) return;
      const order = res.data.orders?.[0] || null;
      setCurrentOrder(order);
      if (order?.customer) {
        setCustomerName(order.customer.name || '');
        setCustomerPhone(order.customer.phone || '');
      } else {
        setCustomerName('');
        setCustomerPhone('');
      }
    }).catch(() => {
      if (!cancelled) setCurrentOrder(null);
    });
    return () => { cancelled = true; };
  }, [api, selectedTableId, user]);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    if (!api) return;
    setLoginLoading(true);
    try {
      const res = await api.post('/api/auth/login', { email, password, remember_me: rememberMe });
      localStorage.setItem(TOKEN_KEY, res.data.access_token);
      setUser(res.data.user);
    } catch (error: unknown) {
      toastApiError(error, t('signInFailed'), apiErrorT);
    } finally {
      setLoginLoading(false);
    }
  }

  async function logout() {
    try { await api?.post('/api/auth/logout'); } catch {}
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
  }

  function handleProductClick(product: Product) {
    setEditingLineId(null);
    setAddonProduct(product);
  }

  function handleEditLine(line: DraftLine) {
    setEditingLineId(line.id);
    setAddonProduct(line.product);
  }

  function handleAddonAdd(product: Product, quantity: number, addons: Addon[], specialInstructions: string) {
    const lineId = generateCartItemId(product.id, addons, specialInstructions);
    setDraft((lines) => {
      const others = editingLineId ? lines.filter((line) => line.id !== editingLineId) : lines;
      // Mismo producto, adiciones y nota se fusionan en una sola línea.
      if (others.some((line) => line.id === lineId)) {
        return others.map((line) => line.id === lineId ? { ...line, quantity: line.quantity + quantity } : line);
      }
      const nextLine = { id: lineId, product, quantity, note: specialInstructions, addons };
      if (!editingLineId) return [...lines, nextLine];
      return lines.map((line) => line.id === editingLineId ? nextLine : line);
    });
    setEditingLineId(null);
    setAddonProduct(null);
  }

  function changeQty(lineId: string, delta: number) {
    setDraft((lines) => lines
      .map((line) => line.id === lineId ? { ...line, quantity: line.quantity + delta } : line)
      .filter((line) => line.quantity > 0));
  }

  async function ensureCustomer(): Promise<string | null> {
    if (!api) return null;
    const name = customerName.trim();
    const rawPhone = customerPhone.trim();
    if (!name && !rawPhone) return null;
    let normalizedPhone: string | undefined = undefined;
    if (rawPhone) {
      const parsed = parsePhone(rawPhone, tenantCountry);
      normalizedPhone = parsed ? parsed.e164 : rawPhone;
      try {
        const lookup = await api.get('/api/crm/lookup', { params: { phone: normalizedPhone } });
        if (lookup.data.found && lookup.data.customer?.id) return lookup.data.customer.id;
      } catch {}
    }
    const fallbackName = name || t('guestFallbackName', { last4: rawPhone.slice(-4) });
    const res = await api.post('/api/customers', { name: fallbackName, phone: normalizedPhone || undefined });
    return res.data.customer?.id || null;
  }

  async function sendDraft() {
    if (!api || !selectedTableId || draft.length === 0) return;
    setSending(true);
    try {
      const customerId = await ensureCustomer();
      const items = draft.map((line) => ({
        product_id: line.product.id,
        quantity: line.quantity,
        special_instructions: line.note.trim() || undefined,
        addons: line.addons.length > 0
          ? line.addons.map((a) => ({ id: a.id, name: a.name, price: a.price, quantity: a.quantity || 1 }))
          : null,
      }));
      // La clave sigue al contenido, no al intento: volver a tocar enviar tras
      // un tiempo agotado repite la misma petición en vez de crear otro pedido.
      const fingerprint = buildAppendItemsFingerprint(
        currentOrder?.id ?? `new:${selectedTableId}`,
        items,
      );
      const prior = sendAttemptRef.current;
      const idempotencyKey = prior && prior.fingerprint === fingerprint
        ? prior.key
        : newIdempotencyKey();
      sendAttemptRef.current = { fingerprint, key: idempotencyKey };

      if (currentOrder?.id) {
        await api.post(`/api/orders/${currentOrder.id}/items`, { items },
          { headers: { 'Idempotency-Key': idempotencyKey } });
      } else {
        await api.post('/api/orders', {
          table_id: selectedTableId,
          customer_id: customerId,
          type: 'dine_in',
          items,
        }, { headers: { 'Idempotency-Key': idempotencyKey } });
      }
      // Solo una respuesta resuelta retira la clave.
      sendAttemptRef.current = null;
      setDraft([]);
      await loadOrder(selectedTableId);
      toast.success(t('orderSent'));
    } catch (error: unknown) {
      toastApiError(error, t('couldNotSendOrder'), apiErrorT);
    } finally {
      setSending(false);
    }
  }

  const activeTable = tables.find((table) => table.id === selectedTableId) || null;
  const filteredProducts = products.filter((product) => {
    const matchesCategory = selectedCategoryId === 'all' || product.category_id === selectedCategoryId;
    const matchesQuery = !query || product.name.toLowerCase().includes(query.toLowerCase());
    return matchesCategory && matchesQuery;
  });
  const draftTotal = draft.reduce((sum, line) => {
    const base = Number(line.product.price || 0) * line.quantity;
    const addonTotal = line.addons.reduce((aSum, a) => aSum + Number(a.price || 0) * (a.quantity || 1) * line.quantity, 0);
    return sum + base + addonTotal;
  }, 0);

  if (loading) {
    return <div className="flex h-screen items-center justify-center"><div className="h-10 w-10 rounded-full border-4 border-brand border-t-transparent animate-spin" /></div>;
  }

  if (disabled) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <Smartphone size={44} className="text-gray-400" />
        <h1 className="text-lg font-semibold text-gray-900">{t('disabledTitle')}</h1>
        <p className="max-w-sm text-sm text-gray-500">{t('disabledHint')}</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <form onSubmit={handleLogin} className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-6 text-center">
            <UserRound size={42} className="mx-auto mb-3 text-brand" />
            <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
            <p className="mt-1 text-sm text-gray-500">{t('loginSubtitle')}</p>
          </div>
          <div className="space-y-3">
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" dir="ltr" placeholder={t('emailPlaceholder')} required className="h-11 w-full rounded-lg border border-gray-300 px-3 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20" />
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder={tAuth('password')} required className="h-11 w-full rounded-lg border border-gray-300 px-3 text-sm focus:border-brand focus:outline-none" />
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} className="rounded border-gray-300 text-brand focus:ring-brand" />
              {tAuth('rememberMe')}
            </label>
            <button disabled={loginLoading} className="h-11 w-full rounded-lg bg-brand font-semibold text-white disabled:opacity-60">
              {loginLoading ? tAuth('signingIn') : tAuth('signIn')}
            </button>
          </div>
          <p className="mt-4 text-center text-xs text-gray-500">{t('loginHint')}</p>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-gray-900">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 px-3 py-2 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-white"><ChefHat size={18} /></div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{t('title')}</h1>
            <p className="truncate text-xs text-gray-500">{activeTable ? t('tableLabel', { name: activeTable.name ?? String(activeTable.number) }) : t('selectTable')}</p>
          </div>
          <button onClick={() => loadAll().catch(() => toast.error(t('refreshFailed')))} className="rounded-lg border border-gray-200 p-2 text-gray-600"><RefreshCw size={17} /></button>
          <button onClick={logout} className="touch-target rounded-lg border border-gray-200 text-gray-600" aria-label={tNav('logout')}><LogOut size={17} /></button>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-3 p-3 lg:grid-cols-[220px_1fr_340px]">
        <section className="rounded-lg border border-gray-200 bg-white p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase text-gray-500">{t('tables')}</h2>
          <div className="grid grid-cols-3 gap-2 lg:grid-cols-1">
            {tables.map((table) => {
              const selected = table.id === selectedTableId;
              const order = table.activeOrder || table.current_order;
              return (
                <button key={table.id} onClick={() => setSelectedTableId(table.id)}
                  className={`min-h-14 rounded-lg border px-2 py-2 text-start ${selected ? 'border-brand bg-brand/5' : 'border-gray-200 bg-white'}`}>
                  <span className="block truncate text-sm font-semibold">{table.name || table.number}</span>
                  <span className="text-xs text-gray-500">{order ? t('openOrder') : tTables('statusAvailable')}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-3">
          <div className="mb-3 flex gap-2">
            <div className="relative flex-1">
              <Search size={16} className="absolute start-3 top-3 text-gray-400" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('searchMenu')} className="h-10 w-full rounded-lg border border-gray-200 ps-9 pe-3 text-sm focus:border-brand focus:outline-none" />
            </div>
          </div>
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            <button onClick={() => setSelectedCategoryId('all')} className={`h-9 shrink-0 rounded-lg px-3 text-sm ${selectedCategoryId === 'all' ? 'bg-brand text-white' : 'bg-gray-100 text-gray-700'}`}>{tOrders('all')}</button>
            {categories.map((category) => (
              <button key={category.id} onClick={() => setSelectedCategoryId(category.id)}
                className={`h-9 shrink-0 rounded-lg px-3 text-sm ${selectedCategoryId === category.id ? 'bg-brand text-white' : 'bg-gray-100 text-gray-700'}`}>
                {category.name}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {filteredProducts.map((product) => (
              <button key={product.id} onClick={() => handleProductClick(product)}
                className="min-h-24 rounded-lg border border-gray-200 bg-white p-3 text-start hover:border-brand">
                <span className="line-clamp-2 text-sm font-semibold">{product.name}</span>
                <span className="mt-2 block text-sm text-gray-500"><Ltr>{fmt(Number(product.price))}</Ltr></span>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-3 lg:sticky lg:top-16 lg:self-start">
          <h2 className="text-sm font-semibold">{t('currentTicket')}</h2>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder={t('customerNamePlaceholder')} className="h-10 rounded-lg border border-gray-200 px-3 text-sm focus:border-brand focus:outline-none" />
            <input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} dir="ltr" placeholder={t('phonePlaceholder')} className="h-10 rounded-lg border border-gray-200 px-3 text-sm focus:border-brand focus:outline-none" />
          </div>

          {currentOrder?.items && currentOrder.items.length > 0 && (
            <div className="mt-4 border-t border-gray-100 pt-3">
              <p className="mb-2 text-xs font-semibold uppercase text-gray-500">{t('kitchen')}</p>
              <div className="space-y-2">
                {currentOrder.items.map((item) => (
                  <div key={item.id} className="flex items-center gap-2 text-sm">
                    {itemStatusIcon(item.status, t)}
                    <span className="min-w-0 flex-1 truncate"><Ltr>{item.quantity}</Ltr> x {item.product_name}
                      {item.addons && item.addons.length > 0 && (
                        <div className="mt-1 flex flex-col gap-0.5">
                          {item.addons.map((addon) => (
                            <span key={addon.id ?? addon.name} className="text-xs text-gray-500">
                              +{addon.name}{addon.price ? ` (${fmt(Number(addon.price))})` : ''}{addon.quantity && addon.quantity > 1 ? ` ×${addon.quantity}` : ''}
                            </span>
                          ))}
                        </div>
                      )}
                      {item.special_instructions && (
                        <div className="mt-0.5 text-xs italic text-gray-500">“{item.special_instructions}”</div>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4 border-t border-gray-100 pt-3">
            <p className="mb-2 text-xs font-semibold uppercase text-gray-500">{t('newItems')}</p>
            {draft.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-400">{t('emptyDraft')}</p>
            ) : (
              <div className="space-y-3">
                {draft.map((line) => (
                  <div key={line.id} className="rounded-lg border border-gray-100 p-2">
                    <div className="flex items-center gap-2">
                      <button onClick={() => handleEditLine(line)} className="min-h-11 min-w-0 flex-1 truncate text-start text-sm font-medium hover:underline">{line.product.name}</button>
                      <button onClick={() => setDraft((lines) => lines.filter((draftLine) => draftLine.id !== line.id))} className="touch-target rounded-md border border-gray-200" aria-label={tPos('remove')}><Trash2 size={16} /></button>
                      <button onClick={() => changeQty(line.id, -1)} className="touch-target rounded-md border border-gray-200" aria-label={tPos('remove')}><Minus size={16} /></button>
                      <span className="w-6 text-center text-sm font-semibold"><Ltr>{line.quantity}</Ltr></span>
                      <button onClick={() => changeQty(line.id, 1)} className="touch-target rounded-md border border-gray-200" aria-label={tPos('addItems')}><Plus size={16} /></button>
                    </div>
                    {line.addons && line.addons.length > 0 && (
                      <div className="mt-1 flex flex-col gap-0.5">
                        {line.addons.map((addon) => (
                          <span key={addon.id ?? addon.name} className="text-xs text-gray-500">
                            +{addon.name}{addon.price ? ` (${fmt(Number(addon.price))})` : ''}{addon.quantity && addon.quantity > 1 ? ` ×${addon.quantity}` : ''}
                          </span>
                        ))}
                      </div>
                    )}
                    {line.note && (
                      <div className="mt-1 text-xs italic text-gray-500">{line.note}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3">
            <span className="text-sm text-gray-500">{t('draftTotal')}</span>
            <span className="text-lg font-bold"><Ltr>{fmt(draftTotal)}</Ltr></span>
          </div>
          <button onClick={sendDraft} disabled={!selectedTableId || draft.length === 0 || sending}
            className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand font-semibold text-white disabled:opacity-50">
            <Send size={17} />
            {sending ? t('sending') : currentOrder ? t('addToOrder') : t('sendToKitchen')}
          </button>
        </section>
      </main>

      {addonProduct && (
        <AddonModal
          key={addonProduct.id}
          product={addonProduct}
          currency={useAuthStore.getState().currentTenant?.currency || ''}
          onAdd={handleAddonAdd}
          onClose={() => { setAddonProduct(null); setEditingLineId(null); }}
          mode={editingLineId ? 'edit' : 'add'}
          initialQuantity={editingLineId ? draft.find((l) => l.id === editingLineId)?.quantity : undefined}
          initialAddons={editingLineId ? draft.find((l) => l.id === editingLineId)?.addons : undefined}
          initialInstructions={editingLineId ? draft.find((l) => l.id === editingLineId)?.note : undefined}
          submitLabel={editingLineId ? undefined : (total: string) => `${t('addToOrder')} - ${total}`}
        />
      )}
    </div>
  );
}
