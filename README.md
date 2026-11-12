# Runna.io

Corre y conquista el mapa. Runna tiene dos modos a la vez:

- **Modo global**: cada carrera suma al mapa del mundo el área nueva que encierra. Nadie te la puede quitar. Hay rankings mundial, de tu país, de tu ciudad, de tus amigos y de tu club, de siempre y del mes. Los rankings solo muestran el área total, nunca recorridos.
- **Modo competición**: para quien está en un club. Ciclos de 14 días (hora de Madrid):
  - **Competición:** de viernes a domingo de la semana siguiente (10 días), en un mapa que empieza vacío. Se puntúa el lunes a las 6:00: hasta entonces cuentan las carreras que empezaron antes del domingo a las 23:59 y llegan tarde (reloj, Strava).
  - **Quién participa:** los miembros que corrieron en los 14 días anteriores al inicio. Los inactivos reciben un aviso. En los modos individuales entran con su primera carrera (en Eliminación, solo antes del primer corte); en los de equipo contra equipo (Por equipos, Duelo, Derbi) la plantilla se cierra al empezar.
  - **Descanso:** de lunes a jueves (4 días). Aparecen cofres ilustrados alrededor de las ciudades de los clubes y cada miembro tiene 3 retos.
  - **Modos** (rotación de 8, con alternativas si el club no llega al mínimo):
    - Todos contra todos.
    - Duelo contra otro club de nivel parecido.
    - Banderas: puntos por horas con banderas repartidas por la ciudad.
    - Por equipos.
    - Derbi contra un club de tu ciudad.
    - Eliminación: cortes cada 2 días, ajustados al tamaño del club para que al final quede uno.
    - Exploradores: gana quien más mapa global nuevo descubre.
    - Objetivo común.
  - **Poderes:** de competición (escudos, robos, Venganza, Emboscada, Radar…), globales con tope (Turista, Expedición, Alba…) y de descanso (Llave Maestra, Mapa del Tesoro…), con caducidad.
  - **Al terminar:**
    - Se reparten recompensas, puntos de liga y Elo.
    - Cada uno recibe sus **logros** (Conquistador, Ladrón, Fondista, Constante, Muro, MVP…), que se guardan en el perfil.
    - La app abre una ventana con el resumen: resultado del club, tus números, logros, cofres que abrir y la próxima competición.
    - El mapa de competición se borra.
  - **Clubes:**
    - Tipos de entrada: abierto, con aprobación o solo con invitación.
    - El líder decide quién puede invitar.
    - Descripción del club.
    - Roles: líder, oficiales y miembros.
    - Chat con menciones, respuestas y reacciones. Los oficiales pueden borrar mensajes y silenciar, y se puede denunciar y bloquear.

Las reglas y catálogos (poderes, caducidades, modos, retos, piezas de escudo, umbrales anti-trampas) están en [`shared/game.ts`](shared/game.ts).

- **App de iPhone**: SwiftUI nativa (iOS 17+) en [`ios/`](ios/README.md). Es el único cliente: la web se ha retirado.
- **API**: Cloudflare Worker (Hono) en [`worker/`](worker/), base de datos Turso (libSQL/SQLite) con Drizzle ORM.

## Estructura

```
runna-io/
├── ios/                    App nativa de iPhone (Xcode, SwiftUI)
├── worker/                 API en Cloudflare Workers (Hono)
│   └── src/
│       ├── index.ts        Entrada: fetch, cron (scheduled) y cola de territorio
│       ├── routes.ts       Endpoints /api/* (cuenta, carreras, amigos, feed, integraciones)
│       ├── gameRoutes.ts   Endpoints del juego: clubes, temporada, inventario, rankings, mapa global
│       ├── runPipeline.ts  Procesado de cada carrera: anti-trampas, mapa global, competición, cofres, retos
│       ├── antiCheat.ts    Validación de carreras (ritmo, vehículos, saltos de GPS, duplicados)
│       ├── globalTerritory.ts  Geometría del mapa global
│       ├── season.ts       Motor de temporada: ciclos, emparejamiento de duelos, puntuación, recompensas
│       ├── cycles.ts       Calendario de ciclos (Europe/Madrid)
│       ├── gameStorage.ts  Acceso a datos del juego
│       ├── cron.ts         Tareas programadas (se ejecutan dentro del Worker)
│       ├── pages.ts        Páginas públicas: /privacy, /terms, /support, /invite, /open
│       ├── garmin.ts       Garmin Connect (OAuth2 PKCE + Activity API push)
│       ├── auth.ts         Sesiones (Bearer token), admin, OAuth state, tareas
│       ├── passwords.ts    Hash de contraseñas (PBKDF2)
│       ├── pushHelper.ts   Notificaciones push APNs (iPhone)
│       ├── email.ts        Emails (SendGrid / Resend)
│       └── storage.ts      Acceso a datos
├── shared/schema.ts        Esquema de la base de datos (Drizzle)
├── shared/game.ts          Reglas y catálogos del juego
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
npm test             # tests unitarios del juego (worker/test)
```

