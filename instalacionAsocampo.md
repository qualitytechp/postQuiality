# Puesta en producción — Asocampo

Plan para dejar QualityTech POS operando en la máquina local de Asocampo, con
el catálogo real cargado y la caja arrancando en cero.

**Versión:** 3.7.2 · **Esquema de base de datos:** v91
**Última verificación:** 11 de septiembre de 2026

---

## 0. Estado actual de la máquina

Antes de proponer nada, esto es lo que hay hoy en este equipo. Importa, porque
cambia el procedimiento:

| Dónde | Qué hay | Esquema | Productos |
|---|---|---|---|
| `%APPDATA%\QualityTech POS\flo.db` | instalación empaquetada, **datos viejos de prueba** | **v80** | 48 |
| `Documents\demos\Asocampo\flo.db` | **los datos reales de Asocampo** | v91 | 146 |
| `Documents\demos\FloCafe` | el código fuente | v91 | — |

Es decir: **la aplicación instalada no tiene los datos de Asocampo**. Los datos
reales viven en la carpeta de desarrollo. El plan consiste en construir el
instalador desde el código actual, instalarlo, y **promover** la base de
Asocampo a la ubicación de producción.

> Los 9 productos sin costo cargado (Ahuyama, Arveja, Maracuyá, Penca sábila,
> Yacón, Zanahoria, Dip de pepino, Jalea de guayaba, Pandequeso) siguen así.
> No es un dato equivocado: es un dato faltante, y la pantalla lo muestra
> como «—». Se pueden cargar después sin repetir nada de esto.

---

## 1. Requisitos

| Requisito | Para qué | Comprobación |
|---|---|---|
| Windows 10/11 x64 | la aplicación se empaqueta para x64 | `winver` |
| Node.js 22 o superior | construir el instalador y correr las herramientas | `node --version` |
| Visual Studio Build Tools 2022, carga «Desktop development with C++» | compilar `better-sqlite3` | sólo si falla `npm ci` |
| ~2 GB libres | instalador, dependencias y respaldos | — |

**No se necesita `sqlite3.exe`.** Las herramientas de este plan usan el módulo
`node:sqlite`, que viene dentro de Node.

---

## 2. Construir el instalador

Desde la carpeta del código (`Documents\demos\FloCafe`):

```sh
npm ci
npm run release:win
```

Esto compila el backend, exporta el frontend y genera con electron-builder:

```
release\qualitytech-pos-3.7.2-win-x64.exe
```

Es un instalador NSIS: pide confirmación, deja escoger la carpeta y crea
accesos en el escritorio y en el menú de inicio.

**Antes de construir, conviene pasar la batería completa** (toma varios
minutos, son 151 suites):

```sh
npm test
```

---

## 3. Instalar

1. Ejecutar `qualitytech-pos-3.7.2-win-x64.exe`.
2. Aceptar la carpeta que propone.
3. **No abrir la aplicación todavía.** Si se abre antes del paso 4, creará una
   base vacía que después habrá que reemplazar igual.

La aplicación guarda sus datos en:

```
%APPDATA%\QualityTech POS\flo.db
```

---

## 4. Cargar los datos de Asocampo y dejar la caja en cero

Este es el paso que hace el trabajo. Todo está automatizado en
[`deploy/asocampo/instalar-asocampo.bat`](deploy/asocampo/instalar-asocampo.bat).

Abrir una consola en `Documents\demos\FloCafe\deploy\asocampo` y ejecutar:

```bat
instalar-asocampo.bat "C:\Users\Administrador\Documents\demos\Asocampo\flo.db"
```

El instalador pide escribir `SI` y entonces:

| Paso | Qué hace |
|---|---|
| 1 | Cierra la aplicación si está abierta, y espera a que suelte el archivo |
| 2 | Respalda la base de producción actual |
| 3 | Promueve la base de Asocampo a producción |
| 4 | Aplica el punto cero (borra ventas, caja y cierres) |
| 5 | Verifica el resultado y lo muestra en pantalla |

Al terminar debe verse:

```
  esquema: v91
  --- movimiento (debe quedar en cero) ---
    pedidos           0
    facturas          0
    sesiones de caja  0
    cierres Z         0
    mov. inventario   0
    consecutivos      0
  --- negocio (debe conservarse) ---
    productos         146
    categorías        10
    clientes          444
    proveedores       2
    usuarios          1
    ajustes           89
  integridad: ok · referencias rotas: 0
```

Si algo falla, el instalador **se detiene y no continúa**, y dice dónde quedó
el respaldo.

