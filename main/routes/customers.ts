import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import { getDatabase, now, getSettingValue } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { parsePhoneE164, stripPhoneDigits } from '../lib/phone';

export function parseCustomer(c: any): any {
  if (!c) return c;
  return {
    ...c,
    tag_counts: c.tag_counts ? (() => { try { return JSON.parse(c.tag_counts); } catch { return null; } })() : null,
  };
}

const router = Router();
const customerReadRateLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
const customerWriteRateLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

/**
 * Every table that can hold a `customers(id)` value. A permanent delete is
 * only as safe as this list is complete — the same pattern as staff
 * hard-delete (main/routes/staff.ts), audited against the schema the same
 * way: `whatsapp_messages.customer_id` is FK-enforced (kept as a backstop
 * below), the rest are logical references with no FK constraint.
 */
export const CUSTOMER_REF_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['orders', 'customer_id'],
  ['bills', 'customer_id'],
  ['held_orders', 'customer_id'],
  ['loyalty_ledger', 'customer_id'],
  ['whatsapp_messages', 'customer_id'],
];

function checkCustomerReferences(db: ReturnType<typeof getDatabase>, customerId: string): string[] {
  return CUSTOMER_REF_COLUMNS
    .filter(([table, column]) => {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(customerId) as { n: number };
      return row.n > 0;
    })
    .map(([table, column]) => `${table}.${column}`);
}

