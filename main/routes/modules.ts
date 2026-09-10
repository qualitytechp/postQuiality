/**
 * Which optional modules this business has turned on.
 *
 * One request answers for every module, so the renderer's navigation does not
 * grow another per-flag fetch on top of the three it already makes on mount.
 * Deliberately outside the module gate: asking what is on has to work when
 * everything is off.
 */
import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { getModuleStates } from '../services/modules';

const router = Router();

router.get('/', requireRole(...ROLE_ACCESS.allStaff), (_req: Request, res: Response) => {
  try {
    res.json({ modules: getModuleStates() });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as moduleRoutes };
