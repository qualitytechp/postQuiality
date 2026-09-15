# Plan: Borrado definitivo y fusion de usuarios (staff)

## Contexto

El usuario quiere dos capacidades nuevas en la pagina de staff (`/staff`):

1. **Borrar definitivamente** un usuario, pero **solo si no tiene movimientos/transacciones**.
2. **Fusionar** un usuario **que si tiene movimientos** — trasladar todos sus movimientos al usuario que se escoja, luego eliminar el origen.

### Estado actual

- `main/routes/staff.ts` expone: `GET /`, `GET /:id`, `POST /`, `PUT /:id`, `POST /:id/deactivate`, `POST /:id/reactivate`.
- **No hay endpoint `DELETE /:id`** — el comentario en `staff.ts:272` dice: "Staff are deactivated rather than hard-deleted to preserve order and print log references."
- Los tests en `staff-authz.test.ts` cubren deactivate/reactivate y role boundaries, pero **no** hard-delete.
- `cash-closures.test.ts:1503` muestra un hard-delete manual con `PRAGMA foreign_keys = OFF` y el sistema **ya maneja gracefulmente** referencias a usuarios borrados (ej. `cash_closures.closed_by_name` cae al raw id cuando `users.name` no se encuentra — `cash-closures.ts:137`).

### Inventario completo de referencias a `users(id)`

#### Con FK constraint (hard-delete falla si hay filas -- FK esta ON):

| Tabla | Columna | FK Cascade | Comentario |
|---|---|---|---|
| `print_logs` | `user_id` | No | NOT NULL |
| `orders` | `user_id` | No | |
| `cash_sessions` | `opened_by` | No | NOT NULL |
| `cash_closures` | `closed_by` | No | NOT NULL |
| `cash_closure_amendments` | `amended_by` | No | NOT NULL |
| `refunds` | `approved_by` | No | NOT NULL |
| `refunds` | `created_by` | No | NOT NULL |
| `purchases` | `created_by` | No | NOT NULL |
| `purchases` | `voided_by` | No | nullable |
| `purchase_amendments` | `amended_by` | No | NOT NULL |
| `purchase_payments` | `created_by` | No | NOT NULL |
| `receivable_terms` | `created_by` | No | NOT NULL |
| `cartera_entries` | `created_by` | No | NOT NULL |
| `cartera_entries` | `voided_by` | No | nullable |
| `general_payables` | `created_by` | No | NOT NULL |
| `general_payables` | `voided_by` | No | nullable |
| `general_payable_payments` | `created_by` | No | NOT NULL |
| `saved_reports` | `created_by` | No | nullable |
| `station_users` | `user_id` | **Si** (CASCADE) | |
| `saved_reports` | `user_id` | **Si** (CASCADE) | |

#### Sin FK (referencias logicas -- no bloquean hard-delete pero si deben migrarse):

| Tabla | Columna | Comentario |
|---|---|---|
| `order_idempotency` | `user_id` | NOT NULL |
| `payment_idempotency` | `user_id` | NOT NULL |
| `refund_idempotency` | `user_id` | Parte de PK |
| `tax_overrides` | `created_by_user_id` | |
| `tax_config_audit` | `actor_user_id` | |
| `whatsapp_messages` | `created_by_user_id` | |
| `whatsapp_blocklist` | `blocked_by_user_id` | |

#### Settings (string values referenciando user IDs):

| Key | Codigo |
|---|---|
| `whatsapp_activated_by_user_id` | `db.ts:5224`, `whatsapp.ts:740` |
| `last_password_recovery_user_id` | `auth.ts:824` |
| `last_owner_recovery_user_id` | `auth.ts:827` |

---

## Decision de diseno

| Aspecto | Decision |
|---|---|
| **Rol requerido** | `owner` unico — borrado/fusion permanente afecta auditoria y seguridad |
| **Hard-delete** | `DELETE /api/staff/:id` — valida 0 referencias, luego elimina |
| **Merge** | `POST /api/staff/:id/merge` — reasigna todas las referencias a un usuario objetivo, elimina el origen |
| **FK during merge** | `PRAGMA defer_foreign_keys = ON` dentro de transaccion — permite UPDATE de columnas FK sin errores intermedios |
| **Credenciales** | El usuario origen conserva password/pin/tokens -- se borran con el DELETE. El usuario objetivo conserva los suyos. |
| **Auth cache** | `invalidateUserAuthCache` en ambos usuarios tras merge |

