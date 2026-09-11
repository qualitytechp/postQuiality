-- ============================================================================
--  PUNTO CERO — Asocampo
--  Borra el movimiento (ventas, caja, cierres) y deja intacto el negocio
--  (productos, precios, costos, categorías, clientes, proveedores, usuarios
--  y toda la configuración).
--
--  Pensado para dejar la instalación lista para pruebas o para arrancar en
--  limpio el primer día de operación real.
--
--  ANTES DE CORRER ESTO:
--    1. Cierre la aplicación por completo (no basta con cerrar la ventana:
--       revise que no quede "QualityTech POS" en el Administrador de tareas).
--    2. Saque una copia del archivo flo.db. El instalador lo hace solo.
--
--  El orden de borrado respeta las llaves foráneas de hijo a padre, así que
--  funciona con PRAGMA foreign_keys tanto en ON como en OFF.
-- ============================================================================

PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

-- ─────────────────────────────────────────────────────────────────────
--  1. Lo que cuelga de las facturas
--     print_logs.bill_id no admite nulo, así que se borra; los mensajes de
--     WhatsApp sí lo admiten y se conservan, sólo se les suelta la factura.
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM print_logs;
UPDATE whatsapp_messages SET bill_id = NULL WHERE bill_id IS NOT NULL;
DELETE FROM refunds;
DELETE FROM bill_items;
DELETE FROM receivable_terms;

-- ─────────────────────────────────────────────────────────────────────
--  2. Lo que cuelga de los renglones del pedido
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM order_item_addons;
DELETE FROM order_item_components;

-- ─────────────────────────────────────────────────────────────────────
--  3. Facturas y pedidos
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM bills;
DELETE FROM order_items;
DELETE FROM orders;
DELETE FROM held_orders;

-- ─────────────────────────────────────────────────────────────────────
--  4. Puntos de fidelidad
--     Los clientes NO se borran. Sus puntos sí quedan en cero, porque el
--     saldo se calcula sumando este libro, no se guarda en el cliente.
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM loyalty_ledger;

-- ─────────────────────────────────────────────────────────────────────
--  5. Historial de inventario
--     Las EXISTENCIAS NO SE TOCAN. La cantidad vive en products.stock_quantity
--     y es la cifra autorizada del sistema; este libro sólo explica cómo se
--     llegó a ella. Al vaciarlo, el próximo movimiento parte de la existencia
--     actual y queda cuadrado.
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM stock_movements;

-- ─────────────────────────────────────────────────────────────────────
--  6. Caja y cierres
--     Compras y cartera se conservan; sólo se les suelta la sesión de caja
--     que está a punto de desaparecer.
-- ─────────────────────────────────────────────────────────────────────
UPDATE purchase_payments        SET cash_session_id = NULL WHERE cash_session_id IS NOT NULL;
UPDATE cartera_entries          SET cash_session_id = NULL WHERE cash_session_id IS NOT NULL;
UPDATE general_payable_payments SET cash_session_id = NULL WHERE cash_session_id IS NOT NULL;

DELETE FROM cash_closure_amendments;
DELETE FROM cash_sessions;
DELETE FROM cash_closures;

-- ─────────────────────────────────────────────────────────────────────
--  7. Rastros técnicos
--     Llaves de reintento y referencias de pago. Si quedaran, un pedido
--     nuevo podría chocar con la huella de uno que ya no existe.
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM order_idempotency;
DELETE FROM payment_idempotency;
DELETE FROM refund_idempotency;
DELETE FROM payment_transaction_refs;
DELETE FROM payment_transaction_ref_conflicts;
DELETE FROM cloud_sync_outbox;
DELETE FROM store_diagnostics_outbox;

-- ─────────────────────────────────────────────────────────────────────
--  8. Consecutivos
--     Número de pedido, de factura y de reporte Z vuelven a empezar en 1.
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM sequences;

COMMIT;

-- Recupera el espacio y deja el archivo compacto. Fuera de la transacción
-- a propósito: VACUUM no puede correr dentro de una.
VACUUM;

-- ─────────────────────────────────────────────────────────────────────
--  Comprobación. Las nueve primeras cifras deben ser 0.
--  Las tres últimas deben seguir teniendo sus datos.
-- ─────────────────────────────────────────────────────────────────────
SELECT 'pedidos'          AS concepto, COUNT(*) AS cantidad FROM orders
UNION ALL SELECT 'renglones',          COUNT(*) FROM order_items
UNION ALL SELECT 'facturas',           COUNT(*) FROM bills
UNION ALL SELECT 'sesiones de caja',   COUNT(*) FROM cash_sessions
UNION ALL SELECT 'cierres Z',          COUNT(*) FROM cash_closures
UNION ALL SELECT 'mov. inventario',    COUNT(*) FROM stock_movements
UNION ALL SELECT 'devoluciones',       COUNT(*) FROM refunds
UNION ALL SELECT 'puntos',             COUNT(*) FROM loyalty_ledger
UNION ALL SELECT 'consecutivos',       COUNT(*) FROM sequences
UNION ALL SELECT '--- se conserva ---', NULL
UNION ALL SELECT 'productos',          COUNT(*) FROM products
UNION ALL SELECT 'con precio',         COUNT(*) FROM products WHERE price > 0
UNION ALL SELECT 'con costo',          COUNT(*) FROM products WHERE cost > 0
UNION ALL SELECT 'categorías',         COUNT(*) FROM categories
UNION ALL SELECT 'clientes',           COUNT(*) FROM customers
UNION ALL SELECT 'proveedores',        COUNT(*) FROM suppliers
UNION ALL SELECT 'compras',            COUNT(*) FROM purchases
UNION ALL SELECT 'usuarios',           COUNT(*) FROM users
UNION ALL SELECT 'ajustes',            COUNT(*) FROM settings;
