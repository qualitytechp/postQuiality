-- ============================================================================
--  ARRANQUE LIMPIO — Asocampo
--
--  Para estrenar el sistema: deja SÓLO lo que el negocio trajo de verdad
--  —sus clientes y su catálogo— y borra todo lo demás.
--
--  La diferencia con `punto-cero.sql`:
--
--    punto-cero.sql      borra ventas, caja y cierres. CONSERVA compras,
--                        proveedores y cartera. Es para una tienda que ya
--                        viene operando y sólo quiere reiniciar el periodo.
--
--    arranque-limpio.sql borra además compras, proveedores, cartera, cuentas
--                        por pagar y formas de pago añadidas. Es para estrenar.
--
--  QUÉ SE CONSERVA
--    · Los 120 productos con sus precios, costos y existencias
--    · Las 10 categorías
--    · Los 444 clientes
--    · El usuario dueño, los impuestos y toda la configuración
--
--  QUÉ SE BORRA
--    · Todo el movimiento: ventas, facturas, caja, cierres, inventario histórico
--    · Compras y proveedores
--    · Cartera, cuentas por pagar y cuentas de tesorería añadidas
--    · Formas de pago añadidas (efectivo, tarjeta y billetera son del sistema
--      y no se tocan)
--    · Los productos de prueba que quedaron borrados pero ocupando espacio
--
--  ANTES DE CORRER ESTO: cierre la aplicación por completo. El instalador
--  saca copia sola.
-- ============================================================================

PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

-- ─────────────────────────────────────────────────────────────────────
--  1. Lo que cuelga de las facturas
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
--     saldo se calcula sumando este libro.
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM loyalty_ledger;

-- ─────────────────────────────────────────────────────────────────────
--  5. Historial de inventario
--     Las EXISTENCIAS NO SE TOCAN: viven en products.stock_quantity, que es
--     la cifra autorizada. Esto borra sólo el libro que explica cómo se llegó
--     a ella, y el próximo movimiento parte de la existencia actual.
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM stock_movements;

-- ─────────────────────────────────────────────────────────────────────
--  6. Compras y proveedores
--     De hijo a padre: los pagos y los renglones antes que la compra.
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM purchase_amendments;
DELETE FROM purchase_payments;
DELETE FROM purchase_items;
DELETE FROM purchases;
DELETE FROM suppliers;

-- ─────────────────────────────────────────────────────────────────────
--  7. Cartera y tesorería
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM general_payable_payments;
DELETE FROM general_payables;
DELETE FROM cartera_entries;

-- Se conserva UNA cuenta de efectivo: el sistema la exige y es la que
-- representa el cajón. Las demás eran de prueba.
DELETE FROM cartera_accounts WHERE canonical_method IS NULL OR canonical_method <> 'cash';

-- ─────────────────────────────────────────────────────────────────────
--  8. Caja y cierres
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM cash_closure_amendments;
DELETE FROM cash_sessions;
DELETE FROM cash_closures;

-- ─────────────────────────────────────────────────────────────────────
--  9. Formas de pago añadidas
--     Efectivo, tarjeta y billetera son del sistema y no viven aquí, así que
--     el negocio puede cobrar desde el primer minuto. Si usa Nequi o
--     Bancolombia, se vuelven a crear en Configuración → Pagos en un minuto.
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM payment_method_merges;
DELETE FROM payment_methods;

-- ─────────────────────────────────────────────────────────────────────
-- 10. Combos de prueba y productos de prueba
--     Los productos borrados siguen ocupando espacio y saliendo en consultas
--     internas. Al estrenar conviene que no queden.
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM product_components;
DELETE FROM addon_group_product WHERE product_id IN (SELECT id FROM products WHERE deleted_at IS NOT NULL);
DELETE FROM products WHERE deleted_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 11. Rastros técnicos y consecutivos
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM order_idempotency;
DELETE FROM payment_idempotency;
DELETE FROM refund_idempotency;
DELETE FROM payment_transaction_refs;
DELETE FROM payment_transaction_ref_conflicts;
DELETE FROM cloud_sync_outbox;
DELETE FROM store_diagnostics_outbox;
DELETE FROM support_ticket_outbox;
DELETE FROM whatsapp_messages;
DELETE FROM sequences;

COMMIT;

VACUUM;

-- ─────────────────────────────────────────────────────────────────────
--  Comprobación. Todo lo de arriba en 0; todo lo de abajo con sus datos.
-- ─────────────────────────────────────────────────────────────────────
SELECT 'pedidos'            AS concepto, COUNT(*) AS cantidad FROM orders
UNION ALL SELECT 'facturas',             COUNT(*) FROM bills
UNION ALL SELECT 'caja',                 COUNT(*) FROM cash_sessions
UNION ALL SELECT 'cierres Z',            COUNT(*) FROM cash_closures
UNION ALL SELECT 'mov. inventario',      COUNT(*) FROM stock_movements
UNION ALL SELECT 'compras',              COUNT(*) FROM purchases
UNION ALL SELECT 'proveedores',          COUNT(*) FROM suppliers
UNION ALL SELECT 'cartera',              COUNT(*) FROM cartera_entries
UNION ALL SELECT 'cuentas por pagar',    COUNT(*) FROM general_payables
UNION ALL SELECT 'formas de pago',       COUNT(*) FROM payment_methods
UNION ALL SELECT 'consecutivos',         COUNT(*) FROM sequences
UNION ALL SELECT '--- se conserva ---',  NULL
UNION ALL SELECT 'productos',            COUNT(*) FROM products
UNION ALL SELECT 'con precio',           COUNT(*) FROM products WHERE price > 0
UNION ALL SELECT 'con costo',            COUNT(*) FROM products WHERE cost > 0
UNION ALL SELECT 'categorías',           COUNT(*) FROM categories
UNION ALL SELECT 'clientes',             COUNT(*) FROM customers
UNION ALL SELECT 'usuarios',             COUNT(*) FROM users
UNION ALL SELECT 'cuenta de efectivo',   COUNT(*) FROM cartera_accounts
UNION ALL SELECT 'ajustes',              COUNT(*) FROM settings;