### Flujo de trabajo del usuario

```
Pagina de Staff -> boton "..." (mas opciones) en cada tarjeta de usuario ->
  |- [Owner] "Borrar definitivamente" -> valida movimientos -> si 0 -> confirma -> DELETE
  |- [Owner] "Fusionar" -> modal: selecciona usuario destino (owner/manager activos) -> confirma -> POST /merge
```

---

## Tareas

### Tarea 1: Backend -- endpoint `DELETE /api/staff/:id` (hard-delete)

**Archivo:** `main/routes/staff.ts` (despues de `POST /:id/reactivate`, antes de `export`)

```typescript
/**
 * Hard-delete a staff user -- ONLY when they have zero transactional
 * references across the entire schema. Returns 409 with the list of
 * referencing tables if movements exist, guiding the caller to merge instead.
 */
router.delete('/:id', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const member = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(req.params.id) as any;
    if (!member) return res.status(404).json({ error: 'Staff member not found' });

    // 1. Prevent deleting the last active owner.
    if (member.role === 'owner') {
      const count = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND is_active = 1").get() as { n: number }).n;
      if (count <= 1) {
        return res.status(400).json({ error: 'Cannot permanently delete the last active owner' });
      }
    }

    // 2. Check ALL user-referencing tables for any rows.
    const referencingTables = checkUserReferences(db, req.params.id);
    if (referencingTables.length > 0) {
      return res.status(409).json({
        error: 'Cannot hard-delete: user has transactional references',
        referencingTables,
        message: 'Use POST /:id/merge to reassign movements to another user first.',
      });
    }

    // 3. Check settings entries.
    const referencingSettings = checkUserSettingsReferences(db, req.params.id);
    if (referencingSettings.length > 0) {
      return res.status(409).json({
        error: 'Cannot hard-delete: user is referenced by settings',
        referencingSettings,
      });
    }

    // 4. Hard-delete (FK is ON, but we already verified no references).
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    invalidateUserAuthCache(req.params.id);
    res.json({ message: `Staff member ${member.name} permanently deleted`, deletedId: req.params.id });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

**Helper `checkUserReferences`** -- debe consultar las 27 tablas/columnas (20 con FK + 7 sin FK):

```typescript
// Agregar al inicio de staff.ts (junto a STAFF_SELECT_FIELDS)
const USER_REF_COLUMNS: Array<[string, string]> = [
  ['print_logs', 'user_id'],
  ['orders', 'user_id'],
  ['order_idempotency', 'user_id'],
  ['payment_idempotency', 'user_id'],
  ['refund_idempotency', 'user_id'],
  ['cash_sessions', 'opened_by'],
  ['cash_closures', 'closed_by'],
  ['cash_closure_amendments', 'amended_by'],
  ['refunds', 'approved_by'],
  ['refunds', 'created_by'],
  ['purchases', 'created_by'],
  ['purchases', 'voided_by'],
  ['purchase_amendments', 'amended_by'],
  ['purchase_payments', 'created_by'],
  ['receivable_terms', 'created_by'],
  ['cartera_entries', 'created_by'],
  ['cartera_entries', 'voided_by'],
  ['general_payables', 'created_by'],
  ['general_payables', 'voided_by'],
  ['general_payable_payments', 'created_by'],
  ['saved_reports', 'created_by'],
  ['saved_reports', 'user_id'],
  ['station_users', 'user_id'],
  ['tax_overrides', 'created_by_user_id'],
  ['tax_config_audit', 'actor_user_id'],
  ['whatsapp_messages', 'created_by_user_id'],
  ['whatsapp_blocklist', 'blocked_by_user_id'],
];

function checkUserReferences(db: Database, userId: string): string[] {
  return USER_REF_COLUMNS
    .filter(([table, col]) => {
      const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(userId) as { n: number };
      return count.n > 0;
    })
    .map(([table, col]) => `${table}.${col}`);
}

