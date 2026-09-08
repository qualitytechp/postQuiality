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
