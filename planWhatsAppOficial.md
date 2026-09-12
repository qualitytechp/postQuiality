# WhatsApp: quitar el cliente no oficial y pasar al oficial

Plan para retirar la integración basada en Baileys y dejar en su lugar la API
oficial de WhatsApp Business.

**Fecha:** 11 de septiembre de 2026 · **Versión:** 3.7.2

---

## 1. Qué hace hoy, medido

Antes de quitar nada, el alcance real de lo que hay. Esto responde también a sus
tres preguntas.

### ¿Cómo se responde un mensaje?

**No se puede, desde la pantalla.** El backend sí tiene el endpoint
(`POST /whatsapp/inbox/:id/reply`), pero la bandeja de entrada sólo ofrece el
botón **Bloquear**. Por eso no encontró cómo hacerlo: la función existe a medias.

### ¿Se puede poner un bot?

**Hoy no hay ninguno, ni respuesta automática.** Los mensajes entrantes sólo se
guardan en una tabla y se listan. Todo envío nace de una acción de una persona:
el tipo de mensaje que se registra se llama, literalmente, `manual_reply`.

### ¿Qué alcance tiene?

| Capacidad | Estado |
|---|---|
| Enviar la factura pagada al cliente | **sí**, es su uso principal |
| Recibir mensajes | sí, se guardan y se listan |
| Responder desde la aplicación | **no** (el endpoint existe, la pantalla no) |
| Bot o respuestas automáticas | no |
| Plantillas, catálogos, botones | no |
| Límite | 4 mensajes por hora al mismo número, 30 s entre uno y otro |

---

## 2. El dato que cambia el plan

**El producto ya tiene dos caminos para mandar la factura por WhatsApp**, y sólo
uno es el problemático:

| Camino | Cómo funciona | Riesgo |
|---|---|---|
| **Enlace `wa.me`** | abre WhatsApp con el mensaje escrito; la persona le da enviar | **ninguno**, es la vía oficial |
| **Envío automático** (Baileys) | el POS manda solo, sin intervención | cliente no oficial: **riesgo de bloqueo del número** |

En `PaymentModal.tsx` el botón cambia según si Baileys está conectado: si lo
está, envía solo; si no, abre el enlace.

**Esto significa que quitar Baileys no le quita al comerciante la posibilidad de
mandar la factura por WhatsApp.** Pierde que salga sola, y pierde la bandeja de
entrada. El enlace `wa.me` ya está construido, probado y en uso.

Es el argumento más fuerte para hacer el cambio: el costo real es mucho menor de
lo que parece.

---

## 3. Por qué conviene quitarlo

Usted ya lo intuyó, y la pantalla del producto lo admite: *«El teléfono que
conectes es tuyo — su riesgo de bloqueo corre por tu cuenta.»*

1. **Baileys no es un cliente oficial.** WhatsApp bloquea la automatización. El
   número bloqueado sería el del comerciante — el que usa con **sus propios
   clientes**. No es un riesgo técnico, es su herramienta de trabajo.
2. **Trasladarle ese riesgo al cliente es difícil de sostener**, aunque esté
   advertido en letra pequeña.
3. **La función está a medias**: recibe mensajes que no se pueden responder.
   Eso genera soporte, no lo evita.

---

## 4. Fase 1 — Retirar el cliente no oficial

### Qué se quita

| Archivo | Qué hacer |
|---|---|
| `main/services/whatsapp.ts` (1.156 líneas) | eliminar |
| `main/routes/whatsapp.ts` (223 líneas) | eliminar |
| `frontend/src/app/(dashboard)/whatsapp/page.tsx` | eliminar la pantalla |
| `frontend/src/components/settings/WhatsAppEnableCard.tsx` | eliminar |
| `frontend/src/hooks/useWhatsAppReady.ts` | eliminar |
| `@whiskeysockets/baileys` | quitar de `package.json` |
| Entrada «WhatsApp» en `Sidebar.tsx` | quitar |

### Qué se conserva

- **`frontend/src/lib/whatsapp-share.ts`** — el enlace `wa.me`. Es la vía
  oficial y queda como único camino.
