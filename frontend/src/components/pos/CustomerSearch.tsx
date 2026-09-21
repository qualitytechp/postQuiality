'use client';

import { useState, useRef, useEffect, useId } from 'react';
import api from '@/lib/api';
import { useCartStore } from '@/store/cart';
import { X, Pencil, Gift, Search, UserPlus, User } from 'lucide-react';
import type { Customer } from '@/lib/types';
import EditCustomerModal from './EditCustomerModal';
import CreateCustomerModal from './CreateCustomerModal';
import { Ltr } from '@/components/layout/Ltr';

import { useTranslations } from 'use-intl';

interface Props {
  /** Permite al POS enfocar la búsqueda con Ctrl+C sin montar otro campo. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

const TAG_COLORS: Record<string, string> = {
  veg:    'bg-green-100 text-green-700',
  nonveg: 'bg-red-100 text-red-700',
  vegan:  'bg-emerald-100 text-emerald-700',
  spicy:  'bg-orange-100 text-orange-700',
};

function tagColor(tag: string) {
  return TAG_COLORS[tag.toLowerCase()] ?? 'bg-muted text-muted-foreground';
}

function TagBadges({ counts }: { counts: Record<string, number> }) {
  const t = useTranslations('pos');
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([tag, count]) => (
        <span key={tag} className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${tagColor(tag)}`}>
          {t('tagCount', { tag, count })}
        </span>
      ))}
    </div>
  );
}

export default function CustomerSearch({ inputRef }: Props = {}) {
  const cart = useCartStore();
  const t = useTranslations('pos');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [editingCustomer, setEditingCustomer] = useState(false);
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [loyaltyPoints, setLoyaltyPoints] = useState<number | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const requestAbortRef = useRef<AbortController | null>(null);
  const fallbackInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = inputRef ?? fallbackInputRef;

  const customer = cart.customer;
  const trimmedQuery = query.trim();
  // Two instances can be mounted at once (the topbar plus a payment modal's
  // inline picker), so the id must not collide across them.
  const listboxId = `pos-customer-results-${useId()}`;

  // Reset stale points synchronously during render when customer changes
  // to avoid flashing previous customer's loyalty balance.
  const [syncedCustomerId, setSyncedCustomerId] = useState(customer?.id ?? null);
  if ((customer?.id ?? null) !== syncedCustomerId) {
    setSyncedCustomerId(customer?.id ?? null);
    setLoyaltyPoints(null);
  }

  useEffect(() => {
    if (!customer) return;
    const controller = new AbortController();
    api.get(`/customers/${customer.id}/wallet`, { signal: controller.signal })
      .then((res) => setLoyaltyPoints(res.data.balance))
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) return;
        setLoyaltyPoints(null);
      });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.id]);

  useEffect(() => {
    if (cart.customerId && !cart.customer) {
      const controller = new AbortController();
      api.get(`/customers/${cart.customerId}`, { signal: controller.signal })
        .then(res => cart.setCustomer(res.data.customer))
        .catch(() => {});
      return () => controller.abort();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.customerId]);

  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
      requestAbortRef.current?.abort();
    };
  }, []);

  const resetSearch = () => {
    clearTimeout(debounceRef.current);
    requestAbortRef.current?.abort();
    setQuery('');
    setResults([]);
    setSearched(false);
    setSearching(false);
    setOpen(false);
    setActiveIndex(0);
  };

  const handleQueryChange = (value: string) => {
    setQuery(value);
    setActiveIndex(0);
    setOpen(true);
    clearTimeout(debounceRef.current);
    requestAbortRef.current?.abort();

    // Mismo mínimo que exige el backend: por debajo de 2 caracteres no vale
    // la pena consultar.
    if (value.trim().length < 2) {
      setResults([]);
      setSearched(false);
      setSearching(false);
      return;
    }

    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      requestAbortRef.current = controller;
      try {
        const { data } = await api.get(`/customers-search?q=${encodeURIComponent(value.trim())}`, { signal: controller.signal });
        setResults(Array.isArray(data) ? data : (data.customers || []));
      } catch (err: unknown) {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) return;
        setResults([]);
      } finally {
        if (!controller.signal.aborted) {
          setSearching(false);
          setSearched(true);
        }
      }
    }, 250);
  };

  const handleSelect = (selected: Customer) => {
    cart.setCustomer(selected);
    resetSearch();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      resetSearch();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (results.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setActiveIndex((current) => {
        const next = e.key === 'ArrowDown' ? current + 1 : current - 1;
        return (next + results.length) % results.length;
      });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const active = results[activeIndex];
      if (active) handleSelect(active);
      // Nada que elegir y algo tecleado: el cajero ya escribió la cédula, así
      // que el siguiente paso obvio es darla de alta con ese dato.
      else if (searched && trimmedQuery.length >= 2) setCreatingCustomer(true);
    }
  };

  // Cerrar sólo cuando el foco abandona el widget entero: pasar del campo a un
  // resultado no puede plegar la lista antes de que el clic llegue.
  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setOpen(false);
  };

  const secondaryLine = (c: Customer) => [c.document, c.phone].filter(Boolean).join(' · ');

  const hasTags = Boolean(customer?.tag_counts && Object.keys(customer.tag_counts).length > 0);

  // ── Cliente ya asignado a la venta ─────────────────────────────────────────
  if (customer) {
    return (
      <>
        <div className="min-h-11 flex items-center gap-2 px-3 bg-brand-light rounded-lg min-w-0 w-full border border-brand/20">
          <User size={16} className="text-brand shrink-0" />
          <button
            onClick={() => setEditingCustomer(true)}
            title={t('editCustomer')}
            className="touch-target flex-1 min-w-0 justify-start gap-x-2 flex-wrap text-start"
          >
            <span className="font-semibold text-brand text-sm truncate">{customer.name}</span>
            {customer.document && (
              <span className="text-brand/70 text-xs shrink-0"><Ltr>{customer.document}</Ltr></span>
            )}
            {customer.phone && (
              <span className="text-brand/60 text-xs shrink-0 hidden sm:inline"><Ltr>{customer.phone}</Ltr></span>
            )}
            <Pencil size={13} className="text-brand/60 shrink-0" />
            {!!loyaltyPoints && loyaltyPoints > 0 && (
              <span className="flex items-center gap-0.5 text-xs font-medium text-brand bg-card/70 rounded-full px-1.5 py-0.5 shrink-0">
                <Gift size={11} />
                {t('loyaltyPointsShort', { count: loyaltyPoints })}
              </span>
            )}
            {hasTags && <TagBadges counts={customer.tag_counts!} />}
          </button>
          <button
            onClick={() => cart.setCustomer(null)}
            className="touch-target rounded-full text-brand hover:text-brand-hover active:bg-card/60 shrink-0 ms-auto"
            aria-label={t('remove')}
          >
            <X size={16} />
          </button>
        </div>
        {editingCustomer && (
          <EditCustomerModal
            customer={customer}
            onClose={() => setEditingCustomer(false)}
            onSaved={(updated) => cart.setCustomer(updated)}
          />
        )}
      </>
    );
  }

  // ── Venta sin cliente: un solo campo, opcional ─────────────────────────────
  const showPanel = open && trimmedQuery.length >= 2;

  return (
    <>
      <div className="relative w-full min-w-0 max-w-md" onBlur={handleBlur}>
        <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          ref={searchInputRef}
          type="text"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={showPanel && results[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
          aria-label={t('selectCustomer')}
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setOpen(true)}
          placeholder={t('customerSearchPlaceholder')}
          className="h-10 w-full ps-9 pe-16 text-sm bg-background border border-border rounded-lg focus:ring-2 focus:ring-brand/30 focus:border-brand outline-none transition-colors"
        />
        {query ? (
          <button
            onClick={resetSearch}
            className="absolute end-2 top-1/2 -translate-y-1/2 touch-target rounded-full text-muted-foreground hover:text-foreground"
            aria-label={t('remove')}
          >
            <X size={15} />
          </button>
        ) : (
          <kbd className="absolute end-2.5 top-1/2 -translate-y-1/2 hidden md:block text-[10px] font-medium text-muted-foreground bg-muted border border-border rounded px-1.5 py-0.5 pointer-events-none">
            Ctrl+C
          </kbd>
        )}

        {showPanel && (
          <div className="absolute start-0 end-0 top-full mt-1 z-30 rounded-xl border border-border bg-card shadow-lg overflow-hidden">
            <ul id={listboxId} role="listbox" className="max-h-72 overflow-y-auto">
              {results.map((result, index) => (
                <li key={result.id} role="option" id={`${listboxId}-${index}`} aria-selected={index === activeIndex}>
                  <button
                    onClick={() => handleSelect(result)}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 text-start transition-colors ${
                      index === activeIndex ? 'bg-brand-light' : 'hover:bg-muted'
                    }`}
                  >
                    <span className="font-medium text-sm text-foreground truncate">{result.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      <Ltr>{secondaryLine(result)}</Ltr>
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {searching && results.length === 0 && (
              <p className="px-3 py-2.5 text-sm text-muted-foreground">{t('loadingEllipsis')}</p>
            )}
            {!searching && searched && results.length === 0 && (
              <p className="px-3 py-2.5 text-sm text-muted-foreground">{t('noCustomersFound')}</p>
            )}

            <button
              onClick={() => setCreatingCustomer(true)}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-sm font-medium text-brand border-t border-border hover:bg-brand-light transition-colors text-start"
            >
              <UserPlus size={15} className="shrink-0" />
              <span className="truncate">{t('addName', { name: trimmedQuery })}</span>
            </button>
          </div>
        )}
      </div>

      {creatingCustomer && (
        <CreateCustomerModal
          initialSearch={trimmedQuery}
          onClose={() => setCreatingCustomer(false)}
          onCreated={(created) => {
            setCreatingCustomer(false);
            handleSelect(created);
          }}
        />
      )}
    </>
  );
}
