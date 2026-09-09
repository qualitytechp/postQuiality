'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import api from '@/lib/api';

export type ReportView = 'table' | 'bars' | 'lines';

export interface ReportFilter {
  field: string;
  operator: string;
  value: string;
}

export interface ReportDefinition {
  measures: string[];
  dimensions: string[];
  filters: ReportFilter[];
  from: string;
  to: string;
  sort?: { key: string; direction: 'asc' | 'desc' };
}

export interface ReportColumn {
  id: string;
  kind: 'dimension' | 'measure';
  format?: 'money' | 'count' | 'duration';
}

export interface ReportRow {
  dimensions: Record<string, { key: string; label: string }>;
  values: Record<string, number>;
}

export interface ReportResult {
  rows: ReportRow[];
  totals: Record<string, number>;
  columns: ReportColumn[];
  allocated: boolean;
}

export interface ReportCatalog {
  dimensions: { id: string; level: 'bill' | 'item' }[];
  measures: { id: string; format: string }[];
  filterFields: { id: string; type: 'text' | 'number' | 'date'; level: string }[];
  operators: { id: string; types: string[] }[];
  limits: { maxDimensions: number };
}

export interface SavedReport {
  id: string;
  name: string;
  definition: ReportDefinition;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Abre con un reporte útil ya cargado: nadie aprende una herramienta desde la nada. */
function defaultDefinition(): ReportDefinition {
  const now = new Date();
  return {
    measures: ['gross_sales', 'bill_count', 'avg_ticket'],
    dimensions: ['category'],
    filters: [],
    from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: isoDate(now),
  };
}

/**
 * Estado único del generador. Todo lo demás es presentación.
 *
 * La consulta se relanza con retardo tras el último cambio y cancela la
 * anterior, así que arrastrar un control no dispara una petición por pulsación.
 */
export function useReportBuilder() {
  const [definition, setDefinition] = useState<ReportDefinition>(defaultDefinition);
  const [view, setView] = useState<ReportView>('table');
  const [catalog, setCatalog] = useState<ReportCatalog | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedReport[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const valid = definition.measures.length > 0;

  useEffect(() => {
    api.get('/reports/catalog')
      .then((res) => setCatalog(res.data))
      .catch(() => setCatalog(null));
  }, []);

  const refreshSaved = useCallback(() => {
    api.get('/reports/saved')
      .then((res) => setSaved(res.data.reports ?? []))
      .catch(() => setSaved([]));
  }, []);

  useEffect(() => { refreshSaved(); }, [refreshSaved]);

  useEffect(() => {
    // Sin medidas no hay consulta que lanzar; el resultado se filtra al
    // exponerlo, en vez de limpiarlo desde el efecto.
    if (!valid) return;
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      api.post('/reports/query', definition, { signal: controller.signal })
        .then((res) => setResult(res.data))
        .catch((err) => {
          if (axios.isCancel(err) || err?.name === 'CanceledError') return;
          setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : 'Error');
        })
        .finally(() => {
          if (abortRef.current === controller) setLoading(false);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [definition, valid]);

  const maxDimensions = catalog?.limits.maxDimensions ?? 2;

  const toggleMeasure = useCallback((id: string) => {
    setDefinition((d) => ({
      ...d,
      measures: d.measures.includes(id) ? d.measures.filter((m) => m !== id) : [...d.measures, id],
    }));
  }, []);

  const toggleDimension = useCallback((id: string) => {
    setDefinition((d) => {
      if (d.dimensions.includes(id)) {
        return { ...d, dimensions: d.dimensions.filter((x) => x !== id) };
      }
      if (d.dimensions.length >= maxDimensions) return d;
      return { ...d, dimensions: [...d.dimensions, id] };
    });
  }, [maxDimensions]);

  const setPeriod = useCallback((from: string, to: string) => {
    setDefinition((d) => ({ ...d, from, to }));
  }, []);

  const addFilter = useCallback(() => {
    setDefinition((d) => ({ ...d, filters: [...d.filters, { field: 'order_type', operator: 'eq', value: '' }] }));
  }, []);

  const updateFilter = useCallback((index: number, next: ReportFilter) => {
    setDefinition((d) => ({ ...d, filters: d.filters.map((f, i) => (i === index ? next : f)) }));
  }, []);

  const removeFilter = useCallback((index: number) => {
    setDefinition((d) => ({ ...d, filters: d.filters.filter((_, i) => i !== index) }));
  }, []);

  const sortBy = useCallback((key: string) => {
    setDefinition((d) => ({
      ...d,
      sort: d.sort?.key === key
        ? { key, direction: d.sort.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'desc' },
    }));
  }, []);

  const exportCsv = useCallback(async () => {
    const res = await api.post('/reports/query.csv', definition, { responseType: 'blob' });
    const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `reporte-${definition.from}_${definition.to}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [definition]);

  const saveView = useCallback(async (name: string) => {
    await api.post('/reports/saved', { name, definition });
    refreshSaved();
  }, [definition, refreshSaved]);

  const loadView = useCallback((report: SavedReport) => {
    setDefinition(report.definition);
  }, []);

  const deleteView = useCallback(async (id: string) => {
    await api.delete(`/reports/saved/${id}`);
    refreshSaved();
  }, [refreshSaved]);

  // Sólo las medidas pedidas se pintan, en el orden en que se eligieron.
  const columns = useMemo(() => result?.columns ?? [], [result]);

  return {
    definition, view, setView, catalog, columns,
    result: valid ? result : null,
    loading, error, valid, maxDimensions, saved,
    toggleMeasure, toggleDimension, setPeriod,
    addFilter, updateFilter, removeFilter, sortBy,
    exportCsv, saveView, loadView, deleteView,
  };
}

export type ReportBuilderModel = ReturnType<typeof useReportBuilder>;
