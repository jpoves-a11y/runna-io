# Runna.io 🏃‍♂️

Corre y conquista tu ciudad. Cada carrera convierte tu recorrido en territorio en el mapa. Si corres por el territorio de un amigo, se lo robas.

- **Web / PWA**: React + Vite, desplegada en Cloudflare Pages.
- **App de iPhone**: SwiftUI nativa en [`ios/`](ios/README.md).
- **API**: Cloudflare Worker (Hono) en [`worker/`](worker/), base de datos Turso (libSQL/SQLite) con Drizzle ORM.

## Estructura

```
runna-io/
├── client/               Web (React + Vite + Tailwind + Leaflet)
├── worker/               API en Cloudflare Workers (Hono)
│   └── src/
│       ├── routes.ts     Endpoints /api/*
│       ├── auth.ts       Sesiones (Bearer token), admin, OAuth state, QStash
│       ├── passwords.ts  Hash de contraseñas (PBKDF2)
│       ├── pushHelper.ts Notificaciones Web Push y APNs (iPhone)
│       └── storage.ts    Acceso a datos
├── shared/schema.ts      Esquema de la base de datos (Drizzle), compartido
├── migrations/           SQL de migraciones
├── ios/                  App nativa de iPhone (Xcode)
├── scripts/e2e/          API local con datos de prueba (tests de la app de iPhone)
└── scripts/maintenance/  Scripts puntuales contra la base de datos
```

## Desarrollo de la web

```bash
npm install --legacy-peer-deps
npm run dev          # http://localhost:5000
```

En desarrollo, las llamadas a `/api` se reenvían al Worker de producción. Para usar un Worker local (`npm run worker:dev`), arranca la web con `API_PROXY_TARGET=http://localhost:8787` (en PowerShell: `$env:API_PROXY_TARGET = "http://localhost:8787"; npm run dev`).

`npm run check` comprueba los tipos de TypeScript.

## Despliegue

**API (Worker)**:

```bash
cd worker && npm install && cd ..
npx wrangler deploy -c wrangler.worker.toml
```

**Web (Pages)**:

```bash
npm run pages:build
npm run pages:deploy
```

Despliega siempre el Worker y la web juntos cuando cambie la API.

### Secretos del Worker

Se configuran con `npx wrangler secret put <NOMBRE> -c wrangler.worker.toml`.

| Secreto | Para qué |
|---|---|
| `DATABASE_URL`, `TURSO_AUTH_TOKEN` | Base de datos Turso |
| `UPSTASH_CRON_SECRET` | Tareas programadas y endpoints `/api/admin/*` (`Authorization: Bearer <secreto>`) |
| `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | Verificar las llamadas firmadas de Upstash QStash (opcional) |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_WEBHOOK_VERIFY_TOKEN` | Strava |
| `POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET` | Polar |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Notificaciones push en la web |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRIVATE_KEY` | Notificaciones push en el iPhone ([ver guía](ios/README.md#notificaciones-push-apns)) |
| `SENDGRID_API_KEY` / `RESEND_API_KEY` | Emails |

Nunca subas credenciales al repositorio: `.env*` y `.dev.vars` están en `.gitignore` (hay una plantilla en `.env.example`).

## Pruebas end-to-end

`scripts/e2e/` ejecuta el Worker en local con una base de datos SQLite de prueba y la llena con datos de ejemplo: usuarios, amigos, carreras que crean y roban territorio, y comentarios. El workflow de iOS lo usa para abrir la app en el simulador con esos datos y hacer capturas de cada pestaña (se descargan desde la ejecución en GitHub Actions, en "Artifacts").

```bash
npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
  --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --external:@libsql/client
DATABASE_URL=file:scripts/e2e/.build/e2e.db npx drizzle-kit push --force
node scripts/e2e/server.mjs      # API de prueba en http://127.0.0.1:8787
node scripts/e2e/seed.mjs        # en otra terminal
```

## Seguridad de la API

- Al iniciar sesión, registrarse o verificar el email, el servidor da un token de sesión. Los clientes lo envían como `Authorization: Bearer <token>`. En la base de datos solo se guarda su hash.
- Los endpoints con datos privados usan el usuario del token, no el ID que llegue en la URL o en el body.
- Las contraseñas se guardan con PBKDF2 (las antiguas se actualizan solas en el siguiente inicio de sesión).
- Los endpoints `/api/admin/*` exigen el secreto de administración.
- Las sesiones de antes de este cambio no tienen token: la web las sigue aceptando mientras el Worker antiguo esté desplegado, y cuando se despliega el nuevo, cada usuario tiene que iniciar sesión una vez más.

## Licencia

MIT
