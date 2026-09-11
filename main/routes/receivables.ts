/**
 * Receivables (fiado) list and due-date terms.
 *
 * Collecting a payment is deliberately not a route here — the frontend calls
 * the existing `POST /api/bills/:id/payment` directly. Adding a second path
 * to change a bill's balance is exactly the mistake this module exists to
 * avoid.
 */
import { Router, Request, Response } from 'express';
import { getDatabase, getSettingValue } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { listReceivables, setReceivableTerms, ReceivableError } from '../services/receivables';

const router = Router();

function tenantTimezone(): string {
  return getSettingValue('timezone') || 'Asia/Kolkata';
}

function handleError(res: Response, error: any) {
  if (error instanceof ReceivableError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  console.error('[API] Internal error:', error);
  return res.status(500).json({ error: 'Internal server error' });
}

router.get('/', requireRole(...ROLE_ACCESS.ownerManagerCashier), (_req: Request, res: Response) => {
  try {
    const { rows, summary } = listReceivables(getDatabase(), tenantTimezone());
    res.json({ receivables: rows, summary });
  } catch (error: any) {
    handleError(res, error);
  }
});

router.put('/:billId/terms', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const billId = Number(req.params.billId);
    if (!Number.isInteger(billId)) return res.status(400).json({ error: 'Invalid bill id' });
    setReceivableTerms(getDatabase(), billId, {
      due_date: String(req.body?.due_date || ''),
      notes: typeof req.body?.notes === 'string' ? req.body.notes.trim().slice(0, 500) || null : null,
      userId: String((req as any).user?.userId || ''),
    });
    res.json({ ok: true });
  } catch (error: any) {
    handleError(res, error);
  }
});

export { router as receivablesRoutes };
