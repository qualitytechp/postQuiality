# Bot de WhatsApp para los compradores — viabilidad y plan

Un agente con IA que atienda a **quien le compra a cada comerciante**: estado del
pedido, horarios, qué hay disponible.

**Fecha:** 12 de septiembre de 2026 · **Veredicto: viable, pero es un producto
nuevo, no una función.** Lo que decide el calendario no es el código.

---

## 1. El veredicto en una frase

Técnicamente se puede, y buena parte de la tubería ya está construida. Lo que
manda el reloj es que **Meta tiene que aprobarlo a usted como proveedor** antes
de poder conectar el WhatsApp de sus clientes. Eso no se programa: se tramita.

---

## 2. El problema que define todo: un número por comerciante

El bot atiende a los compradores **del fruver**, así que tiene que contestar
desde el número **del fruver** — no desde el suyo. Con cien clientes son cien
números y cien cuentas de WhatsApp Business.

Hay tres formas de resolverlo, y sólo una sirve:

| Camino | Qué implica | Sirve |
|---|---|---|
| Cada comerciante se registra solo en Meta | verificación de empresa, plantillas, tokens | **no**: ningún fruver va a hacer ese trámite |
| Todos comparten el número de usted | el comprador ve su marca, no la de la tienda; los límites y la reputación se comparten | **no** |
| **Embedded Signup** de Meta | el comerciante conecta su WhatsApp desde dentro de su aplicación, en unos clics | **sí**, es lo diseñado para esto |

Embedded Signup exige que usted se registre como **Tech Provider** de Meta:
revisión de la aplicación, verificación de empresa y compromisos de cumplimiento.
**Ese es el paso lento, y es el que hay que arrancar primero** porque corre en
paralelo con todo lo demás.

---

## 3. La regla que rompe la mayoría de los planes

**La ventana de 24 horas.** El bot sólo puede conversar libremente durante las 24
horas siguientes a que el comprador escriba. Pasado eso, únicamente plantillas
aprobadas por Meta.

Para un bot que **responde** preguntas esto encaja bien: el comprador escribe
primero, y ahí se abre la ventana. Para **avisar** («su pedido está listo») hace
falta plantilla aprobada, y cada plantilla se aprueba una por una.

Conviene diseñar con eso desde el principio, no descubrirlo después.

---

## 4. El problema que nadie ve venir: el bot no sabe nada

Un tutorial conecta el bot a un modelo y ya. Aquí no alcanza, porque **el bot
tiene que responder sobre esa tienda en concreto**: su catálogo, sus precios, sus
pedidos. Y esos datos **no están en la nube** — este POS es primero local, y la
base vive en el computador del comerciante.

Tres maneras de resolverlo:

| Cómo | Ventaja | Costo |
|---|---|---|
| **Preguntarle al POS en vivo** por el canal que ya existe | el dato siempre está al día; no se copia nada a la nube | si el computador está apagado, no hay respuesta |
| Copiar catálogo y pedidos a la nube | responde aunque la tienda esté cerrada | duplica datos del comerciante fuera de su máquina |
| Correr el bot en el POS | todo local | cada tienda necesitaría su token y su salida a internet |

**Recomiendo el primero**, y por una razón concreta: el canal bidireccional ya
está construido y probado. El POS ya responde estos comandos:

```
orders.get · orders.live · report.sales · report.dashboard
report.hourly · report.items · report.payments · health.get
```

Faltaría agregar dos: **`catalog.search`** (¿tienen aguacate, a cuánto?) y
**`order.status`** por teléfono del comprador. Es trabajo acotado sobre una
tubería que ya funciona.

> La limitación hay que decirla clara: **si el computador de la tienda está
> apagado, el bot no puede consultar nada.** Se resuelve con una respuesta
> honesta («en este momento no puedo consultar, ya le escribo») y con un caché
> corto del catálogo, que cambia poco.

---

## 5. Cómo queda el flujo

```
comprador ─> WhatsApp ─> webhook Meta ─> Worker Cloudflare
                                            │
                                            ├─> modelo de IA (entiende la pregunta)
                                            │
                                            └─> relay ─> POS de ESA tienda ─> dato real
                                                              │
comprador <─ WhatsApp <─ respuesta <────────────────────────────┘
```

