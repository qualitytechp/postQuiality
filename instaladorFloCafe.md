# Instalador FloCafe (Windows)

Cómo generar el `.exe` de instalación de escritorio y llevarlo a otro equipo,
paso a paso.

**Plataforma:** Windows 10/11 (x64) · **Node.js:** 22 o superior · **Salida:** `release\`

---

## Generar el instalador

Se corre una sola vez por versión, desde la carpeta del proyecto. Cada paso
depende del anterior.

### 1. Cerrar todo lo que esté usando la base de datos

Si el backend está corriendo (`node dev-server.js`, o la app de escritorio
abierta), tiene bloqueado el archivo nativo de la base de datos y el
siguiente paso va a fallar. Cerrá esas ventanas/procesos antes de continuar.

### 2. Reinstalar las dependencias exactas

Borra `node_modules` y lo reconstruye desde cero, siguiendo al milímetro lo
que dice `package-lock.json` — así el instalador sale con las mismas
versiones con las que se probó el sistema.

```
npm ci
```

Tarda entre 30 segundos y un par de minutos según la conexión. Termina con
una línea tipo `added 655 packages` — si corta antes con un error, no sigas
al paso 3.

### 3. Compilar y empaquetar

Un solo comando hace tres cosas en cadena: construye el frontend, compila el
backend, y arma el instalador con electron-builder.

```
npm run release:win
```

Es el paso más largo (varios minutos la primera vez, porque además descarga
el binario de Electron). Termina con líneas `building block map` y `signing
with signtool.exe` — eso confirma que el `.exe` quedó armado.

### 4. Ubicar el archivo

Todo queda en la carpeta `release`, en la raíz del proyecto. El único
archivo que hace falta compartir es el `.exe` — el resto son auxiliares del
empaquetado.

```
FloCafe\release\qualitytech-pos-3.7.2-win-x64.exe
```

El número de versión sale de `package.json`, así que va a cambiar en cada
release.

---

## Llevarlo a otro equipo

Ese único archivo `.exe` es autocontenido — se copia por USB, red o nube, no
necesita nada más.

1. Copiá el `.exe` a la otra PC (Descargas está bien).
2. Ejecutalo. Si Windows muestra **"Windows protegió su PC"**, hacé clic en
   **Más información → Ejecutar de todas formas** — es normal en un
   instalador sin firma digital, no significa que esté dañado.
3. Completá el asistente (Next → Install → Finish). Se puede elegir la
   carpeta de instalación.
4. Abrí el programa siempre desde el acceso directo que crea el instalador
   (Escritorio o Menú Inicio) — **no** volviendo a ejecutar el `.exe`
   descargado cada vez.

---

## Problemas comunes

Los que ya nos aparecieron armando este mismo instalador.

**`npm ci` — Error EPERM al borrar `better-sqlite3\prebuilds\win32-x64.node`**
Un proceso Node todavía tiene cargada la base de datos y Windows no deja
borrar ese archivo mientras está en uso.
→ Cerrá el backend (`node dev-server.js`) o la app de escritorio, y corré
`npm ci` de nuevo.

**Editor — Decenas de errores tipo "Cannot find name 'require'"**
Señal de que `npm ci` se cortó a mitad de camino y `node_modules` quedó
incompleto — faltan los tipos de Node.js.
→ Volvé a correr `npm ci` hasta que termine sin errores; el editor se limpia
solo.

**Otro equipo — El programa corre desde una carpeta temporal y se cierra solo**
Click derecho sobre el acceso directo → **Abrir ubicación del archivo**. Si
la ruta contiene `AppData\Local\Temp`, el antivirus está aislando el
programa por no estar firmado digitalmente.
→ Agregá una excepción en el antivirus para la carpeta de instalación, o
desinstalá y volvé a instalar completando el asistente en vez de re-ejecutar
el archivo descargado.

> **Sobre la firma digital:** este proyecto no tiene certificado de firma de
> código configurado, así que Windows SmartScreen y algunos antivirus van a
> marcar el instalador como "desconocido" la primera vez. Es informativo, no
> un error de la build.