La forma más rápida de tener una API local con datos es la de las pruebas end-to-end: ejecuta el Worker en Node con una base de datos SQLite de prueba y la llena con usuarios, amigos, dos clubes, una competición en marcha (el servidor de prueba coloca "hoy" dentro de una), carreras que conquistan el mapa global y roban en el de competición, una carrera rechazada por el anti-trampas, objetos en el inventario, un cofre y comentarios.

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
| season-tick | cada 5 minutos: reset inicial (una vez), empieza y termina las competiciones (cierre el lunes a las 6:00), cortes de la Eliminación, cofres de los días de descanso, caducidad de objetos y, una vez al día, borra los mensajes de chat de más de 90 días |
| polar-auto-sync | cada 5 minutos |
| inactivity-check | 10:00 y 19:00 |
| suunto-auto-sync | en el minuto 30 de cada hora |

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
| `GARMIN_CLIENT_ID`, `GARMIN_CLIENT_SECRET` | Para Garmin | Consumer key y secret de la app en el portal de Garmin ([ver abajo](#garmin)) |
| `GARMIN_WEBHOOK_SECRET` | No | Si está, la URL del webhook de Garmin debe llevar `?key=<secreto>` (Garmin no firma sus avisos) |
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

## Temporadas y reset de lanzamiento

- **Reset inicial:** la primera vez que corre el cron de la versión nueva (`season-tick`) se hace un reset único del juego antiguo (`ensureSeasonReset` en `worker/src/season.ts`).
  - Se borran todas las carreras, territorios, feed, métricas, poderes y cofres.
  - Se conservan usuarios, amigos, clubes e integraciones.
  - Las carreras empezadas antes del reset ya no se importan ni cuentan (`season_reset_at` en `app_settings`).
  - Para repetirlo a mano: `POST /api/admin/season/reset` con `{"confirm":"RESET"}`.
- **Calendario:** la primera competición empieza el viernes `SEASON_ANCHOR_DATE` de [`shared/game.ts`](shared/game.ts). La variable del Worker `SEASON_ANCHOR_DATE` (`YYYY-MM-DD`, un viernes) lo cambia sin tocar código. Antes de esa fecha es pretemporada (funcionan los cofres y retos de descanso).
- **Endpoints de administración:**
  - `POST /api/admin/season/tick` con `{"time":"<ISO>"}` ejecuta el motor de temporada como si fuera esa hora (pruebas).
  - `POST /api/admin/season/runs-from` con `{"at":"<ISO>"}` mueve la fecha desde la que cuentan las carreras.
  - Los endpoints de la competición de amigos antigua ya no actúan:
    - `/api/treasures/active` no lista nada.
    - `/api/tasks/spawn-treasure` y `/api/tasks/weekly-summary` responden `skipped`.
    - `/api/admin/competition`, `/api/admin/reset-for-competition`, `/api/admin/spawn-treasure` y `/api/admin/retrofix-route` responden 410 e indican el endpoint nuevo.
- **Base de datos:** el Worker crea solo las tablas y columnas nuevas al arrancar. [`migrations/0015_season_phase2.sql`](migrations/0015_season_phase2.sql) recoge los mismos cambios por si se prefiere aplicarlos a mano. Son estos:
  - `competition_runs`.
  - Banderas.
  - `user_awards`.
  - Chat del club.
  - Tipos de entrada de los clubes.
- **Pruebas de punta a punta del juego completo:**
  - `season-test.mjs`:
    - Clubes, competición, inactivos y cierre a las 6:00.
    - Duelos y Elo.
    - Logros y resumen de fin de competición.
    - Chat.
    - Descanso, cofres y retos.
    - Revisiones.
  - `modes-test.mjs`: los modos Banderas, Derbi, Eliminación y Exploradores, y cada poder.

  ```bash
  rm -f scripts/e2e/.build/season.db
  DATABASE_URL=file:scripts/e2e/.build/season.db npx drizzle-kit push --force
  node scripts/e2e/season-test.mjs
  ```

  ```bash
  rm -f scripts/e2e/.build/modes.db
  DATABASE_URL=file:scripts/e2e/.build/modes.db npx drizzle-kit push --force
  node scripts/e2e/modes-test.mjs
  ```

## Garmin

Integración con el Garmin Connect Developer Program (Activity API), en `worker/src/garmin.ts`. Garmin **empuja** cada actividad (resumen + puntos GPS) al Worker unos minutos después de que el usuario sincronice el reloj con Garmin Connect; no hay sondeo. Con acceso Starter no hay histórico: solo llegan las actividades posteriores a la conexión.

1. En el [portal de desarrolladores](https://developerportal.garmin.com) crea la app con el permiso **Activity API** y copia el *consumer key* y el *consumer secret*:

   ```bash
   npx wrangler secret put GARMIN_CLIENT_ID -c wrangler.worker.toml
   npx wrangler secret put GARMIN_CLIENT_SECRET -c wrangler.worker.toml
   npx wrangler secret put GARMIN_WEBHOOK_SECRET -c wrangler.worker.toml   # una cadena aleatoria larga
   ```

2. Redirect URL de OAuth: `https://runna-io-api.runna-io-api.workers.dev/api/garmin/callback`.
3. En **Endpoint Configuration** (`https://apis.garmin.com/tools/endpoints`) apunta a `https://runna-io-api.runna-io-api.workers.dev/api/garmin/webhook?key=<GARMIN_WEBHOOK_SECRET>`, en modo **push** (también acepta ping), estos tipos: **Activity Details**, **Deregistrations** y **User Permissions Change**. Deja desactivados los demás.
4. La fila Garmin aparece en la app (Perfil → Servicios conectados) en cuanto `/api/garmin/status` dice `configured: true`.

Prueba end-to-end con Garmin simulado: compila el Worker como en "API en local" y ejecuta

```bash
rm -f scripts/e2e/.build/garmin.db
DATABASE_URL=file:scripts/e2e/.build/garmin.db npx drizzle-kit push --force
node scripts/e2e/garmin-test.mjs
```

## Páginas que sirve el Worker

| Ruta | Qué es |
|---|---|
| `/privacy` | Política de privacidad (URL para App Store Connect) |
| `/terms` | Condiciones de uso |
| `/support` | Soporte (URL para App Store Connect) |
| `/invite/<token>` | Enlace de invitación de amistad: abre `runnaio://friends/accept/<token>` en la app |
| `/club-invite/<token>` | Enlace de invitación a un club: abre `runnaio://clubs/join/<token>` en la app |
| `/open?tab=<map\|rankings\|activity\|club\|friends\|profile>` | Abre la app en una pestaña (lo usan los botones de los emails) |

En producción: `https://runna-io-api.runna-io-api.workers.dev/privacy`, `/terms` y `/support`.

## Seguridad de la API

- Al iniciar sesión o confirmar el registro, el servidor da un token de sesión. La app lo guarda en el llavero y lo envía como `Authorization: Bearer <token>`. En la base de datos solo se guarda su hash; `POST /api/auth/logout` lo revoca.
- Los endpoints con datos privados usan el usuario del token, no el ID que llegue en la URL o en el body.
- Las contraseñas se guardan con PBKDF2 (las antiguas se actualizan solas en el siguiente inicio de sesión).
- Límite de intentos (tabla `auth_attempts`, ver `worker/src/rateLimit.ts`): 10 contraseñas incorrectas por cuenta o 30 por IP en 15 minutos bloquean el inicio de sesión durante 15 minutos (respuesta 429 con `Retry-After`), y 5 códigos de verificación incorrectos bloquean ese paso igual. El error de inicio de sesión es el mismo si la cuenta no existe o si la contraseña está mal.
- Registro con email confirmado: `POST /api/auth/register/start` comprueba el formulario y que el email y el usuario no estén ya en uso (sin distinguir mayúsculas) y envía un código de 6 dígitos (válido 15 minutos; como mucho 4 códigos por hora y email y 10 registros por hora e IP). La cuenta no se crea hasta que `POST /api/auth/register/confirm` recibe el código; entonces se crea ya verificada e inicia sesión. `POST /api/auth/register/resend` manda un código nuevo. Mientras tanto, los datos esperan en `pending_signups` (contraseña y código con hash; se borran un día después). 5 códigos incorrectos anulan el código. `POST /api/users` ya no crea cuentas (responde 426 a las versiones antiguas de la app).
- "He olvidado mi contraseña": `POST /api/auth/password-reset/request` envía un código de 6 dígitos por email (válido 15 minutos, como mucho 3 emails por hora y cuenta; responde lo mismo exista o no la cuenta) y `POST /api/auth/password-reset/confirm` con el código y la contraseña nueva inicia sesión y cierra las demás sesiones. 5 códigos incorrectos anulan el código.
- Juego limpio (`worker/src/antiCheat.ts`): cada carrera queda como `accepted`, `flagged` (cuenta, pero en revisión) o `rejected` (se guarda en el historial, pero no cuenta). La app recibe el resultado en `validation` al subirla y en `/api/conquest-result`.
  - **No cuentan:**
    - Ritmo medio más rápido que 2:50 min/km o más lento que 12:00 min/km (andando), a partir de 1 km. Los tramos parados no cuentan para el ritmo cuando hay tiempos por punto.
    - Más del 15 % de la distancia por encima de 25 km/h (bici o coche).
    - Una duración mayor que el tiempo entre el inicio y el final.
    - La misma carrera subida dos veces desde distintas fuentes: se solapa en el tiempo con otra y solo cuenta una.
  - **Se recortan del territorio:** los tramos por encima de 30 km/h de más de 200 m y los saltos de GPS imposibles.
  - **Van a revisión:**
    - Más de 3 saltos de GPS.
    - Un ritmo demasiado constante (coche con control de crucero).
    - Una frecuencia cardíaca muy baja para la velocidad.
    - Más de 10 km² de área nueva en una carrera o más de 20 km² en un día.
  - La app manda los tiempos de cada punto (`pointTimes`) y las importaciones solo el recorrido, así que las comprobaciones por tramo solo se hacen cuando hay tiempos.
  - Los administradores revisan con `GET /api/admin/runs/flagged` y `POST /api/admin/runs/<id>/review` (`{"action":"approve"}` o `{"action":"revert"}`); revertir reconstruye el mapa global y el de competición del corredor.
- Privacidad del modo global:
  - Los rankings solo devuelven el área total, nunca geometrías.
  - El mapa global solo superpone el territorio de amigos y compañeros de club.
  - Los recorridos GPS (`GET /api/routes/<userId>`) solo los ven el propio corredor, sus amigos y sus compañeros de club; al resto se le responde 403 `private_runs`.
  - La ubicación de casa (`home_lat`/`home_lng`, redondeada a ~1 km) nunca sale de la API.
- Los endpoints `/api/admin/*` y `/api/tasks/*` exigen el secreto de administración (o la ejecución interna del cron).
- Denuncias y bloqueos (requisito 1.2 de Apple): los usuarios bloqueados se filtran del feed, comentarios, búsquedas, solicitudes e invitaciones en ambos sentidos. Cada denuncia se guarda y se avisa por email.
- Los tokens de push que Apple da por muertos (410, `BadDeviceToken`) se borran automáticamente.
- Borrar la cuenta desde la app elimina todos los datos del usuario.

## Licencia

MIT
