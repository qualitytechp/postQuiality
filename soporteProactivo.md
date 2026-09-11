# Soporte proactivo — plan de ejecución

Cómo pasar de «el cliente llama cuando algo ya falló» a «usted lo ve venir y lo
llama antes».

**Estado del POS:** listo del lado del cliente. Los eventos ya se generan, se
sanean y se encolan. Falta a dónde mandarlos y qué más vigilar.
**Fecha:** 11 de septiembre de 2026 · **Versión:** 3.7.2 · **Esquema:** v91

---

## 1. Lo que el POS ya sabe hacer hoy

Antes de planear, lo que ya está construido y probado. No hay que inventarlo:

| Capacidad | Estado |
|---|---|
| Cola durable de diagnósticos en disco | funciona, sobrevive apagones |
| Reintento con espera creciente (hasta 30 min) | funciona |
| Tachado de datos personales | 18 pruebas, verificado en vivo |
| Fuentes de error conectadas | impresora, caídas, promesas, pantalla, **todos los 500 del API** |
| Tiques de soporte con diagnóstico adjunto | funciona |
| Consentimiento del comerciante | funciona, y manda |
| **Canal WebSocket bidireccional** | `/api/pos/relay`, con latido cada 5 min |
| **Comandos que el servidor puede pedirle a una tienda** | `health.get`, `orders.live`, `orders.get`, `report.sales`, `report.dashboard`, `report.hourly`, `report.items`, `report.payments` |

Ese último renglón es el que cambia el juego: **el POS ya acepta que usted le
pregunte cosas en vivo**, sin que el comerciante toque nada. La tubería de
soporte casi en tiempo real ya existe; está sin usar.

---

## 2. A dónde mandar los datos: cuatro caminos

`CLOUD_SERVICES_ENABLED` es una constante de compilación en `shared/brand.ts`.
Ponerla en `true` sólo enciende el servicio; **no** decide a dónde va la
información. Eso lo decide `cloud_server_url`, que es un ajuste **por tienda**.
Esa separación es la que abre las opciones.

### Opción A — Receptor propio mínimo · **recomendada para empezar**

Un servidor suyo, pequeño, que implemente tres cosas:

1. Verificación de la firma (ver §3).
2. `POST /api/pos/diagnostics` — recibe y guarda.
3. `POST /api/pos/support-tickets` — recibe y guarda.

Con eso ya tiene visibilidad de errores de todos sus clientes. Un cuarto
endpoint opcional, `POST /api/pos/diagnostics-consent`, registra quién aceptó.

- **Esfuerzo:** bajo. Es un servicio HTTP con una tabla.
- **Tiempo real:** no todavía (llega en lotes cada 15 s cuando hay eventos).
- **Ventaja:** no necesita construir FloAdmin entero para empezar a ver fallos.

### Opción B — Sin servidor: el comerciante le manda un archivo

Los eventos ya se guardan en `store_diagnostics_outbox`. Se agrega un botón
«Exportar diagnóstico» junto al de copia de seguridad, que produce un JSON
pequeño y ya saneado.

- **Esfuerzo:** muy bajo, todo del lado del POS.
- **Tiempo real:** ninguno. Es reactivo.
- **Cuándo sirve:** para arrancar mañana mismo, o para clientes que no quieran
  enviar nada automáticamente.

### Opción C — Puente a una herramienta que ya usa

El POS firma cada petición, así que un webhook genérico (Slack, Discord, correo)
no puede recibirlo directo. Se resuelve con un adaptador diminuto: la Opción A
más un reenvío. Así los errores le llegan al canal donde usted ya mira.

- **Esfuerzo:** la Opción A más unas pocas líneas.
- **Recomendación:** no es una alternativa a A, es la capa de aviso **encima** de A.

### Opción D — FloAdmin completo

El camino para el que fue diseñado: panel, historial por tienda, comandos en
vivo, tiques. Es el destino, no el punto de partida.

> **La ruta sensata:** A ahora, C encima para enterarse, D cuando el volumen de
> clientes lo justifique. B como plan de respaldo para el cliente que no quiere
> enviar nada.

