'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { BookmarkPlus, Trash2 } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ReportBuilderModel } from '@/hooks/useReportBuilder';

/** Guarda la definición actual con un nombre y la vuelve a cargar. */
export function SavedReportsMenu({ model }: { model: ReportBuilderModel }) {
  const t = useTranslations('reports');
  const tCommon = useTranslations('common');
  const { saved, saveView, loadView, deleteView } = model;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await saveView(trimmed);
      toast.success(t('savedDone'));
      setName('');
      setOpen(false);
    } catch {
      toast.error(tCommon('somethingWrong'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {saved.map((report) => (
          <span key={report.id} className="flex items-center overflow-hidden rounded-full border border-border bg-card">
            <button
              type="button"
              onClick={() => loadView(report)}
              className="min-h-9 px-3 text-sm text-foreground hover:text-brand"
            >
              {report.name}
            </button>
            <button
              type="button"
              onClick={() => { void deleteView(report.id); }}
              aria-label={t('deleteView')}
              className="min-h-9 border-s border-border px-2 text-muted-foreground hover:text-red-600"
            >
              <Trash2 size={13} />
            </button>
          </span>
        ))}
        <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="h-9">
          <BookmarkPlus size={14} />
          {t('saveView')}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('saveView')}</DialogTitle></DialogHeader>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            {t('saveName')}
            <input
              type="text"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-brand/30"
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>{tCommon('cancel')}</Button>
            <Button onClick={submit} disabled={busy || name.trim() === ''}>{t('saveView')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
