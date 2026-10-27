# Runna.io para iPhone

App nativa en SwiftUI (iOS 17 o superior). Es el único cliente de Runna.io: habla con la API del Cloudflare Worker (`worker/`).

## Qué incluye

- **Cuenta**: inicio de sesión, "He olvidado mi contraseña" (código por email), registro con verificación por email (edad mínima 14 años), cerrar sesión y borrar cuenta (Apple exige poder borrarla desde la app). Presentación inicial de cinco pantallas la primera vez.
- **Mapa**: tu territorio y el de tus amigos (MapKit), filtro por amigo, toca un territorio para ver de quién es, tus recorridos, fortificaciones y castillos.
- **Competiciones**: banner con la cuenta atrás, cofres en el mapa (común, raro, épico y legendario) que se recogen corriendo, **poderes** que se activan desde el botón ⚡, apodos, ranking de la competición, **resumen semanal** y podio final.
- **Correr**: GPS nativo que sigue grabando con la pantalla bloqueada, **Live Activity** en la pantalla bloqueada y la Dynamic Island (tiempo que corre solo, distancia, ritmo y aviso de pausa), pausa/reanudar, aviso si la ubicación no es exacta, recuperación si iOS cierra la app a mitad de carrera, y cola sin conexión: la carrera se guarda en el móvil y se sube después (sin duplicados).
- **Después de correr**: territorio conquistado y robado, a quién se lo has robado, cofres recogidos, **animación de la ruta**, enviar una foto que solo puede verse una vez, renombrar la carrera. Las carreras que llegan de Strava, Polar o Apple Salud muestran el mismo resumen al abrir la app.
- **Actividad**: feed de tus amigos (carreras, robos, cofres, apodos, récords) con "me gusta"/"no me gusta" y comentarios con respuestas y @menciones; tus carreras con mapa, renombrar y borrar.
- **Ranking** de amigos y de la competición.
- **Amigos**: solicitudes, búsqueda, perfiles con sus amigos y actividades, enlace de invitación para compartir (`/invite/<token>` abre la app y pide confirmar).
- **Seguridad**: denunciar publicaciones, comentarios y usuarios; bloquear y desbloquear (Perfil → Usuarios bloqueados).
- **Perfil**: foto, nombre, color del territorio, estadísticas de robos, apariencia clara/oscura, Strava, Polar y **Apple Salud** (importa las carreras del Apple Watch) en "Conectar dispositivos", notificaciones, soporte y enlaces legales.
- **Notificaciones push** nativas (APNs): robos de territorio, solicitudes de amistad, comentarios, cofres, resumen semanal, importaciones automáticas, etc.

## Abrir y ejecutar (Mac)

1. Descarga el repositorio y abre `ios/Runna.xcodeproj` con Xcode 16 o superior.
2. Selecciona el target **Runna** → pestaña **Signing & Capabilities**:
   - En **Team** elige tu equipo de Apple Developer.
   - Cambia **Bundle Identifier** si quieres (ahora es `com.jpoves.runnaio`). Tiene que ser único en tu cuenta.
   - Xcode creará el App ID con las capacidades que ya trae el proyecto: Push Notifications, HealthKit y Background Modes (Location updates).
   - Haz lo mismo con el target **RunnaLive** (la extensión de la Live Activity): mismo Team. Su Bundle Identifier tiene que ser el de la app seguido de `.RunnaLive` (ahora `com.jpoves.runnaio.RunnaLive`).
3. Elige tu iPhone y pulsa ▶︎.

La app habla con la API de producción (`AppConfig.apiBaseURL` en `Runna/Core/AppConfig.swift`).

