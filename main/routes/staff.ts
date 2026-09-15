/** Staff management API (alias for /api/users). */
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { getDatabase, now, withTxn } from '../db';
import { requireRole, validatePassword, authRateLimit, invalidateUserAuthCache } from '../middleware/security';
import { isValidEmail } from './auth';
import { ROLE_ACCESS, ROLE_KEYS, OPERATIONAL_ROLES, hasRole } from '../../shared/role-permissions';

const router = Router();

const VALID_ROLES: readonly string[] = ROLE_KEYS;
const STAFF_SELECT_FIELDS = 'id, name, email, role, (pin_hash IS NOT NULL) AS has_pin, is_active, created_at, updated_at';

/**
 * Every column across the schema that can hold a `users(id)` value — FK-backed
 * and purely logical alike. A hard-delete or merge is only as safe as this
 * list is complete: a table left out here keeps pointing at a row that no
 * longer exists after either operation.
 *
 * Kept as one explicit, reviewable list rather than derived from
 * `sqlite_master` — column names alone don't say whether a TEXT column means
 * "this is a user" (e.g. `merchant_print_templates.created_by`, no FK
 * constraint) versus something unrelated, so an automated scan would need
 * the same manual judgment call this list already makes.
 */
// Exported so tests/staff-merge.test.ts audits it against the live schema
// directly, instead of against a hand-copied list that could drift from it.
export const USER_REF_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  // FK-enforced.
  ['print_logs', 'user_id'],
  ['station_users', 'user_id'],
  ['refunds', 'approved_by'],
  ['refunds', 'created_by'],
  ['cash_closures', 'closed_by'],
  ['cash_closure_amendments', 'amended_by'],
  ['cash_sessions', 'opened_by'],
  ['saved_reports', 'user_id'],
  ['stock_movements', 'created_by'],
  ['purchases', 'created_by'],
  ['purchases', 'voided_by'],
  ['purchase_payments', 'created_by'],
  ['purchase_amendments', 'amended_by'],
  ['receivable_terms', 'created_by'],
  ['cartera_entries', 'created_by'],
  ['cartera_entries', 'voided_by'],
  ['general_payables', 'created_by'],
  ['general_payables', 'voided_by'],
  ['general_payable_payments', 'created_by'],
  ['orders', 'user_id'],
  // Logical references only — no FK constraint in the schema.
  ['order_idempotency', 'user_id'],
  ['payment_idempotency', 'user_id'],
  ['refund_idempotency', 'user_id'],
  ['tax_overrides', 'created_by_user_id'],
  ['tax_config_audit', 'actor_user_id'],
  ['whatsapp_messages', 'created_by_user_id'],
  ['whatsapp_blocklist', 'blocked_by_user_id'],
  ['merchant_print_templates', 'created_by'],
  ['merchant_print_templates', 'updated_by'],
];

/** Settings whose value is a user id (string), not a table column. */
export const USER_REF_SETTINGS_KEYS: readonly string[] = [
  'whatsapp_activated_by_user_id',
  'last_password_recovery_user_id',
  'last_owner_recovery_user_id',
];

function checkUserReferences(db: ReturnType<typeof getDatabase>, userId: string): string[] {
  return USER_REF_COLUMNS
    .filter(([table, column]) => {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(userId) as { n: number };
      return row.n > 0;
    })
    .map(([table, column]) => `${table}.${column}`);
}

function checkUserSettingsReferences(db: ReturnType<typeof getDatabase>, userId: string): string[] {
  if (USER_REF_SETTINGS_KEYS.length === 0) return [];
  const placeholders = USER_REF_SETTINGS_KEYS.map(() => '?').join(',');
  const rows = db.prepare(`SELECT key FROM settings WHERE value = ? AND key IN (${placeholders})`)
    .all(userId, ...USER_REF_SETTINGS_KEYS) as { key: string }[];
  return rows.map((row) => row.key);
}

function canModifyTargetStaff(requesterRole: string, targetRole: string): boolean {
  if (requesterRole === 'owner') return true;
  if (requesterRole === 'manager') return !hasRole(targetRole, ROLE_ACCESS.ownerManager);
  return false;
}

function isOperationalRole(role: string): boolean {
  return hasRole(role, OPERATIONAL_ROLES);
}

function hasNonEmptyPin(pin: unknown): boolean {
  return pin !== undefined && pin !== null && String(pin).length > 0;
}

function isValidPin(pin: unknown): boolean {
  return /^\d{4,6}$/.test(String(pin));
}