> **La base tiene que estar en el esquema al día antes del punto cero.**
> El script borra tablas que sólo existen desde v91. Si se corre contra una base
> vieja, el instalador lo detecta **antes de tocar nada**, nombra las tablas que
> faltan y se detiene.
>
> Por eso el orden importa: la base de Asocampo ya está en v91, así que
> promoverla (el comando de arriba) deja todo listo. En cambio, dejar en cero la
> base vieja que hay hoy en producción (v80) **no funciona de entrada**: hay que
> abrir QualityTech POS una vez para que aplique sus migraciones —hace un
> respaldo automático antes— cerrarlo, y recién ahí correr el instalador.

### Otras formas de usarlo

```bat
:: Sólo dejar en cero la base que ya está en producción, sin promover ninguna
instalar-asocampo.bat

:: Ensayar contra otra carpeta, sin tocar producción
instalar-asocampo.bat "C:\ruta\origen\flo.db" "D:\carpeta-de-ensayo"
```

---

## 5. El punto cero, en detalle

El script es [`deploy/asocampo/punto-cero.sql`](deploy/asocampo/punto-cero.sql).
Corre dentro de una transacción: o hace todo, o no hace nada.

### Qué borra

Pedidos y sus renglones · facturas y sus renglones · devoluciones · registros de
impresión · plazos de cartera de facturas · pedidos en espera · puntos de
fidelidad · historial de movimientos de inventario · sesiones de caja · cierres
Z y sus enmiendas · llaves de reintento y referencias de pago · consecutivos.

### Qué conserva

Productos con sus **precios y costos** · categorías · combos y su composición ·
clientes · proveedores · compras y sus pagos · cuentas de tesorería y
movimientos de cartera · usuarios · impuestos · **toda la configuración**.

### Tres decisiones que conviene conocer

**Las existencias no se tocan.** Se borra el *historial* de movimientos, no la
cantidad. La cifra autorizada vive en `products.stock_quantity`; el libro sólo
explica cómo se llegó a ella. El código lo confirma: `applyStockMovement()` lee
la columna, no el último movimiento, así que el próximo movimiento parte de la
existencia actual y queda cuadrado.

**Los clientes se conservan, sus puntos no.** Los 444 clientes quedan intactos,
pero el saldo de puntos se calcula sumando `loyalty_ledger`, que sí se vacía.
Si esos puntos deben respetarse, hay que quitar esa línea del script.

**Compras y cartera se conservan, pero sueltas de la caja.** Sus pagos
apuntaban a sesiones de caja que van a desaparecer. En vez de borrarlos, el
script les pone la sesión en nulo: el registro de la compra se mantiene y no
queda ninguna referencia rota.

### Los consecutivos vuelven a empezar

Verificado en una venta real sobre la base ya vaciada:

| | Primer documento después del punto cero |
|---|---|
| Pedido | `ORD-20260911-0001` |
| Factura | `INV-20260911-0001` |
| Reporte Z | `Z-1` |

---

## 6. Verificación después de instalar

1. Abrir QualityTech POS e ingresar con la cuenta de Asocampo.
2. **Productos:** deben verse los 120 del catálogo, con precio, costo y ganancia.
3. **Punto de venta:** buscar «Acelga» — debe aparecer en $ 7.000.
4. **Pedidos:** la lista debe estar vacía.
5. Hacer una venta de prueba, cobrarla en efectivo y cerrar el día.
   El reporte debe salir como **Z-1** y la caja debe cuadrar en cero.
6. Si esa venta de prueba no debe quedar, correr `instalar-asocampo.bat` sin
   argumentos: vuelve a dejar todo en cero sin tocar el catálogo.

Todo esto se probó de punta a punta sobre una copia de la base real: **15 de 15
comprobaciones en verde**, incluido el cierre con descuadre cero.

---

## 7. Respaldos

El instalador deja el respaldo en:

```
%APPDATA%\QualityTech POS\respaldos-instalacion\flo-AAAAMMDD-HHMMSS.db
```

Para volver atrás: cerrar la aplicación, borrar `flo.db`, `flo.db-wal` y
`flo.db-shm` de `%APPDATA%\QualityTech POS`, y copiar el respaldo ahí como
`flo.db`.

> **Nunca copie `flo.db` con la aplicación abierta.**
> SQLite trabaja en modo WAL: los cambios recientes viven en `flo.db-wal`, no en
> `flo.db`. Copiar sólo el archivo principal da una foto vieja — en las pruebas
> de este plan, una copia hecha así devolvió el esquema v80 en lugar del v91 que
> la base tenía de verdad. Por eso las herramientas usan `VACUUM INTO`, que
> escribe un archivo único y ya consolidado, y por eso el paso 1 cierra la
> aplicación antes de tocar nada.

