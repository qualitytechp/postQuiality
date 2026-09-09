'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, LockOpen, X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import api from '@/lib/api';
import { parseCurrencyAmountInput } from '@/lib/currency-input';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { getCurrencyMinorUnitFactor } from '@/lib/countries';
import { useAuthStore } from '@/store/auth';
import { Ltr } from '@/components/layout/Ltr';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpened: () => void;
}

/** Registra el fondo de cambio con el que arranca el turno. */
export function OpenRegisterModal({ open, onOpenChange, onOpened }: Props) {
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const unitAdapter = useCurrencyUnitAdapter();
  const fmt = useFormatCurrency();
  const currency = useAuthStore((s) => s.currentTenant?.currency) ?? 'INR';
  const minorFactor = getCurrencyMinorUnitFactor(currency);

  const [floatInput, setFloatInput] = useState('');
  const [saving, setSaving] = useState(false);

  const parsed = parseCurrencyAmountInput(floatInput, unitAdapter.maxDecimals);
  // Un fondo vacío es un arranque legítimo en cero; sólo un texto inválido bloquea.
  const valid = floatInput.trim() === '' || (parsed !== null && parsed >= 0);
  const floatCents = parsed === null ? 0 : Math.round(unitAdapter.toStored(parsed) * minorFactor);

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await api.post('/cash-sessions', { opening_float_cents: floatCents });
      toast.success(t('openRegisterDone'));
      setFloatInput('');
      onOpenChange(false);
      onOpened();
    } catch {
      toast.error(tCommon('somethingWrong'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LockOpen size={16} />
            {t('openRegisterTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <label htmlFor="opening-cash" className="block text-sm text-muted-foreground">
            {t('openRegisterFloat')}
          </label>
          <input
            id="opening-cash"
            type="text"
            inputMode="decimal"
            value={floatInput}
            onChange={(e) => setFloatInput(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30"
          />
          <p className="text-xs text-muted-foreground">{t('openRegisterHint')}</p>
          {floatInput.trim() !== '' && valid && (
            <p className="text-sm font-semibold text-foreground">
              <Ltr>{fmt(floatCents / minorFactor)}</Ltr>
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            <X size={14} />
            {tCommon('cancel')}
          </Button>
          <Button onClick={submit} disabled={saving || !valid}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <LockOpen size={14} />}
            {t('openRegister')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