function normalizeStaffEmail(email: unknown): string {
  return String(email || '').trim().toLowerCase();
}

// ── List ──────────────────────────────────────────────────────────────────────

router.get('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let query = `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE 1=1`;
    const params: any[] = [];

    if (req.query.role) {
      if (typeof req.query.role !== 'string' || !VALID_ROLES.includes(req.query.role)) {
        return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
      }
      query += ' AND role = ?';
      params.push(req.query.role);
    }
    if (req.query.active === 'true') {
      query += ' AND is_active = 1';
    }
    if (req.query.active === 'false') {
      query += ' AND is_active = 0';
    }

    query += ' ORDER BY role, name';

    const staff = db.prepare(query).all(...params);
    res.json({ staff });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Get one ───────────────────────────────────────────────────────────────────

router.get('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const member = db.prepare(
      `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id = ?`
    ).get(req.params.id) as any;

    if (!member) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const performance = db.prepare(`
      SELECT COUNT(*) as orders_served, COALESCE(SUM(total), 0) as total_sales
      FROM orders
      WHERE user_id = ? AND date(created_at) = date('now')
    `).get(req.params.id);

    res.json({ staff: { ...member, performance } });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Create ────────────────────────────────────────────────────────────────────

router.post('/', requireRole(...ROLE_ACCESS.ownerManager), authRateLimit(), (req: Request, res: Response) => {
  try {
    const { name, email, password, role, pin } = req.body;
    const normalizedEmail = normalizeStaffEmail(email);

    if (!name || !normalizedEmail || !password || !role) {
      return res.status(400).json({ error: 'name, email, password, and role are required' });
    }
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.' });
    }

    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const requesterRole = (req as any).user.role;
    if (requesterRole === 'manager' && !isOperationalRole(role)) {
      return res.status(403).json({ error: `Managers can only create operational staff accounts (${OPERATIONAL_ROLES.join(', ')})` });
    }

    if (isOperationalRole(role) && hasNonEmptyPin(pin)) {
      return res.status(400).json({ error: 'PINs are only permitted for owner and manager roles' });
    }
    if (hasNonEmptyPin(pin) && !isValidPin(pin)) {
      return res.status(400).json({ error: 'PIN must be between 4 and 6 numeric digits' });
    }

    const db = getDatabase();

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) {
      return res.status(400).json({ error: 'Email already in use' });
    }

    const id = randomUUID();
    const hashedPassword = bcrypt.hashSync(password, 10);

    const hashedPin = hasNonEmptyPin(pin) ? bcrypt.hashSync(String(pin), 10) : null;

    db.prepare(`
      INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, name, normalizedEmail, hashedPassword, role, hashedPin, now(), now());

    const member = db.prepare(
      `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id = ?`
    ).get(id);

    res.status(201).json({ staff: member });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Update ────────────────────────────────────────────────────────────────────

router.put('/:id', requireRole(...ROLE_ACCESS.ownerManager), authRateLimit(), (req: Request, res: Response) => {
  try {
    const { name, email, password, role, pin, is_active } = req.body;
    const emailProvided = email !== undefined;
    const normalizedEmail = emailProvided ? normalizeStaffEmail(email) : undefined;
    const db = getDatabase();

    if (is_active !== undefined) {
      return res.status(400).json({ error: 'Use /deactivate or /reactivate endpoints to change account status' });
    }

    const member = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
    if (!member) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const requesterRole = (req as any).user.role;
    if (!canModifyTargetStaff(requesterRole, member.role)) {
      return res.status(403).json({ error: 'Managers cannot modify owner or manager accounts' });
    }

    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
      }
      if (role !== member.role && requesterRole !== 'owner') {
        return res.status(403).json({ error: 'Only owners can change roles' });
      }
    }

    const targetRole = role ?? member.role;
    if (isOperationalRole(targetRole) && hasNonEmptyPin(pin)) {
      return res.status(400).json({ error: 'PINs are only permitted for owner and manager roles' });
    }
    if (hasNonEmptyPin(pin) && !isValidPin(pin)) {
      return res.status(400).json({ error: 'PIN must be between 4 and 6 numeric digits' });
    }

    if (emailProvided && !normalizedEmail) {
      return res.status(400).json({ error: 'email is required' });
    }
    if (normalizedEmail && !isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
    if (normalizedEmail && normalizedEmail !== member.email) {
      const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(normalizedEmail, req.params.id);
      if (existing) {
        return res.status(400).json({ error: 'Email already in use' });
      }
    }

    if (password && !validatePassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.' });
    }

    const passwordChanged = Boolean(password && (!member.password || !bcrypt.compareSync(password, member.password)));
    const hashedPassword = passwordChanged
      ? bcrypt.hashSync(password, 10)
      : member.password;

    const pinChanged = isOperationalRole(targetRole)
      ? Boolean(member.pin_hash)
      : pin !== undefined && (
          hasNonEmptyPin(pin)
            ? (!member.pin_hash || !bcrypt.compareSync(String(pin), member.pin_hash))
            : Boolean(member.pin_hash)
        );

    const hashedPin = isOperationalRole(targetRole)
      ? null
      : pin !== undefined
        ? (hasNonEmptyPin(pin) ? (pinChanged ? bcrypt.hashSync(String(pin), 10) : member.pin_hash) : null)
        : member.pin_hash;

    // Revoke outstanding sessions only when credentials actually change.
    const credentialsChanged = passwordChanged || pinChanged;
    const tokensValidAfter = credentialsChanged ? now() : member.tokens_valid_after;

    const demotesActiveOwner = member.role === 'owner' && member.is_active === 1 && targetRole !== 'owner';
    const result = db.prepare(`
      UPDATE users SET
        name       = COALESCE(?, name),
        email      = COALESCE(?, email),
        password   = ?,
        role       = COALESCE(?, role),
        pin_hash   = ?,
        tokens_valid_after = ?,
        updated_at = ?
      WHERE id = ?
        AND (
          ? = 0
          OR (SELECT COUNT(*) FROM users WHERE role = 'owner' AND is_active = 1) > 1
        )
    `).run(
      name || null, normalizedEmail || null, hashedPassword,
      role || null, hashedPin, tokensValidAfter,
      now(), req.params.id, demotesActiveOwner ? 1 : 0,
    );
    if (result.changes === 0) {
      return res.status(400).json({ error: 'Cannot change the role of the last active owner. Create or promote another active owner first.' });
    }
    invalidateUserAuthCache(req.params.id as string);

    const updated = db.prepare(
      `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id = ?`
    ).get(req.params.id);

    res.json({ staff: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Staff are deactivated rather than hard-deleted to preserve order and print log references.
router.post('/:id/deactivate', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const member = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
    if (!member) return res.status(404).json({ error: 'Staff member not found' });
    if (member.is_active === 0) return res.status(400).json({ error: 'Already deactivated' });

    if (!canModifyTargetStaff((req as any).user.role, member.role)) {
      return res.status(403).json({ error: 'Managers cannot deactivate or reactivate owner or manager accounts' });
    }

    const changedAt = now();
    const result = db.prepare(`
      UPDATE users SET is_active = 0, tokens_valid_after = ?, updated_at = ?
      WHERE id = ? AND is_active = 1
        AND (role != 'owner' OR (SELECT COUNT(*) FROM users WHERE role = 'owner' AND is_active = 1) > 1)
    `).run(changedAt, changedAt, req.params.id);
    if (result.changes === 0) {
      return res.status(400).json({ error: 'Cannot deactivate the last owner account' });
    }
    invalidateUserAuthCache(req.params.id as string);
    const updated = db.prepare(
      `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id = ?`
    ).get(req.params.id);
    res.json({ staff: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/:id/reactivate', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const member = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any;
    if (!member) return res.status(404).json({ error: 'Staff member not found' });
    if (member.is_active === 1) return res.status(400).json({ error: 'Already active' });

    if (!canModifyTargetStaff((req as any).user.role, member.role)) {
      return res.status(403).json({ error: 'Managers cannot deactivate or reactivate owner or manager accounts' });
    }

    db.prepare('UPDATE users SET is_active = 1, updated_at = ? WHERE id = ?').run(now(), req.params.id);
    invalidateUserAuthCache(req.params.id as string);
    const updated = db.prepare(
      `SELECT ${STAFF_SELECT_FIELDS} FROM users WHERE id = ?`
    ).get(req.params.id);
    res.json({ staff: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Hard-delete ──────────────────────────────────────────────────────────────
//
// Deactivation above stays the everyday path — it's reversible and keeps every
// historical reference intact. This is the narrow escape hatch for a staff
// row that was created by mistake and never touched anything: owner-only,
// and refused outright the moment a single row anywhere references it.

router.delete('/:id', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const staffId = req.params.id as string;
    const db = getDatabase();
    const member = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(staffId) as any;
    if (!member) return res.status(404).json({ error: 'Staff member not found' });

    // A session mid-use loses its user row out from under it the instant the
    // auth cache is invalidated — the next request 401s with no way back in.
    if (staffId === (req as any).user?.userId) {
      return res.status(400).json({ error: 'Cannot permanently delete your own account while signed in' });
    }

    if (member.role === 'owner') {
      const activeOwners = (db.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND is_active = 1"
      ).get() as { n: number }).n;
      if (activeOwners <= 1) {
        return res.status(400).json({ error: 'Cannot permanently delete the last active owner' });
      }
    }

    const referencingTables = checkUserReferences(db, staffId);
    if (referencingTables.length > 0) {
      return res.status(409).json({
        error: 'This staff member has movements on record and cannot be permanently deleted. Merge them into another staff member instead.',
        referencingTables,
      });
    }

    const referencingSettings = checkUserSettingsReferences(db, staffId);
    if (referencingSettings.length > 0) {
      return res.status(409).json({
        error: 'This staff member is referenced in settings and cannot be permanently deleted.',
        referencingSettings,
      });
    }

    // FK stays ON: if the reference sweep above missed something, the
    // constraint rejects the delete instead of silently orphaning a row.
    db.prepare('DELETE FROM users WHERE id = ?').run(staffId);
    invalidateUserAuthCache(staffId);
    res.json({ deletedId: staffId });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Merge ────────────────────────────────────────────────────────────────────
//
// For the common case: a staff member left, but their orders, bills, and cash
// sessions are real history that has to keep resolving to *someone*. This
// reassigns every reference this schema knows about to the chosen target,
// then deletes the now-empty source row.

router.post('/:id/merge', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const sourceId = req.params.id as string;
    const targetId = typeof req.body?.merge_into === 'string' ? req.body.merge_into.trim() : '';

    if (!targetId) return res.status(400).json({ error: 'merge_into is required' });
    if (targetId === sourceId) return res.status(400).json({ error: 'merge_into must differ from the staff member being merged' });
    if (sourceId === (req as any).user?.userId) {
      return res.status(400).json({ error: 'Cannot merge your own account away while signed in' });
    }

    const db = getDatabase();

    const source = db.prepare('SELECT id, name, role, is_active FROM users WHERE id = ?').get(sourceId) as any;
    if (!source) return res.status(404).json({ error: 'Staff member to merge was not found' });
    if (source.is_active === 0) return res.status(400).json({ error: 'Deactivated staff cannot be merged — reactivate first' });

    const target = db.prepare('SELECT id, name, is_active FROM users WHERE id = ?').get(targetId) as any;
    if (!target) return res.status(404).json({ error: 'Target staff member was not found' });
    if (target.is_active === 0) return res.status(400).json({ error: 'Cannot merge into a deactivated staff member' });

    if (source.role === 'owner') {
      const otherActiveOwners = (db.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND is_active = 1 AND id != ?"
      ).get(sourceId) as { n: number }).n;
      if (otherActiveOwners === 0) {
        return res.status(400).json({ error: 'Cannot merge away the last active owner' });
      }
    }

    const movedTables: string[] = [];
    const movedSettings: string[] = [];

    withTxn(() => {
      // Every UPDATE moves rows onto an id that's already valid, so it clears
      // an immediate FK check on its own — no need to relax enforcement.
      // Ordering only matters for ON DELETE CASCADE columns (station_users,
      // saved_reports): reassigned here, they're gone from under sourceId
      // well before the DELETE, so no cascade ever fires.
      for (const [table, column] of USER_REF_COLUMNS) {
        const result = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(targetId, sourceId);
        if (result.changes > 0) movedTables.push(`${table}.${column} (${result.changes})`);
      }

      for (const key of USER_REF_SETTINGS_KEYS) {
        const result = db.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND value = ?')
          .run(targetId, now(), key, sourceId);
        if (result.changes > 0) movedSettings.push(key);
      }

      db.prepare('DELETE FROM users WHERE id = ?').run(sourceId);
    });

    invalidateUserAuthCache(sourceId);
    invalidateUserAuthCache(targetId);

    res.json({ mergedId: sourceId, targetId, movedTables, movedSettings });
  } catch (error: any) {
    // A moved row landing on something the target already owns (e.g. two
    // same-named saved reports) fails the batch cleanly — nothing partially
    // merges — and surfaces as a conflict instead of a bare 500.
    if (typeof error?.message === 'string' && /UNIQUE constraint failed|PRIMARY KEY/.test(error.message)) {
      return res.status(409).json({ error: 'Cannot merge: the target staff member already has a conflicting record (e.g. a saved report with the same name).' });
    }
    console.error('[API] Merge error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export const staffRoutes = router;