Para probarla en el simulador contra una API local con datos de prueba (ver el [README principal](../README.md#api-en-local)), pasa en el esquema de Xcode las variables de entorno `RUNNA_API_BASE_URL=http://127.0.0.1:8787`, `RUNNA_TEST_TOKEN` y `RUNNA_TEST_USER_ID` (los imprime `scripts/e2e/seed.mjs`).

## Subir a TestFlight

### Desde GitHub, sin Mac (recomendado)

`.github/workflows/testflight.yml` compila, firma y sube la app en un Mac de GitHub Actions. Todo lo de abajo se hace desde el navegador (también en el móvil).

Una sola vez:

1. [developer.apple.com → Identifiers](https://developer.apple.com/account/resources/identifiers/list) → **+** → App IDs → `com.jpoves.runnaio`, con **HealthKit** y **Push Notifications**.
   - La extensión de la Live Activity usa su propio identificador, `com.jpoves.runnaio.RunnaLive`. El workflow lo crea solo (Xcode registra los identificadores que faltan con `-allowProvisioningUpdates` y la clave de API). Si prefieres crearlo a mano: **+** → App IDs → App → `com.jpoves.runnaio.RunnaLive`, sin marcar ninguna capacidad. No hace falta crear otra app en App Store Connect: va dentro de la app.
2. [App Store Connect](https://appstoreconnect.apple.com) → Apps → **+** → Nueva app con ese Bundle ID (nombre único: "Runna" ya existe).
3. App Store Connect → Usuarios y acceso → Integraciones → **App Store Connect API** → nueva clave con rol **Admin**. Descarga el `.p8` (solo se puede una vez) y apunta **Key ID** e **Issuer ID**.
4. Tu **Team ID**: developer.apple.com → Membership.
5. GitHub → el repositorio → Settings → Secrets and variables → Actions → crea `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (el contenido completo del `.p8`) y `APPLE_TEAM_ID`.

Cada build: GitHub → **Actions → TestFlight → Run workflow**. Tarda unos 15 minutos y la build aparece en TestFlight cuando Apple termina de procesarla (10–30 minutos). El número de build sube solo (1000 + número de ejecución).

### Desde Xcode (en el Mac)

1. **Product → Archive** (con "Any iOS Device" como destino).
2. En el Organizer: **Distribute App → App Store Connect → Upload**.
3. Antes de cada subida, incrementa **Build** (`CURRENT_PROJECT_VERSION`). Está definido a nivel de proyecto (igual que la versión, `MARKETING_VERSION`) para que la app y la extensión RunnaLive tengan siempre el mismo número, como exige Apple: cámbialo en el proyecto, no en un solo target. Usa números por debajo de 1000 o por encima de los del workflow para no repetir.

La app ya declara `ITSAppUsesNonExemptEncryption = NO`, así que TestFlight no te preguntará por cifrado.

## Notificaciones push (APNs)

El servidor envía las notificaciones directamente a Apple. Hay que darle una clave una sola vez:

1. En [developer.apple.com → Keys](https://developer.apple.com/account/resources/authkeys/list) crea una clave con **Apple Push Notifications service (APNs)** y descarga el `.p8`. Anota el **Key ID** y tu **Team ID**.
2. Configura los secretos del Worker (desde la carpeta del proyecto; en Windows funciona igual en PowerShell):

   ```
   npx wrangler secret put APNS_KEY_ID -c wrangler.worker.toml
   npx wrangler secret put APNS_TEAM_ID -c wrangler.worker.toml
   npx wrangler secret put APNS_BUNDLE_ID -c wrangler.worker.toml
   npx wrangler secret put APNS_PRIVATE_KEY -c wrangler.worker.toml
   ```

   En `APNS_BUNDLE_ID` pon el Bundle Identifier de la app. En `APNS_PRIVATE_KEY` pega el contenido completo del `.p8`, con las líneas `BEGIN/END PRIVATE KEY`.

Las builds de Xcode (Debug) se registran en el entorno *sandbox* de APNs. Las de TestFlight y App Store, en *production*. El servidor usa el que corresponda a cada dispositivo.

## Live Activity (pantalla bloqueada y Dynamic Island)

Mientras grabas una carrera, la app muestra una Live Activity con el tiempo (cuenta solo, sin gastar batería en actualizaciones), la distancia, el ritmo medio, los tesoros recogidos y una etiqueta **PAUSA** cuando está en pausa. La distancia se actualiza cada 10 s si has avanzado al menos 20 m. Al terminar se queda unos minutos con los datos finales; al descartar la carrera desaparece al momento.

- La dibuja la extensión **RunnaLive** (`ios/RunnaLive/`). El tipo compartido `RunActivityAttributes` está en `ios/Shared/`, una carpeta que pertenece a los dos targets.
- La controla `Runna/Features/Run/RunLiveActivity.swift`, desde `RunTracker`.
- El usuario puede desactivarlas en Ajustes → Runna.io → Actividades en directo; entonces la app simplemente no la muestra.

## Strava y Polar

La app abre el login de Strava/Polar en una ventana segura del sistema. Al terminar, el servidor la devuelve a la app con `runnaio://oauth/...`. No hace falta cambiar nada en Strava ni en Polar: la URL de callback sigue siendo la del Worker.

## Revisión de Apple: notas útiles

- **URLs para App Store Connect**:
  - Política de privacidad: `https://runna-io-api.runna-io-api.workers.dev/privacy`
  - Soporte: `https://runna-io-api.runna-io-api.workers.dev/support`
  - Condiciones de uso (opcional, como EULA o en la descripción): `https://runna-io-api.runna-io-api.workers.dev/terms`
- **Contenido generado por usuarios** (guideline 1.2): se puede denunciar y bloquear desde el perfil de un usuario, un comentario o una publicación. Las denuncias se revisan en 24 horas.

- **Ubicación en segundo plano**: solo se usa mientras grabas una carrera que has empezado tú. Si lo preguntan, explícalo en las notas de la revisión.
- **HealthKit**: solo lectura de entrenamientos de carrera y sus rutas, para crear territorio.
- **Borrar cuenta**: Perfil → Borrar cuenta.
- **Cuenta de prueba**: crea una cuenta con email ya verificado para el revisor y ponla en App Store Connect → App Review Information.
- **Nombre**: "Runna" ya existe en la App Store (es otra app de running). Puede que Apple pida un nombre distinto: piensa una alternativa.

## Compilación automática

`.github/workflows/ios.yml` se lanza a mano (Actions → iOS build → Run workflow), porque en repositorios privados los minutos de Mac cuentan 10 veces: compila la app (simulador y dispositivo, sin firmar), la abre en el simulador con una API local llena de datos de prueba (`scripts/e2e/`) y hace una captura de cada pestaña. Las capturas se descargan desde la ejecución, en "Artifacts".