Todo del lado del servidor. **El POS no cambia salvo los dos comandos nuevos**, y
el token de Meta nunca sale de su infraestructura.

---

## 6. La IA: lo que debe y no debe hacer

Un bot que inventa un precio es peor que no tener bot, porque **el que queda mal
es el comerciante**, no usted.

Tres reglas que no son negociables:

1. **Sólo responde con datos que consultó.** Si `catalog.search` no devuelve el
   producto, la respuesta es «no lo tengo», nunca una suposición.
2. **Los precios salen del POS, no del modelo.** El modelo entiende la pregunta y
   redacta; el número lo pone la consulta.
3. **Sabe cuándo callarse.** Reclamos, devoluciones o cualquier cosa con plata
   de por medio pasan a una persona.

Y el comerciante debe poder **apagarlo** en cualquier momento, igual que hoy
puede desconectar WhatsApp.

---

## 7. Costos — y aquí hay una sorpresa buena

**Verificado el 12 de septiembre de 2026 en la documentación de Meta.** Yo había
escrito que se cobra por conversación; eso **dejó de ser cierto el 1 de julio de
2025**. Ahora se cobra **por mensaje, y sólo las plantillas**.

Lo que dice la página, textual: *«All non-template messages are free»* y
*«Messages sent from a WhatsApp user to a business are not charged»*.

**Aplicado a este bot:**

El comprador escribe primero. Eso abre la ventana de 24 horas. Todo lo que el
bot conteste dentro de esa ventana **es mensaje normal, no plantilla**.

> **Del lado de Meta, un bot que responde no cuesta nada.**

Lo único que se paga es lo que el negocio inicia fuera de la ventana: la factura
(plantilla de utilidad) y cualquier aviso tipo «su pedido está listo».

Entonces los costos reales quedan así:

| Concepto | Costo |
|---|---|
| Que el bot atienda a los compradores | **$0 para Meta** |
| El modelo de IA | por mensaje procesado — **el costo principal** |
| Cloudflare | casi nada en este volumen |
| Mandar facturas y avisos | tarifa de plantilla, Colombia tiene la suya |

Esto cambia la conversación de negocio: el costo que manda **no es WhatsApp,
es la IA**. Y ése sí se controla — con respuestas cortas, con caché de las
preguntas repetidas, y sin llamar al modelo para lo que se resuelve con una
consulta directa.

---

## 8. Plan por fases

| Fase | Qué | Cuánto | Bloquea a |
|---|---|---|---|
| **0** | Solicitar Tech Provider y verificación de empresa en Meta | trámite, días o semanas | todo lo demás |
| **1** | Quitar Baileys (ver `planWhatsAppOficial.md`) | 1–2 días | nada |
| **2** | Envío de facturas por API oficial, con plantilla aprobada | 2–3 días | fase 0 |
| **3** | Embedded Signup: que el comerciante conecte su número desde el POS | 3–5 días | fase 0 |
| **4** | `catalog.search` y `order.status` en el relay | 2 días | nada |
| **5** | El bot: webhook, modelo, guardarraíles, apagado por tienda | 5+ días | 3 y 4 |

**Empiece por la 0 hoy mismo**, aunque no vaya a programar nada esta semana: es
la única que no depende de usted. Y la 1 y la 4 se pueden hacer en paralelo,
porque no esperan a Meta.

---

## 9. Lo que le recomiendo

Haga las fases **0 y 1 ya**. La 0 arranca el reloj de Meta; la 1 le quita de
encima el riesgo de que le bloqueen el número a un cliente, que sigue vivo
mientras Baileys esté conectado.

**Antes de la fase 5, pruebe la 3 con un solo cliente.** Asocampo sirve. Si un
fruver real no logra conectar su WhatsApp con Embedded Signup, el bot no importa
— y eso se sabe en un día de prueba, no después de construirlo.

Sobre el video: no pude verlo, pero lo que promete el título encaja con las
fases 2 y 5. Lo que estos tutoriales suelen dar por resuelto es la fase 0 —
tener ya la cuenta aprobada— y la fase 3, que es la que de verdad cuesta cuando
el número no es suyo sino el de su cliente.