---

## 3. Lo que su servidor tiene que verificar

Cada petición del POS llega firmada. El servidor debe validar:

| Cabecera | Qué trae |
|---|---|
| `Authorization: Bearer <api_key>` | identifica la tienda |
| `X-Flo-POS-Hash` | identifica la instalación |
| `X-Flo-Timestamp` | ISO 8601 |
| `X-Flo-Nonce` | uuid, único por petición |
| `X-Flo-Body-SHA256` | sha256 del cuerpo |
| `X-Flo-Signature` | `sha256=<hmac>` |

La firma se arma así, y es exactamente lo que el servidor debe recalcular:

```
base = METODO + "\n" + rutaConConsulta + "\n" + timestamp + "\n" + nonce + "\n" + sha256(cuerpo)
firma = HMAC-SHA256(api_key, base)
```

Y debe rechazar: firma que no coincide, `timestamp` viejo (sugerido: más de 5
minutos), y `nonce` repetido. Eso último es lo que impide que alguien reenvíe
una petición capturada.

---

## 4. Reportes preventivos: ver el problema antes de que sea problema

Hoy todo lo que se reporta ya ocurrió. Lo preventivo es distinto: **revisar de
forma periódica condiciones que todavía no rompieron nada pero van a romperlo.**

La propuesta es un chequeo local que corre cada 15 minutos y emite eventos de
severidad `warn` con código `health.*`. Nada de esto sale de la máquina si el
comerciante no dio consentimiento, igual que el resto.

### 4.1 Lo técnico — que el sistema no se caiga

| Código | Condición | Por qué importa |
|---|---|---|
| `health.disk_low` | menos de 1 GB libre | con el disco lleno SQLite corrompe la base |
| `health.wal_growing` | `flo.db-wal` por encima de 64 MB | el checkpoint no está ocurriendo |
| `health.backup_stale` | sin copia hace más de 7 días | el día que falle el disco, no hay de dónde volver |
| `health.schema_behind` | el esquema es menor que el de la app | migración pendiente o fallida |
| `health.outbox_stuck` | eventos sin entregar hace más de 24 h | el cliente está incomunicado y no lo sabe |
| `health.clock_drift` | reloj desviado más de 2 min | **rompe el cierre Z y los reportes por día** |
| `health.update_failing` | la actualización falla repetidas veces | se queda atrás en versiones y correcciones |

`health.clock_drift` merece atención especial: este POS decide el día del
negocio y los límites del turno con la hora local. Un reloj corrido no da error
en ninguna parte — simplemente hace que las ventas caigan en el día equivocado.
Es el fallo más caro de los que no avisan.

### 4.2 Lo operativo — que el negocio no pierda plata

Aquí es donde el soporte deja de ser técnico y pasa a ser útil de verdad:

| Código | Condición | Qué evita |
|---|---|---|
| `health.cash_session_open` | caja abierta hace más de 18 h | se olvidaron de cerrar; el Z va a salir mal |
| `health.printer_failing` | la impresora falla repetido | están facturando sin entregar comprobante |
| `health.cost_above_price` | productos que se venden bajo costo | **hoy encontramos esto en Asocampo: Acelga con costo $23.683 y precio $7.000** |
| `health.stock_negative` | existencias en negativo | el inventario dejó de ser confiable |
| `health.no_sales_today` | sin ventas pasado el mediodía de un día hábil | o está cerrado, o el POS no está funcionando |

El caso de Acelga es el argumento entero de esta sección: **estuvo ahí semanas y
nadie lo vio.** Un chequeo de dos líneas lo habría reportado el primer día.

### 4.3 Que la información coincida y no lo ahogue

Tres piezas, y ninguna es opcional si quiere que esto sirva:

**Huella para agrupar.** Un evento repetido no debe llegar mil veces. Se calcula
una huella con `event_code` + el lugar del fallo, y la cola guarda **uno solo
con un contador**. Una tienda en bucle de caídas le manda un incidente que dice
«837 veces», no 837 correos.