### La copia desde la aplicación sólo funciona en el escritorio

**Configuración → Datos → Crear copia** exige un **PIN Maestro**, y ese PIN se
guarda cifrado con el llavero del sistema operativo. El llavero sólo existe
dentro de la aplicación de escritorio: desde el navegador (`localhost:3101`)
la copia responde **503** con «Master PIN is not available on this device».
No es una falla, es la protección funcionando — una copia lleva todos los datos
del negocio, así que el sistema prefiere negarse antes que permitir una vía sin
proteger.

Comprobado en esta máquina:

| Entorno | Llavero disponible | Copia desde la aplicación |
|---|---|---|
| Navegador (`node dev-server.js`) | no | **no**, responde 503 |
| Aplicación de escritorio (Electron) | **sí** | sí, después de fijar el PIN |

Al promover una base que ya tiene usuarios, el asistente de instalación no
vuelve a correr, así que **el PIN no queda creado solo**. Hay que fijarlo una
vez, dentro de la aplicación de escritorio:

> **Configuración → Datos → PIN Maestro** → escribirlo dos veces y guardar.

Son 4 dígitos. Sin ese paso, el botón de copia seguirá sin funcionar aunque la
aplicación esté bien instalada.

### Mientras tanto, o desde cualquier entorno

La herramienta de este plan hace la copia sin depender del llavero, y es segura
con la aplicación abierta porque usa `VACUUM INTO`:

```sh
node deploy\asocampo\herramienta.js respaldar ^
  "C:\Users\Administrador\Documents\demos\Asocampo" ^
  "C:\Users\Administrador\Documents\demos\Asocampo\respaldos-manuales"
```

---

## 8. Rutina diaria del negocio

1. Abrir caja declarando el fondo con que se arranca.
2. Vender.
3. Cerrar el día: contar el efectivo y registrarlo. El sistema compara lo
   contado contra lo esperado y numera el reporte Z.

El efectivo que se le pague a un proveedor desde **Compras** sale del cajón y
el cierre lo tiene en cuenta: es la misma plata, no dos cuentas separadas.

---

## 9. Si algo sale mal

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `No se encontro Node.js en el PATH` | Node no instalado o consola vieja | Instalar Node 22+ y **abrir una consola nueva** |
| `Device or resource busy` / no puede reemplazar la base | la aplicación sigue abierta | Cerrarla desde el Administrador de tareas y repetir |
| `Master PIN is not available on this device` al crear una copia | está usando el navegador, que no tiene llavero del sistema | Hacerlo desde la aplicación de escritorio, o usar `herramienta.js respaldar` (sección 7) |
| `Configurá un PIN Maestro abajo` al crear una copia | el llavero está, pero el PIN no se ha fijado | **Configuración → Datos → PIN Maestro**, una sola vez |
| La aplicación abre sin productos | se abrió antes del paso 4 y creó una base vacía | Volver a correr el `.bat` con la ruta de origen |
| `npm ci` falla compilando `better-sqlite3` | faltan las Build Tools de C++ | Instalar VS Build Tools 2022 con «Desktop development with C++» |
| `le faltan N tablas que el punto cero necesita` | la base está en un esquema viejo | Abrir la aplicación una vez para que migre, cerrarla, y repetir. O promover una base al día |
| El instalador se detuvo a mitad | lo dice en pantalla | La base no quedó a medias: el punto cero es una transacción. Restaurar el respaldo si hace falta |

---

## Anexo — Archivos de este plan

| Archivo | Para qué |
|---|---|
| [`deploy/asocampo/instalar-asocampo.bat`](deploy/asocampo/instalar-asocampo.bat) | El instalador. Es el único que se ejecuta a mano |
| [`deploy/asocampo/punto-cero.sql`](deploy/asocampo/punto-cero.sql) | El borrado, comentado paso a paso |
| [`deploy/asocampo/herramienta.js`](deploy/asocampo/herramienta.js) | Respaldar, promover, aplicar y verificar, con `node:sqlite` |

Los tres deben quedar juntos en la misma carpeta: el `.bat` busca a los otros
dos a su lado.

### Un detalle que la columna de ganancia dejó a la vista

Con precios y costos cargados, la pantalla de productos muestra el margen de
cada uno. Vale la pena revisar contra las facturas los que salen muy altos —
Albahaca al 1.233%, Perejil al 317%, Orellana en galleta al 389% — porque
suelen indicar un costo cargado con la unidad equivocada, no una ganancia real.
