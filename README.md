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
  --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --alias:cloudflare:sockets=./scripts/e2e/cloudflare-sockets-stub.mjs --external:@libsql/client
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
| `GMAIL_APP_PASSWORD` | Para emails | Contraseña de aplicación de la cuenta de Gmail que envía los emails (`GMAIL_USER` en `[vars]`): códigos de verificación, "He olvidado mi contraseña", avisos y denuncias. Ver [Emails](#emails) |
| `SENDGRID_API_KEY` / `RESEND_API_KEY` | No | Alternativas a Gmail (`EMAIL_PROVIDER` en `[vars]` elige el proveedor); las dos necesitan un dominio propio verificado |
| `WORKER_URL` | No | URL pública del Worker para enlaces de invitación y botones de los emails. Por defecto, el origen de la petición |
| `APP_DOWNLOAD_URL` | No | Enlace de App Store / TestFlight; si está, las páginas `/invite` y `/open` muestran "Descargar la app" |
| `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | No | Solo si aún llamas a `/api/tasks/*` desde QStash |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | No | Web Push de la web retirada; no hacen falta para la app |

### Emails

Los emails salen por el servidor SMTP de la cuenta de Gmail de `GMAIL_USER` (`runna.io.service@gmail.com`). Es gratis, no necesita dominio propio y Gmail los firma, así que no acaban en spam. El límite es de unos 500 emails al día.

1. Entra en esa cuenta de Google y activa la **verificación en dos pasos** (myaccount.google.com → Seguridad). Sin ella, Google no deja crear contraseñas de aplicación.
2. Abre [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), crea una con el nombre "Runna Worker" y copia las 16 letras.
3. `npx wrangler secret put GMAIL_APP_PASSWORD -c wrangler.worker.toml` y pega las 16 letras (con o sin espacios).
4. Comprueba que funciona:

   ```bash
   curl -X POST -H "Authorization: Bearer $UPSTASH_CRON_SECRET" -H "Content-Type: application/json" \
     -d '{"to":"tu-email@ejemplo.com"}' https://runna-io-api.runna-io-api.workers.dev/api/admin/email/test
   ```

   Responde con el proveedor, el remitente, los problemas de configuración que vea (`problems`) y, si se pudo enviar, `"sent": true`. Si no, `error` trae la respuesta del servidor de correo (por ejemplo `535 ... Username and Password not accepted` si la contraseña de aplicación está mal).

Si cambias la contraseña de esa cuenta de Google, sus contraseñas de aplicación dejan de valer y tienes que crear otra.

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
- Límite de intentos (tabla `auth_attempts`, ver `worker/src/rateLimit.ts`): 10 contraseñas incorrectas por cuenta o 30 por IP en 15 minutos bloquean el inicio de sesión durante 15 minutos (respuesta 429 con `Retry-After`), y 5 códigos de verificación incorrectos bloquean ese paso igual. El error de inicio de sesión es el mismo si la cuenta no existe o si la contraseña está mal.
- "He olvidado mi contraseña": `POST /api/auth/password-reset/request` envía un código de 6 dígitos por email (válido 15 minutos, como mucho 3 emails por hora y cuenta; responde lo mismo exista o no la cuenta) y `POST /api/auth/password-reset/confirm` con el código y la contraseña nueva inicia sesión y cierra las demás sesiones. 5 códigos incorrectos anulan el código.
- Juego limpio: una carrera con un ritmo medio de más de 21 km/h (a partir de 1 km), o con una duración mayor que el tiempo entre su inicio y su final, no conquista territorio ni recoge cofres (`checkRunPlausibility` en `worker/src/territory.ts`). La app recibe un 422 con el motivo; las importadas de Strava, Polar o Suunto se guardan, pero no cuentan. La distancia que cuenta es la mayor entre la declarada y la longitud del recorrido GPS.
- Los endpoints `/api/admin/*` y `/api/tasks/*` exigen el secreto de administración (o la ejecución interna del cron).
- Denuncias y bloqueos (requisito 1.2 de Apple): los usuarios bloqueados se filtran del feed, comentarios, búsquedas, solicitudes e invitaciones en ambos sentidos. Cada denuncia se guarda y se avisa por email.
- Los tokens de push que Apple da por muertos (410, `BadDeviceToken`) se borran automáticamente.
- Borrar la cuenta desde la app elimina todos los datos del usuario.

## Licencia

MIT