**Identificador de correlación.** Ya existe en el canal y hoy casi no se usa. Si
el tique del comerciante y los eventos técnicos comparten `correlation_id`,
cuando alguien escriba «no me imprime» usted ya tiene delante el error exacto,
con su hora. Eso es lo que hace que la información «coincida».

**Taxonomía estable de códigos.** `app.*` para la aplicación, `api.*` para el
servidor, `print.*` para impresión, `health.*` para lo preventivo. Un código que
no cambia entre versiones es lo que permite decir «este fallo subió 300% desde
la 3.7.2».

### 4.4 Casi en tiempo real

El canal WebSocket ya está conectado y con latido cada 5 minutos. Tres ajustes
lo vuelven inmediato:

1. **Vaciar la cola cuando el relay se conecta**, en vez de esperar el
   temporizador de 15 s.
2. **Enviar una foto de salud al conectar** y luego cada 15 min, ampliando
   `healthPayload()`, que hoy sólo manda versión, esquema y nombre del equipo.
3. **Los `critical` no esperan turno**: una caída de la aplicación se envía en el
   momento, sin pasar por el lote.

Con eso, un cliente que se cae aparece en su panel en segundos, no en cuarto de
hora.

---

## 5. Plan por fases

Cada fase se puede entregar y probar sola. Ninguna obliga a la siguiente.

### Fase 1 — Ver algo, ya (1 día)

- Botón «Exportar diagnóstico» (Opción B).
- Huella y contador, para que la cola no se infle.

Sin servidor, sin desplegar nada. Al terminar, cuando un cliente llame, usted
pide un archivo y ve qué pasó.

### Fase 2 — El receptor (2 a 3 días)

- Servidor mínimo con verificación de firma y los tres endpoints (§3).
- Registro de tiendas que emita `cloud_api_key` y `cloud_store_id`.
- Compilar con `CLOUD_SERVICES_ENABLED = true`.
- Puente de avisos a su canal (Opción C).

Al terminar, los errores le llegan solos.

### Fase 3 — Lo preventivo (2 días)

- Servicio de chequeo cada 15 min con los códigos de §4.1 y §4.2.
- Ampliar `healthPayload()`.
- Pruebas de cada umbral, incluido que **no** dispare cuando no debe.

Al terminar, usted llama al cliente antes que el cliente a usted.

### Fase 4 — Tiempo real y comandos (2 días)

- Vaciado al conectar y envío inmediato de los `critical`.
- Usar los comandos que ya existen (`health.get`, `report.sales`) desde su panel
  para mirar una tienda en vivo.

---

## 6. Lo que hay que cuidar

**El consentimiento no se negocia.** La pantalla de Privacidad le promete al
comerciante qué se envía. Cada campo nuevo pasa por el saneador y por
`tests/diagnostics-redaction.test.ts`. Si un dato no puede explicarse en esa
pantalla, no se envía.

**Los umbrales se equivocan al principio.** Un aviso que salta cuando no debe
enseña a ignorarlos, y entonces no sirven para nada. Arranque con pocos y
holgados, y apriételos con datos reales.

**Guardar sólo lo necesario, el tiempo necesario.** Definir cuánto vive un
diagnóstico en su servidor antes de borrarse. Son datos de sus clientes.

**Un cliente puede decir que no.** Si apaga el diagnóstico, todo esto se apaga
para él y hay que seguir pudiendo darle soporte por las otras vías.

---

## Anexo — De dónde sale cada cosa

| Pieza | Archivo |
|---|---|
| Reglas de tachado y armado del evento | [`main/services/diagnostics.ts`](main/services/diagnostics.ts) |
| Pruebas de la promesa de privacidad | [`tests/diagnostics-redaction.test.ts`](tests/diagnostics-redaction.test.ts) |
| Cola, reintentos, firma, relay y comandos | [`main/services/cloud-sync.ts`](main/services/cloud-sync.ts) |
| Interruptor de compilación | [`shared/brand.ts`](shared/brand.ts) |
| Enganche de los 500 del API | [`main/server.ts`](main/server.ts) |
| Enganche de caídas | [`main/index.ts`](main/index.ts) |
