# Comandos FloCafe

## Desarrollo
| Comando | Descripción |
|---|---|
| `npm run dev` | Inicia la app completa en Electron (limpia puertos, build frontend + backend, Electron) |
| `node dev-server.js` | Backend solo: API Express (:3001), KDS (:3002), Server App (:3003) |
| `npm run dev:frontend` | Servidor de desarrollo del frontend Next.js en browser |

## Build & Verificación
| Comando | Descripción |
|---|---|
| `npm run build` | Compila TypeScript del backend a `dist/` |
| `npm run build:frontend` | Build y export estático de Next.js a `frontend/out/` |
| `npm run lint` | Linter backend (`main/`) y frontend (`frontend/`) |
| `npx tsc --noEmit --project frontend/tsconfig.json` | Typecheck frontend sin emitir archivos |

## Tests
| Comando | Descripción |
|---|---|
| `npm test` | Suite de tests estándar |
| `npm run test:url-allowlist` | Tests de allowlist de URLs |
| `npm run audit:db` | Verificación de integridad de base de datos |
| `npm run i18n:check` | Validación de traducciones |

## Requisitos
- Node.js v22+ (recomendado v24 LTS)
- VS Build Tools 2022 con carga de trabajo "Desktop development with C++" (para better-sqlite3)

## Cómo cambiar de entorno / instancia (varias bases de datos en la misma PC)

`npm run dev` (la app completa en Electron) **siempre** usa la misma base de datos:
`C:\Users\Administrador\Documents\demos\FloCafe\flo.db`. No lee ninguna variable de
entorno para elegir otra — así que no sirve para tener dos instancias a la vez.

Para correr una instancia aislada (por ejemplo Asocampo, o cualquier otra base de
pruebas) al mismo tiempo que la app completa, usa el backend sin Electron
(`node dev-server.js`) apuntado a otra carpeta con `FLO_DEV_USER_DATA`, en otros
puertos:

```sh
npm run build   # una vez, o después de cambiar código en main/
FLO_DEV_USER_DATA="C:/Users/Administrador/Documents/demos/Asocampo" PORT=3101 KDS_PORT=3102 SERVER_APP_PORT=3103 node dev-server.js
```

- `FLO_DEV_USER_DATA` = carpeta donde vive (o se creará) `flo.db` para esa instancia.
  Cada carpeta distinta = una base de datos completamente separada.
- `PORT` / `KDS_PORT` / `SERVER_APP_PORT` = puertos de API / KDS / server-app para
  que no choquen con la instancia de `npm run dev` (3001/3002/3003).
- Se accede por navegador a `http://localhost:3101` (no abre ventana de Electron).
- Nunca apuntes dos procesos (`node dev-server.js` o `npm run dev`) a la **misma**
  carpeta/`flo.db` al mismo tiempo — SQLite con WAL tolera un solo proceso escritor
  a la vez; usarlo desde dos procesos a la vez puede corromper el archivo.

### Bases de datos conocidas en esta PC

| Entorno | Ruta | Cómo se usa |
|---|---|---|
| Restaurante (principal, la que usa `npm run dev`) | `C:\Users\Administrador\Documents\demos\FloCafe\flo.db` | `npm run dev` o `node dev-server.js` sin `FLO_DEV_USER_DATA` |
| Asocampo | `C:\Users\Administrador\Documents\demos\Asocampo\flo.db` | `FLO_DEV_USER_DATA=".../Asocampo" PORT=3101 ... node dev-server.js` |
| Instalación empaquetada real (el .exe instalado) | `C:\Users\Administrador\AppData\Roaming\QualityTech POS\flo.db` | Se abre solo con la app instalada, no con `npm run dev` |

### Respaldar antes de probar algo arriesgado

Antes de correr una migración nueva o probar algo destructivo en cualquiera de estas
bases, copia el archivo `flo.db` (la app debe estar cerrada, o usa
Configuración → Copia de seguridad → Crear copia, que sí es segura con la app abierta):

```sh
cp "C:/Users/Administrador/Documents/demos/Asocampo/flo.db" "C:/Users/Administrador/Documents/demos/Asocampo/flo.db.bak"
```