function invalidPhonePredicate(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}is_active = 1 AND ${prefix}phone IS NOT NULL AND ${prefix}phone != '' AND ${prefix}phone != '+' || ${prefix}phone_digits`;
}

/**
 * Misma normalización que la columna generada `document_digits`, para que una
 * cédula tecleada con puntos encuentre a quien quedó guardado sin ellos.
 */
function documentKey(value: string | null | undefined): string {
  return String(value || '').replace(/[+\s\-().]/g, '');
}

function findCustomerByDocument(db: ReturnType<typeof getDatabase>, document: string): any {
  const key = documentKey(document);
  if (!key) return null;
  return db.prepare(`
    SELECT *
    FROM customers
    WHERE document_digits = ?
    ORDER BY is_active DESC, created_at ASC, id ASC
    LIMIT 1
  `).get(key);
}

function findCustomerByCanonicalOrLegacyPhone(db: ReturnType<typeof getDatabase>, finalPhone: string, originalPhone: string): any {
  const canonicalDigits = stripPhoneDigits(finalPhone);
  const legacyDigits = stripPhoneDigits(originalPhone);
  const candidates = Array.from(new Set([canonicalDigits, legacyDigits].filter(Boolean)));

  if (candidates.length === 0) return null;
  return db.prepare(`
    SELECT *
    FROM customers
    WHERE phone_digits IN (${candidates.map(() => '?').join(',')})
    ORDER BY is_active DESC, created_at ASC, id ASC
    LIMIT 1
  `).get(...candidates);
}

export function getWalletBalance(customerId: string | number | null): number {
  if (!customerId) return 0;
  const db = getDatabase();
  const credits = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger
    WHERE customer_id = ? AND type = 'credit'
  `).get(customerId) as { total: number };

  const debits = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger
    WHERE customer_id = ? AND type = 'debit'
  `).get(customerId) as { total: number };

  return Math.max(0, credits.total - debits.total);
}

// Cleanup endpoint: delete all customers with null IDs - must be before /:id
router.delete('/admin/cleanup', customerWriteRateLimit, requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const result = db.prepare("DELETE FROM customers WHERE id IS NULL").run();
    res.json({ message: `Deleted ${result.changes} customers with null IDs` });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/admin/repair-phones', customerWriteRateLimit, requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const tenantCountry = getSettingValue('country') || 'IN';
    const customers = db.prepare(`
      SELECT id, phone, country_code
      FROM customers
      WHERE ${invalidPhonePredicate()}
    `).all() as Array<{ id: string; phone: string; country_code: string | null }>;

    let normalizedCount = 0;
    let unparseableCount = 0;
    let conflictedCount = 0;

    for (const c of customers) {
      const parsed = parsePhoneE164(c.phone, tenantCountry);
      if (parsed) {
        const phoneDigits = stripPhoneDigits(parsed.e164);
        const conflict = db.prepare('SELECT id FROM customers WHERE phone_digits = ? AND id != ?').get(phoneDigits, c.id) as any;
        if (conflict) {
          conflictedCount++;
        } else {
          db.prepare('UPDATE customers SET phone = ?, country_code = ?, updated_at = ? WHERE id = ?')
            .run(parsed.e164, parsed.countryCode, now(), c.id);
          normalizedCount++;
        }
      } else {
        unparseableCount++;
      }
    }

    res.json({
      totalScanned: customers.length,
      normalizedCount,
      unparseableCount,
      conflictedCount,
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/alerts', customerReadRateLimit, requireRole(...ROLE_ACCESS.sales), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const result = db.prepare(`
      SELECT COUNT(*) as count 
      FROM customers 
      WHERE ${invalidPhonePredicate()}
    `).get() as { count: number };
    
    res.json({ invalidPhonesCount: result.count });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/', customerReadRateLimit, requireRole(...ROLE_ACCESS.sales), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    // Aggregate customer order and wallet stats using CTEs and indexes.
    let query = `
      WITH order_stats AS (
        SELECT customer_id,
          COUNT(*) AS visits_count,
          COALESCE(SUM(total), 0) AS total_spent,
          MAX(created_at) AS last_visit_at
        FROM orders
        WHERE customer_id IS NOT NULL
        GROUP BY customer_id
      ),
      ledger_credits AS (
        SELECT customer_id, COALESCE(SUM(amount), 0) AS credits
        FROM loyalty_ledger
        WHERE type = 'credit'
        GROUP BY customer_id
      ),
      ledger_debits AS (
        SELECT customer_id, COALESCE(SUM(amount), 0) AS debits
        FROM loyalty_ledger
        WHERE type = 'debit'
        GROUP BY customer_id
      )
      SELECT c.*,
        COALESCE(os.visits_count, 0) as visits_count,
        COALESCE(os.total_spent, 0) as total_spent,
        MAX(0, COALESCE(lc.credits, 0) - COALESCE(ld.debits, 0)) as wallet_balance,
        os.last_visit_at
      FROM customers c
      LEFT JOIN order_stats os ON os.customer_id = c.id
      LEFT JOIN ledger_credits lc ON lc.customer_id = c.id
      LEFT JOIN ledger_debits ld ON ld.customer_id = c.id
      WHERE c.is_active = 1
    `;
    const params: any[] = [];

    if (req.query.search) {
      const rawSearch = String(req.query.search || '').trim();
      const digitsSearch = stripPhoneDigits(rawSearch);
      const isPhoneLikeSearch = digitsSearch.length > 0 && !/\p{L}/u.test(rawSearch);
      const search = `%${rawSearch}%`;
      const phoneDigitsSearch = `REPLACE(c.phone_digits, '/', '')`;

      if (isPhoneLikeSearch) {
        query += ` AND (c.name LIKE ? OR ${phoneDigitsSearch} LIKE ? OR c.document_digits LIKE ? OR c.email LIKE ?)`;
        params.push(search, `%${digitsSearch}%`, `%${digitsSearch}%`, search);
      } else {
        query += ' AND (c.name LIKE ? OR c.email LIKE ? OR c.document LIKE ?)';
        params.push(search, search, search);
      }
    }

    if (req.query.filter === 'invalid_phones') {
      query += ` AND (${invalidPhonePredicate('c')})`;
    }

    const sortField = (req.query.sort as string) || 'name';
    const sortOrder = (req.query.order as string) === 'desc' ? 'DESC' : 'ASC';
    
    const allowedSortFields: Record<string, string> = {
      name: 'c.name COLLATE NOCASE',
      phone: 'c.phone_digits',
      visits: 'visits_count',
      spent: 'total_spent',
      loyalty: 'wallet_balance',
      last_visit: 'last_visit_at'
    };

    const orderBy = allowedSortFields[sortField] || 'c.name COLLATE NOCASE';
    query += ` ORDER BY ${orderBy} ${sortOrder}`;

    if (req.query.per_page !== undefined) {
      const rawPerPage = String(req.query.per_page).trim();
      if (!/^\d+$/.test(rawPerPage)) {
        return res.status(400).json({ error: 'Invalid per_page parameter. Must be a positive integer.' });
      }
      const parsed = parseInt(rawPerPage, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return res.status(400).json({ error: 'Invalid per_page parameter. Must be a positive integer.' });
      }
      const limit = Math.min(parsed, 500);
      query += ` LIMIT ${limit}`;
    } else {
      // Default to 200 customers when per_page is omitted.
      query += ` LIMIT 200`;
    }

    const customers = db.prepare(query).all(...params);
    res.json({ data: customers });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/:id', customerReadRateLimit, requireRole(...ROLE_ACCESS.sales), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const customerRaw = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!customerRaw) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    const customer = parseCustomer(customerRaw);

    const walletBalance = getWalletBalance(req.params.id as string);
    const loyaltyHistory = db.prepare(`
      SELECT * FROM loyalty_ledger WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50
    `).all(req.params.id);

    const recentOrders = db.prepare(`
      SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10
    `).all(req.params.id);

    res.json({ customer: { ...customer, walletBalance, loyaltyHistory, recentOrders } });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/:id/wallet', customerReadRateLimit, requireRole(...ROLE_ACCESS.sales), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const customerId = req.params.id as string;
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const balance = getWalletBalance(customerId);
    const transactions = db.prepare(`
      SELECT * FROM loyalty_ledger WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(customerId);

    const bills = db.prepare(`
      SELECT
        b.id, b.bill_number, b.total, b.payment_status, b.paid_at, b.created_at,
        COALESCE((SELECT SUM(amount) FROM loyalty_ledger WHERE bill_id = b.id AND type = 'credit'), 0) as points_earned,
        COALESCE((SELECT SUM(amount) FROM loyalty_ledger WHERE bill_id = b.id AND type = 'debit'), 0) as points_redeemed
      FROM bills b
      WHERE b.customer_id = ? AND b.payment_status = 'paid'
      ORDER BY COALESCE(b.paid_at, b.created_at) DESC
      LIMIT 100
    `).all(customerId);

    const totals = db.prepare(`
      SELECT
        COALESCE((SELECT SUM(total) FROM bills WHERE customer_id = ? AND payment_status = 'paid'), 0) as total_spent,
        COALESCE((SELECT SUM(amount) FROM loyalty_ledger WHERE customer_id = ? AND type = 'credit'), 0) as total_points_earned,
        COALESCE((SELECT SUM(amount) FROM loyalty_ledger WHERE customer_id = ? AND type = 'debit'), 0) as total_points_redeemed
    `).get(customerId, customerId, customerId) as { total_spent: number; total_points_earned: number; total_points_redeemed: number };

    res.json({
      balance,
      transactions,
      bills,
      summary: {
        totalSpent: totals.total_spent,
        totalPointsEarned: totals.total_points_earned,
        totalPointsRedeemed: totals.total_points_redeemed,
      },
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/', customerWriteRateLimit, requireRole(...ROLE_ACCESS.sales), (req: Request, res: Response) => {
  try {
    const { phone, name, email, address, notes, country_code, document } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const finalDocument = document ? String(document).trim() || null : null;

    const db = getDatabase();

    const originalPhone = phone ? String(phone).trim() : '';
    let finalPhone = originalPhone || null;
    let finalCountryCode = country_code ? String(country_code).trim() : null;

    if (finalPhone) {
      const tenantCountry = getSettingValue('country') || 'IN';
      const parsed = parsePhoneE164(finalPhone, tenantCountry);
      if (!parsed) {
        return res.status(400).json({ message: 'Phone number is not valid. Use international format (e.g. +919876543210).' });
      }
      finalPhone = parsed.e164;
      finalCountryCode = parsed.countryCode;
    }

    // A quién identifica esta alta: el documento manda. Sólo cuando no lo hay
    // se cae al teléfono, que ya no es único — una familia comparte celular y
    // eso no puede impedir registrar a la segunda persona.
    const existing = finalDocument
      ? findCustomerByDocument(db, finalDocument)
      : (finalPhone ? findCustomerByCanonicalOrLegacyPhone(db, finalPhone, originalPhone) : null);

    if (existing) {
      if (existing.is_active === 0) {
        db.prepare(`
          UPDATE customers SET
            phone = COALESCE(?, phone),
            name = ?,
            email = ?,
            country_code = COALESCE(?, country_code),
            address = ?,
            notes = ?,
            document = COALESCE(?, document),
            is_active = 1,
            updated_at = ?
          WHERE id = ?
        `).run(
          finalPhone,
          String(name).trim(),
          email ? String(email).trim() : null,
          finalCountryCode,
          address ? String(address).trim() : null,
          notes ? String(notes).trim() : null,
          finalDocument,
          now(),
          existing.id
        );
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(existing.id);
        return res.status(201).json({ customer });
      }
      return res.status(409).json({
        message: finalDocument
          ? 'Customer with this ID document already exists'
          : 'Customer with this phone already exists',
        customer: parseCustomer(existing),
      });
    }

    const id = `cust-${randomUUID()}`;
    const timestamp = now();
    db.prepare(`
      INSERT INTO customers (id, phone, name, email, country_code, address, notes, document, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      finalPhone,
      String(name).trim(),
      email ? String(email).trim() : null,
      finalCountryCode,
      address ? String(address).trim() : null,
      notes ? String(notes).trim() : null,
      finalDocument,
      timestamp,
      timestamp
    );

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    res.status(201).json({ customer });
  } catch (error: any) {
    console.error('[Customer POST error]', error);
    res.status(500).json({ message: 'Failed to create customer' });
  }
});

router.put('/:id', customerWriteRateLimit, requireRole(...ROLE_ACCESS.ownerManagerCashier), (req: Request, res: Response) => {
  try {
    const {
      phone, name, email, address, notes, country_code, document
    } = req.body;
    const db = getDatabase();

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id) as any;
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    let finalPhone: string | null = customer.phone;
    let finalCountryCode: string | null = customer.country_code;

    if (phone !== undefined) {
      if (phone === null || String(phone).trim() === '') {
        finalPhone = null;
        finalCountryCode = null;
      } else {
        const tenantCountry = getSettingValue('country') || 'IN';
        const parsed = parsePhoneE164(String(phone).trim(), tenantCountry);
        if (!parsed) {
          return res.status(400).json({ error: 'Phone number is not valid. Use international format (e.g. +919876543210).' });
        }
        finalPhone = parsed.e164;
        finalCountryCode = parsed.countryCode;
      }
    } else if (country_code !== undefined) {
      finalCountryCode = country_code ? String(country_code).trim() : null;
    }

    let finalName = customer.name;
    if (name !== undefined) {
      const trimmedName = String(name).trim();
      if (!trimmedName) {
        return res.status(400).json({ error: 'Name is required' });
      }
      finalName = trimmedName;
    }

    const finalEmail = email !== undefined ? (email ? String(email).trim() : null) : customer.email;
    const finalAddress = address !== undefined ? (address ? String(address).trim() : null) : customer.address;
    const finalNotes = notes !== undefined ? (notes ? String(notes).trim() : null) : customer.notes;
    const finalDocument = document !== undefined
      ? (document ? String(document).trim() || null : null)
      : customer.document;

    // El documento sí identifica: dos fichas con la misma cédula son la misma
    // persona partida en dos, y desde el POS ya no habría forma de distinguirlas.
    if (finalDocument && documentKey(finalDocument) !== documentKey(customer.document)) {
      const clash = db.prepare('SELECT id FROM customers WHERE document_digits = ? AND id != ?')
        .get(documentKey(finalDocument), req.params.id) as any;
      if (clash) {
        return res.status(409).json({ error: 'Customer with this ID document already exists' });
      }
    }

    db.prepare(`
      UPDATE customers SET
        phone = ?,
        name = ?,
        email = ?,
        country_code = ?,
        address = ?,
        notes = ?,
        document = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      finalPhone, finalName, finalEmail, finalCountryCode, finalAddress, finalNotes, finalDocument, now(), req.params.id
    );

    const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    res.json({ customer: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Hard-delete ──────────────────────────────────────────────────────────────
//
// A customer with any history — an order, a bill, a held order, a loyalty
// transaction, a WhatsApp message — is never deleted; that history has to
// keep resolving to someone. This is the narrow case: a record created by
// mistake (wrong document typed twice, a test entry) that never actually
// sold anything, so there is nothing downstream to protect.
router.delete('/:id', customerWriteRateLimit, requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const customerId = req.params.id as string;
    const db = getDatabase();
    const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(customerId) as any;
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const referencingTables = checkCustomerReferences(db, customerId);
    if (referencingTables.length > 0) {
      return res.status(409).json({
        error: 'This customer has orders, bills, or other activity on record and cannot be permanently deleted.',
        referencingTables,
      });
    }

    // FK stays ON: if the reference sweep above missed something, the
    // constraint rejects the delete instead of silently orphaning a row.
    db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
    res.json({ deletedId: customerId });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export const customerRoutes = router;
