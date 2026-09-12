-- ============================================================================
--  Receptor de soporte — esquema de D1
--
--  D1 es SQLite, el mismo motor del POS. Lo que llega aquí ya viene saneado
--  desde el cliente: sin nombres, teléfonos ni contenido de pedidos.
-- ============================================================================

-- Una fila por instalación. La clave se guarda tal cual porque hay que
-- recalcular el HMAC con ella; por eso el acceso a esta tabla es lo que hay
-- que cuidar.
CREATE TABLE IF NOT EXISTS tiendas (
  store_id        TEXT PRIMARY KEY,
  pos_hash        TEXT NOT NULL UNIQUE,
  api_key         TEXT NOT NULL,
  nombre          TEXT,
  contacto        TEXT,
  telefono        TEXT,
  pais            TEXT,
  zona_horaria    TEXT,
  moneda          TEXT,
  app_version     TEXT,
  plataforma      TEXT,
  device_name     TEXT,
  activa          INTEGER NOT NULL DEFAULT 1,
  creada_en       TEXT NOT NULL,
  vista_en        TEXT
);

-- Los errores. `event_id` es la llave natural: el POS reintenta el mismo
-- evento hasta que responda 2xx, así que sin esto llegaría repetido.
CREATE TABLE IF NOT EXISTS eventos (
  event_id        TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL REFERENCES tiendas(store_id),
  event_code      TEXT NOT NULL,
  severidad       TEXT NOT NULL,
  mensaje         TEXT,
  correlation_id  TEXT,
  metadata        TEXT,
  huella          TEXT,
  ocurrio_en      TEXT,
  recibido_en     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS eventos_por_tienda  ON eventos(store_id, recibido_en DESC);
CREATE INDEX IF NOT EXISTS eventos_por_codigo  ON eventos(event_code, recibido_en DESC);
-- Para agrupar lo repetido: una tienda en bucle de caídas genera miles de
-- filas con la misma huella, y así se cuentan sin recorrerlas todas.
CREATE INDEX IF NOT EXISTS eventos_por_huella  ON eventos(store_id, huella, recibido_en DESC);

-- Lo que el comerciante escribe él mismo.
CREATE TABLE IF NOT EXISTS tiques (
  client_ticket_id TEXT PRIMARY KEY,
  store_id         TEXT NOT NULL REFERENCES tiendas(store_id),
  asunto           TEXT,
  mensaje          TEXT,
  severidad        TEXT,
  event_code       TEXT,
  correlation_id   TEXT,
  contacto         TEXT,
  app_version      TEXT,
  plataforma       TEXT,
  diagnostico      TEXT,
  estado           TEXT NOT NULL DEFAULT 'abierto',
  recibido_en      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tiques_por_estado ON tiques(estado, recibido_en DESC);

-- El latido, cada 5 minutos. Aquí es donde se ve "cómo van mis clientes":
-- ventas del día, facturas y pedidos activos, sin un solo dato personal.
CREATE TABLE IF NOT EXISTS latidos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        TEXT NOT NULL REFERENCES tiendas(store_id),
  app_version     TEXT,
  device_name     TEXT,
  pedidos_activos INTEGER,
  ventas_hoy      REAL,
  facturas_hoy    INTEGER,
  enviado_en      TEXT,
  recibido_en     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS latidos_por_tienda ON latidos(store_id, recibido_en DESC);

-- Quién aceptó enviar diagnóstico y cuándo. Es el respaldo del consentimiento.
CREATE TABLE IF NOT EXISTS consentimientos (
  store_id      TEXT PRIMARY KEY REFERENCES tiendas(store_id),
  acepta        INTEGER NOT NULL,
  actualizado   TEXT NOT NULL
);
