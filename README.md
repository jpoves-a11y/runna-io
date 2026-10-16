# Runna.io

Corre y conquista tu ciudad. Cada carrera convierte tu recorrido en territorio en el mapa. Si corres por el territorio de un amigo, se lo robas. En las competiciones aparecen cofres con poderes.

- **App de iPhone**: SwiftUI nativa (iOS 17+) en [`ios/`](ios/README.md). Es el único cliente: la web se ha retirado.
- **API**: Cloudflare Worker (Hono) en [`worker/`](worker/), base de datos Turso (libSQL/SQLite) con Drizzle ORM.

## Estructura

```
runna-io/
├── ios/                    App nativa de iPhone (Xcode, SwiftUI)
├── worker/                 API en Cloudflare Workers (Hono)
│   └── src/
│       ├── index.ts        Entrada: fetch, cron (scheduled) y cola de territorio
│       ├── routes.ts       Endpoints /api/*
│       ├── cron.ts         Tareas programadas (se ejecutan dentro del Worker)
│       ├── pages.ts        Páginas públicas: /privacy, /terms, /support, /invite, /open
│       ├── auth.ts         Sesiones (Bearer token), admin, OAuth state, tareas
│       ├── passwords.ts    Hash de contraseñas (PBKDF2)
│       ├── pushHelper.ts   Notificaciones push APNs (iPhone)
│       ├── email.ts        Emails (SendGrid / Resend)
│       └── storage.ts      Acceso a datos
├── shared/schema.ts        Esquema de la base de datos (Drizzle)
├── migrations/             SQL de migraciones
├── wrangler.worker.toml    Configuración del Worker
├── scripts/e2e/            API local con datos de prueba (usada por el CI de iOS)
└── scripts/maintenance/    Scripts puntuales contra la base de datos (léelos antes de ejecutarlos)
```

## API en local

Necesitas Node.js 20 o superior.

```bash
npm ci --legacy-peer-deps
(cd worker && npm ci)
npm run check        # comprueba los tipos de shared/
```

La forma más rápida de tener una API local con datos es la de las pruebas end-to-end: ejecuta el Worker en Node con una base de datos SQLite de prueba y la llena con usuarios, amigos, carreras que crean y roban territorio, comentarios y una competición activa (cofres, poderes y resumen semanal).

```bash
mkdir -p scripts/e2e/.build
npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
  --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --external:@libsql/client
rm -f scripts/e2e/.build/e2e.db
DATABASE_URL=file:scripts/e2e/.build/e2e.db npx drizzle-kit push --force
node scripts/e2e/server.mjs      # API de prueba en http://127.0.0.1:8787
node scripts/e2e/seed.mjs        # en otra terminal; imprime un token y un userId de prueba
```

Con `E2E_RUN_CRON=1` (y opcionalmente `E2E_CRON_TIME`), `server.mjs` ejecuta una vez las tareas programadas al arrancar.

Para apuntar la app del simulador a esta API, ver [`ios/README.md`](ios/README.md). El workflow `.github/workflows/ios.yml` hace exactamente esto en un Mac de GitHub Actions y saca capturas de cada pantalla.

También puedes usar `wrangler dev` (`npm run worker:dev`, con wrangler instalado: `npm i -g wrangler` o `npx wrangler` desde `worker/`), que necesita los secretos en `.dev.vars`.

## Desplegar el Worker

```bash
(cd worker && npm ci)
npx wrangler deploy -c wrangler.worker.toml
```

`wrangler.worker.toml` declara un único Cron Trigger (`*/5 * * * *`). Cada ejecución corre dentro del propio Worker las tareas que tocan (horario Europe/Madrid, ver `worker/src/cron.ts`):

| Tarea | Cuándo |
|---|---|
| polar-auto-sync | cada 5 minutos |
| spawn-treasure | en el minuto 0 de cada hora (la tarea elige la hora del día) |
| inactivity-check | 10:00 y 19:00 |
| weekly-summary | domingos a las 20:00 |

**Upstash QStash ya no hace falta**: borra las programaciones antiguas. Los endpoints `/api/tasks/*` siguen aceptando `Authorization: Bearer <UPSTASH_CRON_SECRET>` (o una firma de QStash) para lanzarlos a mano.

La cola `territory-processing` (y su DLQ `territory-dlq`) se crea una vez con `npx wrangler queues create ...`.

### Secretos y variables del Worker

Los secretos se configuran con `npx wrangler secret put <NOMBRE> -c wrangler.worker.toml`.

| Nombre | Obligatorio | Para qué |
|---|---|---|
| `DATABASE_URL`, `TURSO_AUTH_TOKEN` | Sí | Base de datos Turso |
| `UPSTASH_CRON_SECRET` | Sí | Secreto de administración: endpoints `/api/admin/*` y lanzar `/api/tasks/*` a mano (`Authorization: Bearer <secreto>`). El nombre es histórico; ya no se usa Upstash |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRIVATE_KEY` | Sí | Notificaciones push en el iPhone ([ver guía](ios/README.md#notificaciones-push-apns)) |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_WEBHOOK_VERIFY_TOKEN` | Para Strava | Conexión con Strava |
| `POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET` | Para Polar | Conexión con Polar |
| `SENDGRID_API_KEY` / `RESEND_API_KEY` | Para emails | Verificación de email, avisos y denuncias (`EMAIL_PROVIDER` en `[vars]` elige el proveedor) |
| `WORKER_URL` | No | URL pública del Worker para enlaces de invitación y botones de los emails. Por defecto, el origen de la petición |
| `APP_DOWNLOAD_URL` | No | Enlace de App Store / TestFlight; si está, las páginas `/invite` y `/open` muestran "Descargar la app" |
| `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | No | Solo si aún llamas a `/api/tasks/*` desde QStash |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | No | Web Push de la web retirada; no hacen falta para la app |

Nunca subas credenciales al repositorio: `.env*` y `.dev.vars` están en `.gitignore` (hay una plantilla en `.env.example`).

## Páginas que sirve el Worker

| Ruta | Qué es |
|---|---|
| `/privacy` | Política de privacidad (URL para App Store Connect) |
| `/terms` | Condiciones de uso |
| `/support` | Soporte (URL para App Store Connect) |
| `/invite/<token>` | Enlace de invitación de amistad: abre `runnaio://friends/accept/<token>` en la app |
| `/open?tab=<map\|rankings\|activity\|friends\|profile>` | Abre la app en una pestaña (lo usan los botones de los emails) |

En producción: `https://runna-io-api.runna-io-api.workers.dev/privacy`, `/terms` y `/support`.

## Seguridad de la API

- Al iniciar sesión, registrarse o verificar el email, el servidor da un token de sesión. La app lo guarda en el llavero y lo envía como `Authorization: Bearer <token>`. En la base de datos solo se guarda su hash; `POST /api/auth/logout` lo revoca.
- Los endpoints con datos privados usan el usuario del token, no el ID que llegue en la URL o en el body.
- Las contraseñas se guardan con PBKDF2 (las antiguas se actualizan solas en el siguiente inicio de sesión).
- Los endpoints `/api/admin/*` y `/api/tasks/*` exigen el secreto de administración (o la ejecución interna del cron).
- Denuncias y bloqueos (requisito 1.2 de Apple): los usuarios bloqueados se filtran del feed, comentarios, búsquedas, solicitudes e invitaciones en ambos sentidos. Cada denuncia se guarda y se avisa por email.
- Los tokens de push que Apple da por muertos (410, `BadDeviceToken`) se borran automáticamente.
- Borrar la cuenta desde la app elimina todos los datos del usuario.

## Licencia

MIT