function checkUserSettingsReferences(db: Database, userId: string): string[] {
  const settings = db.prepare("SELECT key FROM settings WHERE value = ?").all(userId) as { key: string }[];
  return settings.map(r => `settings.${r.key}`);
}
```

**Consideraciones de seguridad:**
- `requireRole(...ROLE_ACCESS.owner)` -- SOLO owner, no manager. Un manager no deberia poder borrar permanentemente.
- El check de referencias usa `COUNT(*)` (no devuelve filas, eficiente con indices).
- FK esta ON durante el DELETE -- si acaso se nos escapa alguna referencia, la FK lo bloqueara (defensa en profundidad).
- `invalidateUserAuthCache` revoca sesiones activas del usuario borrado.

### Tarea 2: Backend -- endpoint `POST /api/staff/:id/merge` (merge/reasignar)

**Archivo:** `main/routes/staff.ts` (despues del endpoint DELETE)

Importar `withTxn` desde `../db` (no esta importado actualmente en staff.ts).

```typescript
interface MergeBody { merge_into: string; }

router.post('/:id/merge', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  const sourceId = req.params.id;
  const { merge_into: targetId } = req.body as MergeBody;

  try {
    if (!targetId || targetId === sourceId) {
      return res.status(400).json({ error: 'merge_into is required and must differ from the source user' });
    }

    const db = getDatabase();

    const source = db.prepare('SELECT id, name, role, is_active FROM users WHERE id = ?').get(sourceId) as any;
    if (!source) return res.status(404).json({ error: 'Source staff member not found' });
    if (source.is_active === 0) return res.status(400).json({ error: 'Source staff member is deactivated' });

    const target = db.prepare('SELECT id, name, is_active FROM users WHERE id = ?').get(targetId) as any;
    if (!target) return res.status(404).json({ error: 'Target staff member not found' });
    if (target.is_active === 0) return res.status(400).json({ error: 'Target staff member is deactivated' });

    // Prevent merging the last active owner into someone else.
    if (source.role === 'owner') {
      const otherOwners = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND is_active = 1 AND id != ?").get(sourceId) as { n: number }).n;
      if (otherOwners === 0) {
        return res.status(400).json({ error: 'Cannot merge the last active owner. Promote another owner first.' });
      }
    }

    const moved: string[] = [];

    withTxn(() => {
      // Defer FK checks so we can UPDATE FK columns mid-transaction.
      db.pragma('defer_foreign_keys = ON');

      // 1. Reassign all user-referencing columns BEFORE the DELETE.
      //    Tables with ON DELETE CASCADE (station_users, saved_reports)
      //    must be reassigned first so the DELETE finds zero rows to cascade.
      for (const [table, col] of USER_REF_COLUMNS) {
        const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`)
          .get(sourceId) as { n: number };
        if (count.n > 0) {
          db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(targetId, sourceId);
          moved.push(`${table}.${col} (${count.n})`);
        }
      }

      // 2. Reassign settings entries.
      const settingsToUpdate = db.prepare("SELECT key FROM settings WHERE value = ?").all(sourceId) as { key: string }[];
      for (const { key } of settingsToUpdate) {
        db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
          .run(targetId, now(), key);
        moved.push(`settings.${key}`);
      }

      // 3. Delete the source user.
      db.prepare('DELETE FROM users WHERE id = ?').run(sourceId);
      db.pragma('defer_foreign_keys = OFF');
    });

    invalidateUserAuthCache(sourceId);
    invalidateUserAuthCache(targetId);

    res.json({
      message: `Merged "${source.name}" into "${target.name}" and deleted the source account`,
      mergedId: sourceId,
      targetId,
      movedTables: moved,
    });
  } catch (error: any) {
    console.error('[API] Merge error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

**Consideraciones críticas del merge:**
- `defer_foreign_keys = ON` permite UPDATE de columnas con FK sin validar en cada paso; validacion ocurre al COMMIT.
- NO se transfieren `password`, `pin_hash`, `tokens_valid_after`, `role`, `name`, `email` -- el usuario destino conserva su identidad y credenciales.
- Tablas con `ON DELETE CASCADE` (`station_users`, `saved_reports`): el UPDATE las reasigna ANTES del DELETE, por lo que el borrado no encuentra filas para cascadir. Orden critico: UPDATEs then DELETE.
- Ultimo owner activo: si el origen es `owner`, se verifica que quede al menos un owner activo. Integrado en el codigo del endpoint.

### Tarea 3: Frontend -- UI de borrado y fusion en staff page

**Archivo:** `frontend/src/app/(dashboard)/staff/page.tsx`

1. Importar `useConfirm` y `Trash2` + `Merge`:

```typescript
import { useConfirm } from '@/hooks/use-confirm';
import { Trash2, Merge } from 'lucide-react';
```

2. Agregar hook de confirmacion y estado modal:

```typescript
const { confirm, ConfirmDialog } = useConfirm();
const [mergeModalOpen, setMergeModalOpen] = useState(false);
const [mergeTarget, setMergeTarget] = useState<Staff | null>(null);
const [mergeSource, setMergeSource] = useState<Staff | null>(null);
const [isDeleting, setIsDeleting] = useState(false);
const [isMerging, setIsMerging] = useState(false);
```

3. Funcion de hard-delete (solo owner):

```typescript
const handleDelete = async (s: Staff) => {
  if (!await confirm(
    t('deleteConfirm', { name: s.name }),
    { destructive: true, confirmLabel: tCommon('delete') }
  )) return;
  setIsDeleting(true);
  try {
    await api.delete(`/staff/${s.id}`);
    toast.success(t('deletedToast', { name: s.name }));
    fetchStaff();
  } catch (err: any) {
    if (err.response?.status === 409) {
      toast.error(t('cannotDeleteHasMovements'));
    } else {
      toast.error(err.response?.data?.error || t('deleteFailed'));
    }
  } finally {
    setIsDeleting(false);
  }
};
```

4. Funcion de merge (solo owner):

```typescript
const handleMerge = (s: Staff) => {
  setMergeSource(s);
  setMergeModalOpen(true);
};

const confirmMerge = async () => {
  if (!mergeTarget) return;
  setIsMerging(true);
  try {
    const res = await api.post(`/staff/${mergeSource!.id}/merge`, { merge_into: mergeTarget.id });
    toast.success(t('mergedToast', { name: mergeSource!.name, into: mergeTarget.name }));
    fetchStaff();
  } catch (err: any) {
    toast.error(err.response?.data?.error || t('mergeFailed'));
  } finally {
    setIsMerging(false);
    setMergeModalOpen(false);
  }
};
```

5. Botones en la tarjeta de staff (solo para owner):

```tsx
const isOwner = hasRole(currentTenant?.role, ROLE_ACCESS.owner);

// Dentro de la tarjeta, junto a los botones existentes:
{isOwner && (
  <div className="flex gap-1">
    <Button variant="ghost" size="sm" onClick={() => handleMerge(s)} title={t('mergeTooltip')}>
      <Merge size={14} />
    </Button>
    <Button
      variant="ghost" size="sm"
      onClick={() => handleDelete(s)}
      className="text-red-500 hover:text-red-700"
      disabled={isDeleting}
      title={t('deleteTooltip')}
    >
      <Trash2 size={14} />
    </Button>
  </div>
)}
```

6. Modal de seleccion de usuario destino para merge (usar Dialog de @/components/ui/dialog como patron del proyecto).

7. Renderizar `ConfirmDialog` al final del return.

### Tarea 4: Traducciones

**Archivos:** `frontend/src/lib/i18n/messages/{en,es,pt,de,fr,tr,fil,fa}.json`

Agregar al bloque `staff`:
```json
{
  "delete": "Borrar definitivamente",
  "deleteConfirm": "Borrar definitivamente a {name}? Esta accion no se puede deshacer.",
  "deletedToast": "Usuario eliminado definitivamente",
  "cannotDeleteHasMovements": "Este usuario tiene movimientos. Usa Fusionar para reasignarlos primero.",
  "deleteFailed": "Error al borrar el usuario",
  "merge": "Fusionar",
  "mergeTitle": "Fusionar {name} con otro usuario",
  "mergeBody": "Selecciona el usuario que quedara. Todos los movimientos (ordenes, facturas, caja, compras, etc.) del usuario origen se reasignaran al usuario destino.",
  "mergeSelectTarget": "Selecciona el usuario destino",
  "mergeConfirm": "Fusionar y borrar",
  "mergeFailed": "Error al fusionar usuarios",
  "mergedToast": "Movimientos de {name} fusionados en {into}",
  "mergeTooltip": "Fusionar movimientos de este usuario con otro",
  "deleteTooltip": "Borrar definitivamente (solo si no tiene movimientos)"
}
```

### Tarea 5: Tests

**Archivo:** `tests/staff-authz.test.ts` (agregar seccion)

```typescript
console.log('\n── Hard-delete and merge ──');

// Hard-delete: owner can delete staff without references
const noRefId = 'no-ref-user';
seedUser(db, noRefId, 'cashier', '');
let res = await request(app).delete(`/api/staff/${noRefId}`).set(ownerAuth);
assertEqual(res.status, 200, 'owner can hard-delete staff with no movements');

// Hard-delete: blocked if movements exist
res = await request(app).delete('/api/staff/owner-145').set(ownerAuth);
assertEqual(res.status, 409, 'cannot hard-delete user with movements');

// Hard-delete: manager forbidden
res = await request(app).delete('/api/staff/cashier-target-145').set(managerAuth);
assertEqual(res.status, 403, 'manager cannot hard-delete staff');

// Hard-delete: owner cannot delete last active owner
res = await request(app).delete('/api/staff/owner-145').set(ownerAuth);
// Si owner-145 tiene movimientos, devuelve 409; si no, hay proteccion de ultimo owner
// (en el seed, owner-145 es el unico owner activo -> 400)

// Merge: owner can merge user with movements into another
res = await request(app).post('/api/staff/owner-145/merge').set(ownerAuth).send({ merge_into: 'owner-145-second' });
assertEqual(res.status, 200, 'owner can merge users with movements');
assertEqual(res.body.mergedId, 'owner-145', 'merge response includes deleted user ID');
```

**Archivo:** nuevo test `tests/staff-merge.test.ts` -- escenario completo con movimientos reales (ordenes, cash_sessions) y verificacion de reasignacion.

### Tarea 6: Documentacion de seguridad

- **Hard-delete es permanente**: la fila `users` (incl. password hash, pin hash) es eliminada. No hay undo.
- **Merge preserva el audit trail**: las referencias FK en tablas historicas apuntan al usuario destino.
- **No se transfieren credenciales**: password, pin, tokens_valid_after del origen se pierden. El destino conserva los suyos.
- **Owner protection**: no se puede borrar ni fusionar el ultimo owner activo.
- **Manager restriction**: managers NO pueden hard-delete ni fusionar (owner-only). Los managers pueden deactivate/reactivate segun la politica existente.

---

## Archivos afectados

| Archivo | Cambio |
|---|---|
| `main/routes/staff.ts` | + `DELETE /:id` (hard-delete con validacion), `POST /:id/merge` (reasignacion), helpers `checkUserReferences`/`checkUserSettingsReferences`, import `withTxn` |
| `frontend/src/app/(dashboard)/staff/page.tsx` | + botones Delete y Merge (owner-only), modal de merge, `useConfirm` |
| `tests/staff-authz.test.ts` | + assertions para hard-delete y merge |
| `tests/staff-merge.test.ts` | nuevo: test completo de merge con verificacion de reasignacion |
| `frontend/src/lib/i18n/messages/*.json` (8) | + keys de staff: delete, merge, confirmaciones |

## Validacion

1. `npm run lint` -- lint backend y frontend
2. `npm run build` -- compila TypeScript
3. `npm run test:staff-authz` -- tests de autorizacion actualizados
4. Nuevo test: hard-delete de usuario con movimientos devuelve 409; hard-delete sin movimientos devuelve 200; manager devuelve 403; merge reasigna y elimina
5. `npm run i18n:check` -- consistencia de traducciones
6. Manual: `node dev-server.js`, navegar a `/staff`, probar borrado de usuario sin ordenes, intentar borrado de usuario con ordenes (debe mostrar 409/error), probar fusion de usuarios