- El botón de enviar en `PaymentModal.tsx` y en la pantalla de pedidos, dejando
  siempre la rama del enlace.
- La tabla `whatsapp_messages` y el historial **no se borran** en esta fase: son
  datos del comerciante. Se dejan de escribir y se retiran en una migración
  posterior, cuando haya certeza de que nadie los necesita.

### Puntos de cuidado

- `main/index.ts` e `main/ipc.ts` arrancan y apagan el servicio: hay que quitar
  esas llamadas o el proceso fallará al iniciar.
- `shared/role-permissions.ts` tiene permisos de WhatsApp que dejan de aplicar.
- Las claves de traducción en los 8 idiomas: quitar las que queden sin uso y
  pasar `npm run i18n:check`.
- **Avisar antes a quien lo tenga conectado.** Asocampo lo tiene ahora mismo,
  con el número **+573147157869**. Desconectarlo sin avisar se vive como una
  falla.

### Verificación

`npm run lint`, `npx tsc --noEmit` en ambos lados, `npm run i18n:check`,
`npm test`, y probar en los dos entornos que el botón de enviar factura sigue
funcionando por el enlace.

---

## 5. Fase 2 — La API oficial

### Lo que hay que conseguir

1. Cuenta de **Meta Business** verificada.
2. Un **número de teléfono** dedicado, que no puede estar registrado en la app
   normal de WhatsApp.
3. Una **plantilla de mensaje aprobada** por Meta para el recibo. Fuera de la
   ventana de 24 horas sólo se puede escribir con plantilla aprobada, y ese es
   el caso de una factura.
4. Token permanente y el identificador del número.

### Dónde debe vivir

**En su receptor de Cloudflare, no en el POS.** Por tres razones:

- El token es de su empresa; no debe estar en la máquina de cada cliente.
- Meta cobra por conversación: hay que medirlo en un solo lugar.
- Si mañana cambia el proveedor, cambia un servidor y no cien instalaciones.

El POS pide «mandá este recibo a este número»; el receptor decide cómo.

### Cómo queda el flujo

```
POS  ──(firmado)──>  receptor Cloudflare  ──>  API oficial de WhatsApp  ──>  cliente
```

Se agrega un endpoint al Worker que ya existe, reusando la verificación de firma
que ya está probada.

### Qué gana con el oficial

- Sin riesgo de bloqueo.
- Estado de entrega y lectura reales.
- Plantillas, botones y catálogo.
- Respuestas entrantes por webhook: **aquí sí se puede poner un bot**, que era
  su pregunta. Con el cliente no oficial no era responsable intentarlo.

### Qué cuesta

Meta cobra por conversación iniciada por el negocio, con precio por país. Las
respuestas dentro de las 24 horas siguientes no se cobran aparte. Conviene
estimarlo con el volumen real de facturas antes de prometerlo a los clientes.

---

## 6. Orden que recomiendo

1. **Avisar a Asocampo** que WhatsApp automático se retira, y por qué.
2. **Fase 1**, que es autocontenida y deja el producto sin riesgo de bloqueo.
   El comerciante sigue mandando facturas con el enlace.
3. **Conseguir número y plantilla** con Meta. Es el paso lento: la aprobación
   puede tardar días y no depende de nosotros.
4. **Fase 2** cuando la plantilla esté aprobada.

Separar 1 de 2 importa: la fase 1 **elimina el riesgo de inmediato**, sin
esperar a Meta. Si se hacen juntas, el riesgo sigue vivo mientras dure el
trámite.

---

## Anexo — Qué se pierde y qué no

| | Con Baileys | Sin Baileys | Con API oficial |
|---|---|---|---|
| Mandar factura al cliente | automático | **con un toque** (`wa.me`) | automático |
| Riesgo de bloqueo del número | **sí** | ninguno | ninguno |
| Bandeja de entrada | sí | no | sí, por webhook |
| Responder desde la app | **no** | no | sí |
| Bot | no | no | **sí** |
| Costo | gratis | gratis | por conversación |
