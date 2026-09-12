# Receptor de soporte — Cloudflare

Recibe los errores, los tiques y los latidos que mandan los POS de sus clientes.
Sin servidor que mantener, sin certificados, sin `npm install`.

**Estado:** probado sin desplegar · firma **11/11** · recorrido completo **22/22**

---

## Qué hace

| Endpoint | Quién lo llama | Para qué |
|---|---|---|
| `POST /api/pos/register` | una tienda nueva | la da de alta y le entrega su clave |
| `POST /api/pos/diagnostics` | el POS, al fallar algo | guarda el error y le avisa |
| `POST /api/pos/support-ticket` | el comerciante | su mensaje, y le avisa siempre |
| `POST /api/pos/heartbeat` | el POS, cada 5 min | ventas del día, facturas y pedidos activos |

Más un **resumen diario** por cron: los errores más repetidos de las últimas 24
horas y las tiendas que no dieron señales.

---

## Desplegarlo

Necesita una cuenta de Cloudflare y Node. Nada más.

```sh
cd deploy/receptor-cloudflare
npx wrangler login
```

**1. La base de datos**

```sh
npx wrangler d1 create soporte
```

Copie el `database_id` que imprime y péguelo en `wrangler.toml`. Después cree
las tablas:

```sh
npx wrangler d1 execute soporte --remote --file=schema.sql
```

**2. El espacio para los nonce**

```sh
npx wrangler kv namespace create NONCES
```

Pegue también ese `id` en `wrangler.toml`.

**3. Los avisos a su teléfono**

Hable con [@BotFather](https://t.me/botfather) en Telegram, cree un bot y
guarde los dos secretos:

```sh
npx wrangler secret put TELEGRAM_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

> Van como secretos, **no** en `wrangler.toml`: ese archivo se versiona.
> Si prefiere WhatsApp, cambie la URL dentro de `avisar()` por la de la API
> oficial de WhatsApp Business. La forma es la misma.

**4. Publicar**

```sh
npx wrangler deploy
```

Le queda una URL como `https://receptor-soporte.<su-cuenta>.workers.dev`.

---

## Conectar una tienda

En el POS, **Configuración → Cuenta**, ponga esa URL como servidor de nube. O
por API:

```sh
curl -X PUT http://localhost:3101/api/settings/cloud \
  -H "Authorization: Bearer <token del dueño>" \
  -H "Content-Type: application/json" \
  -d '{"cloud_server_url":"https://receptor-soporte.SU-CUENTA.workers.dev"}'
```

La tienda se da de alta sola, recibe su clave y empieza a enviar. Para verlo:

```sh
npx wrangler d1 execute soporte --remote --command "SELECT nombre, store_id, vista_en FROM tiendas"
```

---

## Consultas útiles

```sh
# Los errores de hoy, agrupados
npx wrangler d1 execute soporte --remote --command \
  "SELECT t.nombre, e.event_code, COUNT(*) veces, MAX(e.recibido_en) ultimo
   FROM eventos e JOIN tiendas t ON t.store_id=e.store_id
   WHERE e.recibido_en >= date('now')
   GROUP BY t.nombre, e.huella ORDER BY veces DESC"

# Cómo va cada cliente hoy
npx wrangler d1 execute soporte --remote --command \
  "SELECT t.nombre, l.ventas_hoy, l.facturas_hoy, l.pedidos_activos, l.recibido_en
   FROM latidos l JOIN tiendas t ON t.store_id=l.store_id
   WHERE l.id IN (SELECT MAX(id) FROM latidos GROUP BY store_id)"

# Quién no da señales hace más de un día
npx wrangler d1 execute soporte --remote --command \
  "SELECT nombre, vista_en FROM tiendas
   WHERE activa=1 AND (vista_en IS NULL OR vista_en < datetime('now','-1 day'))"
```

---

## Probarlo sin desplegar

```sh
node deploy/receptor-cloudflare/prueba-firma.js    # la firma cuadra con la del POS
node deploy/receptor-cloudflare/prueba-worker.js   # el recorrido completo
```

La primera firma con el mismo algoritmo que `buildSignedHeaders()` del POS pero
por otro camino (el `crypto` de Node contra el Web Crypto del receptor): si las
dos coinciden, cuadra de verdad y no por casualidad.

La segunda sustituye D1 por SQLite real, que es el mismo motor que D1 usa por
dentro, así que el esquema y cada consulta se validan en serio.

---

## Tres cosas que conviene saber

**Sólo se responde 2xx después de guardar.** El POS borra el evento de su cola
en cuanto ve un 2xx. Si alguna vez toca este código, no mueva esa regla:
responder antes de tiempo pierde el evento para siempre.

**Un reintento no es un problema nuevo.** El POS reintenta con espera creciente
hasta que le responda. El aviso sale sólo cuando el evento de verdad entra en la
base — lo detectó la prueba del recorrido completo antes de desplegar nada, y
sin eso cada reintento le habría sonado el teléfono.

**La ruta firmada es la que ve el POS.** Si monta el Worker bajo un prefijo de
ruta, la firma deja de cuadrar y todo responde 401. Póngalo en la raíz del
dominio.

---

## Archivos

| Archivo | Qué es |
|---|---|
| `src/worker.js` | los endpoints y el resumen diario |
| `src/firma.js` | la verificación de la firma, aparte porque es lo delicado |
| `schema.sql` | las tablas de D1 |
| `wrangler.toml` | la configuración del despliegue |
| `prueba-firma.js` · `prueba-worker.js` | las pruebas, sin desplegar |
