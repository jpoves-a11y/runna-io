// Public static pages served by the Worker (the web app is discontinued; the only client is the
// iPhone app): privacy policy, terms, support, and landing pages that open the app through its
// URL scheme (friend invites and email buttons). Plain HTML with inline CSS, no external resources.
import type { Context, Hono } from 'hono';
import type { AppEnv } from './auth';

const DEFAULT_WORKER_URL = 'https://runna-io-api.runna-io-api.workers.dev';
const CONTACT_EMAIL = 'kaeme2.support@gmail.com';
const APP_SCHEME = 'runnaio';
const APP_TABS = ['map', 'rankings', 'activity', 'club', 'friends', 'profile'] as const;

/** Public base URL of this Worker: env WORKER_URL, else the request origin. No trailing slash. */
export function publicBaseUrl(c: Context<AppEnv>): string {
  const configured = c.env?.WORKER_URL;
  if (configured) return configured.replace(/\/+$/, '');
  try {
    return new URL(c.req.url).origin;
  } catch {
    return DEFAULT_WORKER_URL;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) links are accepted for APP_DOWNLOAD_URL. */
function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f7f8fa; --card: #ffffff; --text: #111827; --muted: #5b6472; --border: #e3e6eb;
  --accent: #008A10; --accent-text: #ffffff; --soft: #eaf6ec;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --card: #161b22; --text: #e6edf3; --muted: #9aa4b2; --border: #2b323c;
    --accent: #00FF1E; --accent-text: #000000; --soft: #10241a;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  padding: max(16px, env(safe-area-inset-top)) 16px max(32px, env(safe-area-inset-bottom));
}
main { max-width: 760px; margin: 0 auto; }
header { text-align: center; padding: 16px 0 20px; border-bottom: 2px solid var(--accent); margin-bottom: 24px; }
header h1 { font-size: 1.6rem; margin: 0 0 4px; }
.brandmark { font-weight: 900; letter-spacing: -0.03em; }
header h2 { font-size: 1.3rem; margin: 0 0 12px; font-weight: 600; }
header p { margin: 2px 0; color: var(--muted); font-size: .95rem; }
section { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 16px 18px; margin: 0 0 16px; }
section h2 { font-size: 1.15rem; margin: 0 0 10px; }
section h3 { font-size: 1rem; margin: 14px 0 6px; }
p, li { color: var(--text); }
.muted { color: var(--muted); font-size: .95rem; }
ul, ol { padding-left: 1.3rem; margin: 6px 0; }
li { margin: 3px 0; }
a { color: var(--accent); }
table { width: 100%; border-collapse: collapse; font-size: .95rem; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { background: var(--soft); }
.table-wrap { overflow-x: auto; }
.note { background: var(--soft); border-radius: 10px; padding: 10px 12px; margin: 10px 0; }
footer { text-align: center; color: var(--muted); font-size: .9rem; padding-top: 16px; border-top: 1px solid var(--border); margin-top: 24px; }
footer a { margin: 0 6px; }
.landing { min-height: 70vh; display: flex; flex-direction: column; justify-content: center; text-align: center; }
.landing .logo { font-size: 3.5rem; line-height: 1; margin-bottom: 8px; }
.landing h1 { font-size: 1.6rem; margin: 8px 0; }
.button {
  display: block; width: 100%; max-width: 360px; margin: 12px auto; padding: 16px 20px;
  border-radius: 14px; font-size: 1.1rem; font-weight: 700; text-decoration: none; text-align: center;
  background: var(--accent); color: var(--accent-text);
}
.button.secondary { background: transparent; color: var(--accent); border: 2px solid var(--accent); }
`;

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

const ADMIN_STYLES = `
main { max-width: 900px; }
.admin-nav { display: flex; gap: 16px; align-items: center; margin-bottom: 8px; }
.admin-nav form { margin-left: auto; }
.card { border: 1px solid var(--border, #8884); border-radius: 12px; padding: 12px 16px; margin: 12px 0; }
.card.closed { opacity: .7; }
.card header { margin-bottom: 4px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
button { font: inherit; padding: 8px 14px; border-radius: 10px; border: 0; background: var(--accent); color: var(--accent-text); cursor: pointer; }
button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
button.danger { background: #c62828; color: #fff; }
button.link { background: none; color: var(--accent); padding: 0; text-decoration: underline; }
input[type=password] { font: inherit; padding: 8px; width: 100%; max-width: 360px; margin: 6px 0 12px; }
blockquote { margin: 8px 0; padding: 8px 12px; border-left: 3px solid var(--accent); white-space: pre-wrap; word-break: break-word; }
img.evidence { max-width: 240px; border-radius: 8px; display: block; margin: 8px 0; }
.tag { display: inline-block; font-size: .85em; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; margin-left: 6px; }
.tag.danger { color: #c62828; }
.flash { padding: 8px 12px; border-radius: 10px; background: #2e7d3222; }
.flash.error { background: #c6282822; }
.muted { opacity: .7; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.tile { border: 1px solid #8884; border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 2px; }
.tile strong { font-size: 1.8em; }
table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #8883; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.admin-nav { flex-wrap: wrap; gap: 6px 14px; padding-bottom: 8px; border-bottom: 1px solid #8883; margin-bottom: 16px; }
.admin-nav a { text-decoration: none; padding: 4px 0; }
.admin-nav a.active { font-weight: 700; border-bottom: 2px solid var(--accent); }
a.tile { text-decoration: none; color: inherit; }
a.tile:hover { border-color: var(--accent); }
.tile small { opacity: .7; }
.card h3 { margin: 0 0 6px; }
.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.table-scroll table { min-width: 560px; }
tr.current td { background: #2e7d3218; font-weight: 600; }
.tag.ok { color: #2e7d32; }
ul.alerts { list-style: none; padding: 0; margin: 0 0 16px; display: grid; gap: 8px; }
ul.alerts li { padding: 10px 12px; border-radius: 10px; border-left: 4px solid #1976d2; background: #1976d214; }
ul.alerts li.warn { border-color: #ef6c00; background: #ef6c0014; }
ul.alerts li.bad { border-color: #c62828; background: #c6282814; }
form.search { display: flex; gap: 8px; margin: 8px 0 16px; }
form.search input, form.inline-form input[type=text] { font: inherit; padding: 8px; flex: 1; min-width: 0; border-radius: 10px; border: 1px solid #8886; background: transparent; color: inherit; }
form.inline-form { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
pre.json { font-size: .8em; overflow-x: auto; padding: 12px; border-radius: 10px; background: #8881; }
@media (max-width: 600px) {
  main { padding-left: 16px; padding-right: 16px; }
  .tile strong { font-size: 1.4em; }
}
`;

/** Admin panel pages (worker/src/admin.ts): same look, a few extra styles, never indexed. */
export function adminPage(title: string, body: string): string {
  return page(title, `<style>${ADMIN_STYLES}</style>\n${body}`).replace('<head>', '<head>\n<meta name="robots" content="noindex">');
}

const FOOTER = `<footer>
<p>© 2026 Javier Poves Ruiz · KM2</p>
<p><a href="/privacy">Privacidad</a>·<a href="/terms">Términos</a>·<a href="/support">Soporte</a></p>
</footer>`;

const PRIVACY_HTML = page('Política de Privacidad · KM2', `
<header>
<h1 class="brandmark">KM<span style="color:var(--accent)">2</span></h1>
<h2>Política de Privacidad</h2>
<p><strong>Última actualización:</strong> 20 de noviembre de 2026</p>
<p><strong>Responsable:</strong> Javier Poves Ruiz</p>
<p><strong>Contacto:</strong> <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
</header>

<section>
<p>KM2 es una app para iPhone en la que sales a correr y conquistas territorio en el mapa; tus amigos pueden robártelo y competir contigo. Esta política explica qué datos tratamos, para qué y cuáles son tus derechos.</p>
</section>

<section id="responsable">
<h2>1. Responsable del tratamiento</h2>
<div class="table-wrap"><table><tbody>
<tr><td><strong>Responsable</strong></td><td>Javier Poves Ruiz (persona física)</td></tr>
<tr><td><strong>Email</strong></td><td><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></td></tr>
<tr><td><strong>País</strong></td><td>España</td></tr>
<tr><td><strong>Autoridad de control</strong></td><td>Agencia Española de Protección de Datos (AEPD)</td></tr>
</tbody></table></div>
</section>

<section id="datos">
<h2>2. ¿Qué datos recopilamos?</h2>
<h3>2.1. Datos de tu cuenta</h3>
<ul>
<li><strong>Nombre</strong> y <strong>nombre de usuario</strong> (@usuario): te identifican ante tus amigos y en los rankings.</li>
<li><strong>Correo electrónico:</strong> para verificar la cuenta y enviarte avisos que puedes desactivar.</li>
<li><strong>Contraseña:</strong> nunca se guarda en texto plano; se almacena cifrada con PBKDF2 y salt.</li>
<li><strong>Foto de perfil</strong> (opcional) y el color que eliges para tu territorio.</li>
</ul>
<h3>2.2. Carreras y ubicación</h3>
<ul>
<li>Cuando grabas una carrera, la app usa la <strong>ubicación del iPhone</strong> mientras dura la grabación, también con la pantalla bloqueada, para registrar el recorrido. Fuera de una grabación no usamos tu ubicación en segundo plano.</li>
<li>De cada carrera guardamos la <strong>ruta GPS</strong>, la distancia, la duración y la fecha y hora, y el territorio que conquistas con ella.</li>
</ul>
<h3>2.3. Apple Health (HealthKit)</h3>
<ul>
<li>Solo si tú lo activas, la app lee de Apple Health tus <strong>entrenamientos de carrera y sus rutas</strong> para importarlos como carreras. El acceso es de <strong>solo lectura</strong>: no escribimos nada en Apple Health.</li>
<li>Los datos de HealthKit <strong>nunca se usan para publicidad</strong> ni se comparten con terceros, salvo el proveedor de alojamiento que guarda las carreras importadas.</li>
<li>Puedes retirar el permiso cuando quieras en Ajustes del iPhone → Salud → Acceso a datos y dispositivos → KM2.</li>
</ul>
<h3>2.4. Strava, Polar, Suunto y Garmin (opcional)</h3>
<p>Si conectas tu cuenta de Strava, Polar Flow, Suunto o Garmin Connect, importamos tus actividades de carrera y trail running (identificador, distancia, duración, fecha y ruta GPS, con la altitud y la hora de cada punto) y guardamos los tokens de acceso que esos servicios nos dan. De Suunto guardamos además tu nombre de usuario de Suunto, que usamos solo para saber a quién pertenece cada aviso de entrenamiento nuevo que nos envía Suunto. De Garmin guardamos tu identificador de usuario de la API de Garmin, que usamos solo para saber a quién pertenece cada actividad que nos envía Garmin. Puedes desconectarlas desde tu perfil o desde Garmin Connect; al desconectar Garmin o borrar tu cuenta avisamos a Garmin para que deje de enviarnos tus datos.</p>
<h4>Datos de Garmin</h4>
<ul>
<li><strong>Qué recibimos y para qué:</strong> solo tus actividades de carrera y trail running (tipo, fecha, distancia, duración, modelo de reloj y ruta GPS, con la altitud y la hora de cada punto). Las usamos únicamente para crear tus carreras en KM2, calcular tu territorio y rankings y mostrarlas a tus amigos. No recibimos datos de salud (sueño, frecuencia cardiaca diaria, etc.).</li>
<li><strong>Quién los trata:</strong> solo los proveedores de la sección 5 que alojan el servicio: Cloudflare (servidor), Turso (base de datos) y Apple APNs (el aviso de «carrera registrada», sin la ruta). Ningún otro tercero recibe datos de Garmin.</li>
<li><strong>No los vendemos</strong> ni los compartimos con terceros para fines propios de ellos.</li>
<li><strong>Sin inteligencia artificial:</strong> ningún sistema de IA procesa tus datos de Garmin, y no se usan para entrenar, evaluar ni mejorar modelos de IA.</li>
<li><strong>Tu control:</strong> puedes ver y borrar cada actividad importada en Perfil → Servicios conectados → Garmin → Actividades importadas; pedir una copia (JSON) o la corrección de tus datos escribiendo a <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>; y retirar tu consentimiento desconectando Garmin en la app o quitando KM2 en Garmin Connect (Ajustes → Aplicaciones conectadas). Al borrar tu cuenta se eliminan todos tus datos de Garmin.</li>
</ul>
<h3>2.5. Fotos y cámara</h3>
<ul>
<li>Puedes enviar a un amigo una <strong>foto de un solo uso</strong> (para picarle cuando le robas territorio). Usamos la cámara o tu fototeca solo cuando tú eliges hacerlo. La foto se <strong>borra al verla</strong> y, si nadie la ve, a las 24 horas.</li>
<li>La foto de perfil se guarda hasta que la cambies o borres tu cuenta.</li>
</ul>
<h3>2.6. Notificaciones push</h3>
<p>Si las permites, guardamos el <strong>token de dispositivo</strong> que da Apple para enviarte avisos (solicitudes de amistad, territorio robado, comentarios, tesoros…) a través del servicio Apple Push Notification service (APNs). Puedes desactivarlas en Ajustes del iPhone.</p>
<h3>2.7. Contenido social</h3>
<p>Comentarios y reacciones que publicas en el feed, tus amistades y, si los usas, las denuncias y bloqueos que haces.</p>
<h3>2.8. Iniciar sesión con Apple</h3>
<p>Si entras con Apple, recibimos de Apple un identificador de tu Apple ID y el email que elijas compartir (puede ser una dirección privada de Apple que reenvía a la tuya). Al borrar tu cuenta pedimos a Apple que desvincule KM2 de tu Apple ID.</p>
<h3>2.9. Uso de la app</h3>
<p>Para saber qué partes de la app se usan y mejorarlas, la app envía a nuestro servidor eventos de uso (por ejemplo, «ha abierto la pestaña Ranking» o «ha empezado una carrera»), con la versión de la app y un identificador de la instalación. Se guardan en nuestra base de datos, vinculados a tu cuenta, durante 180 días como máximo, y nunca se comparten con terceros ni se usan para publicidad.</p>
<h3>2.10. Zona privada</h3>
<p>Si activas la zona privada (Perfil → Privacidad), los primeros y últimos 200 metros de cada carrera nueva no se muestran a nadie más ni cuentan como territorio. Solo tú los ves.</p>
<div class="note"><strong>Sin rastreo:</strong> la app no incluye SDK de publicidad, analítica de terceros ni seguimiento, y no rastrea tu actividad en otras apps o webs.</div>
</section>

<section id="uso">
<h2>3. ¿Para qué usamos tus datos?</h2>
<div class="table-wrap"><table>
<thead><tr><th>Finalidad</th><th>Base legal (RGPD)</th></tr></thead>
<tbody>
<tr><td>Gestionar tu cuenta</td><td>Ejecución del contrato (art. 6.1.b)</td></tr>
<tr><td>Grabar carreras y calcular territorios y rankings</td><td>Ejecución del contrato (art. 6.1.b)</td></tr>
<tr><td>Importar de Apple Health, Strava, Polar, Suunto o Garmin</td><td>Consentimiento (art. 6.1.a)</td></tr>
<tr><td>Enviar notificaciones push y emails</td><td>Consentimiento (art. 6.1.a)</td></tr>
<tr><td>Moderar denuncias y evitar abusos</td><td>Interés legítimo (art. 6.1.f)</td></tr>
<tr><td>Medir el uso de la app para mejorarla</td><td>Interés legítimo (art. 6.1.f)</td></tr>
</tbody>
</table></div>
<h3>Lo que NO hacemos</h3>
<ul>
<li>No vendemos tus datos.</li>
<li>No mostramos publicidad ni creamos perfiles de marketing.</li>
<li>No compartimos datos de salud ni de ubicación con terceros para fines propios de ellos.</li>
</ul>
</section>

<section id="visibilidad">
<h2>4. ¿Quién ve tus datos?</h2>
<ul>
<li>Tus amigos ven tu nombre, usuario, foto, color, territorio y tus carreras en el feed.</li>
<li>Durante una competición, los participantes pueden ver el territorio y la posición en el ranking de los demás.</li>
<li>Si bloqueas a alguien, dejáis de ver el contenido del otro y se elimina la amistad.</li>
</ul>
</section>

<section id="terceros">
<h2>5. Proveedores (encargados del tratamiento)</h2>
<div class="table-wrap"><table>
<thead><tr><th>Servicio</th><th>Finalidad</th><th>Ubicación</th></tr></thead>
<tbody>
<tr><td>Cloudflare</td><td>Alojamiento del servidor</td><td>Global</td></tr>
<tr><td>Turso</td><td>Base de datos</td><td>UE</td></tr>
<tr><td>Apple (APNs)</td><td>Notificaciones push</td><td>EE. UU.</td></tr>
<tr><td>SendGrid / Resend</td><td>Emails de la cuenta</td><td>EE. UU.</td></tr>
<tr><td>Strava</td><td>Importación (opcional)</td><td>EE. UU.</td></tr>
<tr><td>Polar Flow</td><td>Importación (opcional)</td><td>Finlandia (UE)</td></tr>
<tr><td>Suunto</td><td>Importación (opcional)</td><td>Finlandia (UE)</td></tr>
<tr><td>Garmin</td><td>Importación (opcional)</td><td>EE. UU. / UE</td></tr>
</tbody>
</table></div>
<p class="muted">Las transferencias fuera de la UE se amparan en las cláusulas contractuales tipo de la Comisión Europea o en el Marco de Privacidad de Datos UE-EE. UU.</p>
</section>

<section id="conservacion">
<h2>6. Conservación y borrado de la cuenta</h2>
<ul>
<li>Guardamos tus datos mientras tengas la cuenta.</li>
<li>Puedes borrar la cuenta desde la app: <strong>Perfil → Borrar cuenta</strong>. Se eliminan de inmediato y de forma irreversible tus datos: perfil, carreras, territorios, fotos, comentarios, amistades, tokens de notificaciones y conexiones con Strava, Polar, Suunto y Garmin.</li>
</ul>
</section>

<section id="moderacion">
<h2>7. Denuncias y bloqueos</h2>
<p>Puedes denunciar usuarios, comentarios, publicaciones o fotos desde la app y bloquear a cualquier usuario. Revisamos las denuncias y podemos retirar contenido o suspender cuentas que incumplan los <a href="/terms">Términos</a>. Guardamos la denuncia (quién la hace, qué se denuncia y el motivo) solo para gestionarla.</p>
</section>

<section id="derechos">
<h2>8. Tus derechos (RGPD)</h2>
<div class="table-wrap"><table>
<thead><tr><th>Derecho</th><th>Descripción</th></tr></thead>
<tbody>
<tr><td>Acceso (art. 15)</td><td>Pedir una copia de tus datos</td></tr>
<tr><td>Rectificación (art. 16)</td><td>Corregir tus datos desde el perfil</td></tr>
<tr><td>Supresión (art. 17)</td><td>Borrar tu cuenta y todos tus datos</td></tr>
<tr><td>Portabilidad (art. 20)</td><td>Recibir tus datos en formato JSON</td></tr>
<tr><td>Oposición (art. 21)</td><td>Oponerte a un tratamiento</td></tr>
<tr><td>Retirar el consentimiento</td><td>En cualquier momento, sin efecto retroactivo</td></tr>
</tbody>
</table></div>
<p>Para ejercerlos, escribe a <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. Respondemos en un plazo máximo de 30 días.</p>
</section>

<section id="seguridad">
<h2>9. Seguridad</h2>
<ul>
<li>Cifrado HTTPS/TLS en todas las comunicaciones.</li>
<li>Contraseñas cifradas con PBKDF2 y salt.</li>
<li>La sesión de la app se guarda en el Llavero (Keychain) del iPhone.</li>
<li>Base de datos con cifrado en reposo y tokens de servicios externos guardados de forma segura.</li>
</ul>
</section>

<section id="edad">
<h2>10. Edad mínima</h2>
<p><strong>14 años.</strong> Según el artículo 7 de la LOPDGDD, la edad de consentimiento digital en España es 14 años. Los menores de 14 años no pueden crear una cuenta.</p>
</section>

<section id="contacto">
<h2>11. Contacto y reclamaciones</h2>
<p>Consultas de privacidad: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
<p>Si crees que no hemos tratado bien tus datos, puedes reclamar ante la <strong>Agencia Española de Protección de Datos (AEPD)</strong>: www.aepd.es · 901 100 099.</p>
<p class="muted">Si cambiamos esta política te lo indicaremos en la app.</p>
</section>
${FOOTER}`);

const TERMS_HTML = page('Términos y Condiciones · KM2', `
<header>
<h1 class="brandmark">KM<span style="color:var(--accent)">2</span></h1>
<h2>Términos y Condiciones</h2>
<p><strong>Última actualización:</strong> 16 de octubre de 2026</p>
<p><strong>Responsable:</strong> Javier Poves Ruiz</p>
<p><strong>Contacto:</strong> <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
</header>

<section>
<h2>1. Aceptación</h2>
<p>Al crear una cuenta o usar KM2 aceptas estos Términos y la <a href="/privacy">Política de Privacidad</a>. Si no estás de acuerdo, no uses la app.</p>
</section>

<section>
<h2>2. El servicio</h2>
<p>KM2 es una app para iPhone que permite:</p>
<ul>
<li>Grabar tus carreras con el GPS del iPhone o importarlas desde Apple Health, Strava, Polar Flow, Suunto o Garmin Connect.</li>
<li>Conquistar territorio virtual en el mapa a partir de tus rutas.</li>
<li>Robar territorio a tus amigos y competir en rankings y competiciones con tesoros y poderes.</li>
<li>Seguir a tus amigos en el feed, comentar, reaccionar y enviar fotos de un solo uso.</li>
</ul>
<p>La app es gratuita.</p>
</section>

<section>
<h2>3. Requisitos</h2>
<ul>
<li>Debes tener al menos <strong>14 años</strong>. Si detectamos que un usuario es menor, eliminaremos su cuenta.</li>
<li>Debes tener capacidad legal para aceptar estos términos.</li>
</ul>
</section>

<section>
<h2>4. Tu cuenta</h2>
<ul>
<li>Da información veraz y mantén tu contraseña en secreto. Avísanos si sospechas un uso no autorizado.</li>
<li>Una cuenta por persona; las cuentas son personales e intransferibles y no se permiten cuentas automatizadas.</li>
<li>Podemos suspender o eliminar cuentas que incumplan estos términos, den información falsa, hagan trampas o abusen del servicio.</li>
</ul>
</section>

<section>
<h2>5. Uso aceptable y contenido de los usuarios</h2>
<h3>Puedes</h3>
<ul>
<li>Registrar tus carreras reales y competir de forma justa.</li>
<li>Invitar a tus amigos y compartir tus logros.</li>
</ul>
<h3>No puedes</h3>
<ul>
<li><strong>Hacer trampas:</strong> falsear la ubicación (GPS spoofing), usar vehículos o subir actividades que no has hecho.</li>
<li><strong>Acosar</strong>, insultar, amenazar o intimidar a otros usuarios.</li>
<li>Publicar contenido <strong>ofensivo, sexual, violento, discriminatorio o ilegal</strong> en nombres, comentarios o fotos.</li>
<li>Crear varias cuentas, usar bots o scripts, o intentar acceder a sistemas internos.</li>
</ul>
<div class="note"><strong>Tolerancia cero</strong> con el contenido inaceptable y el acoso. Puedes <strong>denunciar</strong> usuarios, comentarios, publicaciones y fotos y <strong>bloquear</strong> a cualquier usuario desde la app. Revisamos las denuncias en un plazo de 24 horas y retiramos el contenido y expulsamos a quien lo publique cuando incumpla estas normas.</div>
</section>

<section>
<h2>6. Propiedad intelectual</h2>
<ul>
<li>El código, el diseño, los logotipos y la marca KM2 son de Javier Poves Ruiz.</li>
<li>Tus datos y tus carreras son tuyos. Nos das permiso para tratarlos como explica la Política de Privacidad.</li>
</ul>
</section>

<section>
<h2>7. Servicios de terceros</h2>
<p>Apple Health, Strava, Polar Flow, Suunto y Garmin Connect son opcionales y requieren tu permiso. Puedes desconectarlos cuando quieras. No somos responsables de cambios o caídas de esos servicios.</p>
</section>

<section>
<h2>8. Territorios y competiciones</h2>
<ul>
<li>El territorio se conquista corriendo físicamente por una zona; otros usuarios pueden robártelo corriendo por encima.</li>
<li>Los tesoros, poderes y premios de las competiciones son virtuales y no tienen valor económico.</li>
<li>Podemos invalidar actividades sospechosas y ajustar las reglas del juego para mantenerlo justo.</li>
</ul>
</section>

<section>
<h2>9. Seguridad al correr</h2>
<p>Corre con prudencia, respeta las normas de tráfico y la propiedad privada, y no mires el móvil mientras corres. Eres responsable de tu seguridad y de tu salud.</p>
</section>

<section>
<h2>10. Limitación de responsabilidad</h2>
<p>El servicio se ofrece «tal cual». No garantizamos que esté siempre disponible ni libre de errores. En la medida que permita la ley, no respondemos de daños indirectos. Nada de esto limita los derechos que te reconoce la normativa de consumo.</p>
</section>

<section>
<h2>11. Baja</h2>
<ul>
<li>Puedes borrar tu cuenta cuando quieras en <strong>Perfil → Borrar cuenta</strong>. El borrado es inmediato e irreversible e incluye tus carreras, territorios, fotos, comentarios y conexiones con Strava, Polar, Suunto y Garmin. Tu territorio queda libre para que otros lo conquisten.</li>
<li>Podemos cerrar cuentas por incumplir estos términos; en casos graves, de inmediato.</li>
</ul>
</section>

<section>
<h2>12. Ley aplicable</h2>
<p>Estos términos se rigen por la ley española (RGPD y LOPDGDD). Son competentes los tribunales de España, sin perjuicio de tus derechos como consumidor. Para la protección de datos, la autoridad es la AEPD.</p>
</section>

<section>
<h2>13. Contacto</h2>
<p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
</section>
${FOOTER}`);

const SUPPORT_HTML = page('Soporte · KM2', `
<header>
<h1 class="brandmark">KM<span style="color:var(--accent)">2</span></h1>
<h2>Centro de soporte</h2>
<p>¿Necesitas ayuda? Estamos aquí para ti.</p>
</header>

<section>
<h2>Contacto</h2>
<p>Para cualquier duda, problema técnico, denuncia o sugerencia, escríbenos:</p>
<a class="button" href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>
<p class="muted">Respondemos normalmente en 24-48 horas.</p>
</section>

<section>
<h2>Grabar carreras</h2>
<ul>
<li>Abre la app, ve al <strong>Mapa</strong> y pulsa el botón de empezar a correr.</li>
<li>Permite el acceso a la ubicación («Al usar la app»): la grabación sigue con la pantalla bloqueada.</li>
<li>Al terminar, la carrera se sube y verás el territorio conquistado y lo que has robado. Si no hay conexión, la app la guarda y la sube más tarde.</li>
</ul>
</section>

<section>
<h2>Importar carreras</h2>
<h3>Apple Health</h3>
<p>Perfil → Conectar dispositivos → Apple Health. Se importan tus entrenamientos de carrera con ruta. Puedes retirar el permiso en Ajustes → Salud → Acceso a datos y dispositivos.</p>
<h3>Strava</h3>
<p>Perfil → Conectar dispositivos → Conectar con Strava y autoriza el acceso. Tus carreras con GPS se importan automáticamente.</p>
<h3>Polar Flow</h3>
<p>Perfil → Conectar dispositivos → Conectar con Polar. Los ejercicios con GPS se sincronizan solos cada pocos minutos.</p>
<h3>Suunto</h3>
<p>Perfil → Conectar dispositivos → Conectar con Suunto e inicia sesión con tu cuenta de la app Suunto. Cuando sincronizas el reloj con la app Suunto, tus carreras y salidas de trail running con GPS se importan solas en unos minutos. También puedes usar «Sincronizar ahora» para traer los últimos 30 días. Las caminatas, el senderismo, los entrenamientos sin GPS (cinta, piscina…) y los de otros deportes no se importan.</p>
<h3>Garmin</h3>
<p>Perfil → Conectar dispositivos → Conectar con Garmin, inicia sesión con tu cuenta de Garmin Connect y deja activado el permiso «Actividades». Cuando sincronizas el reloj con Garmin Connect, tus carreras y salidas de trail running con GPS se importan solas en unos minutos. Las actividades anteriores a la conexión no se importan. Las caminatas, el senderismo, los entrenamientos sin GPS (cinta…) y los de otros deportes no se importan.</p>
</section>

<section>
<h2>Preguntas frecuentes</h2>
<h3>¿Cómo añado amigos?</h3>
<p>En la pestaña <strong>Amigos</strong> busca por nombre de usuario o comparte tu enlace de invitación.</p>
<h3>¿Cómo denuncio o bloqueo a alguien?</h3>
<p>Desde el perfil del usuario, un comentario o una publicación, usa la opción <strong>Denunciar</strong> o <strong>Bloquear</strong>. Puedes desbloquear desde tu perfil.</p>
<h3>¿Puedo borrar una carrera?</h3>
<p>Sí, desde tu actividad. El territorio asociado se recalcula.</p>
<h3>¿Cómo borro mi cuenta?</h3>
<p>En <strong>Perfil → Borrar cuenta</strong>. Se eliminan todos tus datos de forma inmediata e irreversible.</p>
<h3>¿Cuesta algo?</h3>
<p>No. KM2 es gratuita, sin suscripciones ni pagos.</p>
</section>

<section>
<h2>Documentos legales</h2>
<ul>
<li><a href="/privacy">Política de Privacidad</a></li>
<li><a href="/terms">Términos y Condiciones</a></li>
</ul>
</section>
${FOOTER}`);

function landing(c: Context<AppEnv>, options: { title: string; heading: string; text: string; appLink: string }): string {
  const download = safeHttpUrl(c.env?.APP_DOWNLOAD_URL);
  const appLink = escapeHtml(options.appLink);
  return page(options.title, `
<div class="landing">
<div class="logo">🏃</div>
<h1>${escapeHtml(options.heading)}</h1>
<p>${escapeHtml(options.text)}</p>
<a class="button" id="open-app" href="${appLink}">Abrir en la app</a>
${download ? `<a class="button secondary" href="${escapeHtml(download)}">Descargar la app</a>` : ''}
<p class="muted">Si no se abre nada, instala primero KM2 en tu iPhone${download ? '' : ' (pide el enlace de descarga a quien te invitó)'} y vuelve a pulsar «Abrir en la app».</p>
</div>
${FOOTER}`);
}

/** Only tokens made of URL-safe characters are put in the deep link. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function registerPublicPages(app: Hono<AppEnv>): void {
  const html = (c: Context<AppEnv>, body: string, status: 200 | 404 = 200) => {
    c.header('Cache-Control', 'public, max-age=300');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(body, status);
  };

  app.get('/privacy', (c) => html(c, PRIVACY_HTML));
  app.get('/terms', (c) => html(c, TERMS_HTML));
  app.get('/support', (c) => html(c, SUPPORT_HTML));

  app.get('/invite/:token', (c) => {
    const token = c.req.param('token');
    if (!TOKEN_PATTERN.test(token)) {
      return html(c, page('Invitación no válida · KM2', `
<div class="landing">
<div class="logo">🏃</div>
<h1>Invitación no válida</h1>
<p>Este enlace de invitación no es correcto. Pide a tu amigo que te envíe uno nuevo.</p>
</div>
${FOOTER}`), 404);
    }
    c.header('Cache-Control', 'no-store');
    return c.html(landing(c, {
      title: 'Invitación a KM2',
      heading: 'Te han invitado a KM2',
      text: 'Un amigo quiere seguirte en KM2 y ver tu territorio. Abre la invitación en la app para aceptarla.',
      appLink: `${APP_SCHEME}://friends/accept/${token}`,
    }));
  });

  // Club invite link (see /api/clubs/:id/invites): opens runnaio://clubs/join/<token>
  app.get('/club-invite/:token', (c) => {
    const token = c.req.param('token');
    if (!TOKEN_PATTERN.test(token)) {
      return html(c, page('Invitación no válida · KM2', `
<div class="landing">
<div class="logo">🛡️</div>
<h1>Invitación no válida</h1>
<p>Este enlace de invitación a un club no es correcto. Pide uno nuevo a alguien del club.</p>
</div>
${FOOTER}`), 404);
    }
    c.header('Cache-Control', 'no-store');
    return c.html(landing(c, {
      title: 'Invitación a un club · KM2',
      heading: 'Te han invitado a un club',
      text: 'Únete al club para competir con ellos cada dos semanas. Abre la invitación en la app para unirte.',
      appLink: `${APP_SCHEME}://clubs/join/${token}`,
    }));
  });

  // Universal links: https links to these paths open the app when it's installed (the page stays as
  // the fallback). appIDs = <team id>.<bundle id>; the app lists this domain in its associated domains.
  app.get('/.well-known/apple-app-site-association', (c) => {
    const team = (c.env?.APPLE_TEAM_ID || c.env?.APNS_TEAM_ID || '').trim();
    const bundle = (c.env?.APPLE_BUNDLE_ID || c.env?.APNS_BUNDLE_ID || 'com.jpoves.runnaio').trim();
    const appIDs = team ? [`${team}.${bundle}`] : [];
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json({
      applinks: {
        details: [{
          appIDs,
          components: [
            { '/': '/invite/*', comment: 'Friend invites' },
            { '/': '/club-invite/*', comment: 'Club invites' },
            { '/': '/open', comment: 'Email buttons (?tab=)' },
          ],
        }],
      },
    });
  });

  app.get('/open', (c) => {
    const requested = c.req.query('tab') ?? 'map';
    const tab = (APP_TABS as readonly string[]).includes(requested) ? requested : 'map';
    return html(c, landing(c, {
      title: 'Abrir KM2',
      heading: 'Abre KM2',
      text: 'Sal a correr, conquista el mapa y compite con tu club.',
      appLink: `${APP_SCHEME}://tab/${tab}`,
    }));
  });
}
