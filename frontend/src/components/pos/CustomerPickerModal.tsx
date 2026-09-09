'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Search, UserX, Plus, X } from 'lucide-react';
import api from '@/lib/api';
import { Ltr } from '@/components/layout/Ltr';
import CreateCustomerModal from './CreateCustomerModal';
import type { Customer } from '@/lib/types';

interface Props {
  title: string;
  description: string;
  onSelect: (customer: Customer) => void;
  onSkip: () => void;
  onClose: () => void;
}

/**
 * Búsqueda de cliente para cuando "Cliente obligatorio" está activo: un solo
 * campo de texto libre que busca por nombre, teléfono o documento a la vez
 * (el backend ya combina los tres en `/customers-search`), con una salida
 * explícita para ventas ocasionales — cerrar el diálogo por error no debe
 * ser la única forma de continuar sin cliente.
 */
export default function CustomerPickerModal({ title, description, onSelect, onSkip, onClose }: Props) {
  const t = useTranslations('pos');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [searching, setSearching] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    clearTimeout(debounceRef.current);
    abortRef.current?.abort();
  }, []);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    // Mismo mínimo que exige el backend: por debajo de 2 caracteres no vale
    // la pena consultar.
    if (value.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const { data } = await api.get(`/customers-search?q=${encodeURIComponent(value.trim())}`, { signal: controller.signal });
        setResults(Array.isArray(data) ? data : (data.customers || []));
      } catch (err: unknown) {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) return;
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  };

  if (showCreate) {
    return (
      <CreateCustomerModal
        initialSearch={query}
        onClose={() => setShowCreate(false)}
        onCreated={onSelect}
      />
    );
  }

  const trimmed = query.trim();
  const showEmptyState = trimmed.length >= 2 && !searching && results.length === 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-2xl w-full max-w-sm p-5 flex flex-col max-h-[85vh]">
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-lg font-bold text-foreground">{title}</h3>
          <button onClick={onClose} className="touch-target rounded-full text-gray-400 hover:text-muted-foreground active:bg-muted" aria-label={t('close')}>
            <X size={20} />
          </button>
        </div>
        <p className="text-sm text-muted-foreground mb-4">{description}</p>

        <div className="relative mb-3 shrink-0">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder={t('customerSearchPlaceholder')}
            className="w-full ps-9 pe-3 py-2.5 text-sm border border-border rounded-lg focus:ring-2 focus:ring-brand focus:border-brand outline-none"
          />
        </div>

        <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-1.5 min-h-[3rem]">
          {results.map((customer) => (
            <button
              key={customer.id}
              onClick={() => onSelect(customer)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2.5 bg-background rounded-lg border border-border hover:border-brand hover:bg-brand-light transition-colors text-start"
            >
              <span className="font-medium text-foreground truncate">{customer.name}</span>
              <span className="text-xs text-muted-foreground shrink-0">
                <Ltr>{customer.phone || customer.document || ''}</Ltr>
              </span>
            </button>
          ))}

          {showEmptyState && (
            <p className="text-sm text-muted-foreground text-center py-3">{t('noCustomersFound')}</p>
          )}
        </div>

        {trimmed.length >= 2 && (
          <button
            onClick={() => setShowCreate(true)}
            className="mt-2 w-full shrink-0 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium text-brand bg-card hover:bg-brand-light rounded-lg border border-dashed border-brand/40 transition-colors"
          >
            <Plus size={15} />
            {t('addCustomer')}
          </button>
        )}

        <div className="mt-4 pt-3 border-t border-border shrink-0">
          <button
            onClick={onSkip}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <UserX size={15} />
            {t('continueWithoutCustomer')}
          </button>
          <p className="text-xs text-muted-foreground text-center mt-1">{t('continueWithoutCustomerHint')}</p>
        </div>
      </div>
    </div>
  );
}
