# POLÍTICA DE PRIVACIDAD DE RUNNA.IO

**Última actualización:** 10 de marzo de 2026  
**Versión:** 2.1  
**Responsable:** Javier Poves Ruiz  
**Contacto:** runna.io.service@gmail.com  
**Ubicación:** España

---

## 1. INFORMACIÓN DEL RESPONSABLE

De acuerdo con el Reglamento General de Protección de Datos (RGPD) y la Ley Orgánica 3/2018 de Protección de Datos Personales y garantía de los derechos digitales (LOPD-GDD):

| Campo | Información |
|-------|-------------|
| **Responsable** | Javier Poves Ruiz (persona física) |
| **Email de contacto** | runna.io.service@gmail.com |
| **País** | España |
| **Autoridad de control** | Agencia Española de Protección de Datos (AEPD) |

---

## 1.1 NATURALEZA DE LA APLICACIÓN: COMUNIDAD DE ATLETAS

**Runna.io es una aplicación comunitaria** diseñada para que atletas organicen, colaboren y compitan en actividades grupales. El propósito principal es:

- **Gamificación social**: Los usuarios compiten por conquistar territorios geográficos mediante sus actividades deportivas
- **Competiciones de equipo**: Organizamos competiciones periódicas donde equipos de atletas colaboran para conquistar más territorio
- **Colaboración grupal**: Los usuarios pueden añadir amigos, formar grupos y competir juntos
- **Rankings comunitarios**: Leaderboards que muestran el rendimiento de la comunidad

### Datos Compartidos con la Comunidad

Al usar Runna.io, **consientes explícitamente** que ciertos datos derivados de tus actividades sean visibles para otros usuarios:

| Dato | Visible para otros | Descripción |
|------|-------------------|-------------|
| **Polígonos de territorio** | ✅ Sí | Áreas geográficas que has conquistado (derivadas de tus rutas) |
| **Nombre de usuario** | ✅ Sí | Tu @username en rankings y feed |
| **Área total conquistada** | ✅ Sí | Metros cuadrados en leaderboards |
| **Eventos de conquista** | ✅ Sí | Cuando conquistas o pierdes territorio (feed social) |
| **Rutas GPS exactas** | ❌ No | Tus trayectos GPS permanecen privados |
| **Tiempos y ritmos** | ❌ No | Métricas de rendimiento son privadas |
| **Ubicación de inicio/fin** | ❌ No | Los puntos exactos no se comparten |

> **Importante**: Los territorios son **datos derivados** generados por Runna.io a partir de tus rutas, no son datos directos de Strava/Polar/COROS. Las rutas originales permanecen privadas.

### Consentimiento Explícito

Antes de conectar cualquier servicio externo (Strava, Polar, COROS), se te mostrará una pantalla de consentimiento explicando:
- Qué datos se importarán
- Cómo se usarán para generar territorios
- Qué información será visible para la comunidad

---

## 2. ¿QUÉ DATOS RECOPILAMOS?

### 2.1. Datos que TÚ nos proporcionas directamente

Al crear una cuenta:
- **Nombre completo**: Para identificarte en la app
- **Nombre de usuario**: Para tu perfil público (@tunombre)
- **Correo electrónico**: Para comunicaciones y recuperación de cuenta
- **Contraseña**: Almacenada de forma segura con hash criptográfico SHA-256 con salt (nunca en texto plano)

### 2.2. Datos de tus actividades deportivas

Cuando sincronizas con servicios externos:

#### Desde Polar Flow:
- ID de ejercicio y tipo de actividad
- Distancia recorrida (metros)
- Duración (segundos)
- Fecha y hora de inicio
- Ruta GPS (polyline codificado)

#### Desde Strava:
- ID de actividad y tipo
- Distancia recorrida
- Duración (tiempo en movimiento)
- Fecha de inicio
- Ruta GPS (summary polyline)

#### Desde COROS:
- ID de workout y tipo de actividad
- Distancia recorrida (metros)
- Duración (segundos)
- Fecha y hora de inicio
- Ruta GPS (track points)

### 2.3. Datos que recopilamos automáticamente

**Cloudflare Analytics** (único servicio de analítica):
- País de origen de la visita
- Navegador y dispositivo (tipo general)
- Páginas visitadas
- Rendimiento de la web

> ⚠️ **Importante**: Cloudflare Analytics es privacy-first y NO utiliza cookies de tracking. No recopila información personal identificable.

### 2.4. Datos de la aplicación

- **Rutas y territorios conquistados**: Geometría de polígonos
- **Métricas de conquista**: Área conquistada/robada entre usuarios
- **Relaciones de amistad**: Conexiones entre usuarios
- **Preferencias de notificaciones**: Qué emails quieres recibir

---

## 3. ¿PARA QUÉ USAMOS TUS DATOS?

Usamos tus datos **ÚNICAMENTE** para:

| Propósito | Base legal (RGPD) |
|-----------|-------------------|
| Gestionar tu cuenta | Ejecución del contrato (Art. 6.1.b) |
| Mostrar tus actividades y territorios | Ejecución del contrato (Art. 6.1.b) |
| Sincronizar con Polar/Strava/COROS | Consentimiento explícito (Art. 6.1.a) |
| Enviarte emails sobre amigos/territorios | Consentimiento explícito (Art. 6.1.a) |
| Mejorar el servicio | Interés legítimo (Art. 6.1.f) |
| Cumplir obligaciones legales | Obligación legal (Art. 6.1.c) |

### ❌ Lo que NO hacemos con tus datos:

- ❌ **NO vendemos** tus datos a terceros
- ❌ **NO usamos** Google Analytics ni Facebook Pixel
- ❌ **NO mostramos** publicidad personalizada
- ❌ **NO creamos** perfiles para marketing
- ❌ **NO compartimos** con redes publicitarias
- ❌ **NO rastreamos** tu comportamiento fuera de Runna.io

---

## 4. COOKIES Y ALMACENAMIENTO LOCAL

### 4.1. Cookies que utilizamos

| Cookie | Propósito | Duración | Tipo |
|--------|-----------|----------|------|
| `sidebar_state` | Recordar estado del menú lateral | 7 días | Funcional |

**Total: 1 cookie funcional**

> Esta cookie es estrictamente necesaria para el funcionamiento de la interfaz. No requiere consentimiento según la Directiva ePrivacy porque no rastrea usuarios.

### 4.2. Almacenamiento local (localStorage)

| Clave | Propósito | Duración |
|-------|-----------|----------|
| `runna_user_id` | Mantener tu sesión iniciada | Hasta que cierres sesión |

> El localStorage es almacenamiento del navegador que no se envía automáticamente con cada petición como las cookies. Se usa para mantener tu sesión.

### 4.3. ¿Necesito un banner de cookies?

**No es obligatorio** en este caso. Según la Directiva ePrivacy y las guías de la DPC irlandesa:
- Las cookies **estrictamente necesarias** para el funcionamiento no requieren consentimiento
- `sidebar_state` es funcional (guarda preferencia de UI)
- Cloudflare Analytics no usa cookies

Por transparencia, mostramos esta información en nuestra política de privacidad.

---

## 5. SERVICIOS DE TERCEROS

### 5.1. Turso (Base de datos)

| Campo | Información |
|-------|-------------|
| **Proveedor** | Turso (ChiselStrike, Inc.) |
| **Ubicación** | Servidores en UE |
| **Propósito** | Almacenar todos los datos de la aplicación |
| **Datos** | Toda la información de usuarios, rutas, territorios |
| **Cumplimiento** | Compatible con RGPD |

### 5.2. Cloudflare (Hosting y CDN)

| Campo | Información |
|-------|-------------|
| **Proveedor** | Cloudflare, Inc. |
| **Propósito** | Hosting (Workers), CDN, protección DDoS, Analytics |
| **Analytics** | Privacy-first, sin cookies, datos agregados |
| **Cumplimiento** | Certificado RGPD, Data Processing Addendum |

### 5.3. Resend (Emails transaccionales)

| Campo | Información |
|-------|-------------|
| **Proveedor** | Resend |
| **Propósito** | Enviar emails de bienvenida y notificaciones |
| **Datos enviados** | Email del destinatario, contenido del mensaje |
| **Cumplimiento** | Compatible con RGPD |

### 5.4. Polar Flow (Sincronización opcional)

| Campo | Información |
|-------|-------------|
| **Proveedor** | Polar Electro Oy (Finlandia - UE) |
| **Propósito** | Importar tus actividades deportivas |
| **Datos accedidos** | Ejercicios, rutas GPS, métricas |
| **Conexión** | OAuth 2.0 (tú autorizas el acceso) |
| **Desconexión** | Puedes desconectar en cualquier momento desde tu perfil |

### 5.5. Strava (Sincronización opcional)

| Campo | Información |
|-------|-------------|
| **Proveedor** | Strava, Inc. (EE.UU.) |
| **Propósito** | Importar tus actividades deportivas para gamificación comunitaria |
| **Datos accedidos** | Actividades, rutas GPS, métricas |
| **Uso de datos** | Generar territorios y mostrar rutas/actividades a la comunidad |
| **Conexión** | OAuth 2.0 (tú autorizas el acceso con consentimiento explícito) |
| **Desconexión** | Puedes desconectar en cualquier momento desde tu perfil |
| **Transferencia UE-EEUU** | Bajo cláusulas contractuales tipo (CCT) |

> **Nota sobre visibilidad comunitaria**: Runna.io es una **aplicación comunitaria** donde los atletas compiten por territorios. Al conectar Strava, tus rutas, actividades y territorios conquistados serán **visibles para otros miembros de la comunidad**. Esto es esencial para el funcionamiento del juego. Antes de conectar, se te mostrará un diálogo de consentimiento explicando exactamente qué datos serán compartidos.

> **Monitoreo por Strava**: De acuerdo con el Strava API Agreement (Sección 2.12), Strava puede monitorear y recopilar datos de uso relacionados con tu conexión a través de su API. Strava puede usar estos datos para mejorar sus servicios, proporcionar soporte, y asegurar el cumplimiento de sus términos.

### 5.6. COROS (Sincronización opcional)

| Campo | Información |
|-------|-------------|
| **Proveedor** | COROS Wearables, Inc. |
| **Propósito** | Importar tus workouts deportivos automáticamente |
| **Datos accedidos** | Workouts, rutas GPS, métricas de actividad |
| **Conexión** | OAuth 2.0 (tú autorizas el acceso) |
| **Desconexión** | Puedes desconectar en cualquier momento desde tu perfil |
| **Transferencia UE-EEUU** | Bajo cláusulas contractuales tipo (CCT) |

---

## 6. NOTIFICACIONES PUSH

### ¿Cómo funcionan?

Runna.io utiliza la **Web Push API nativa del navegador** para notificaciones push. 

| Aspecto | Detalle |
|---------|---------|
| **Tecnología** | Web Push API (estándar W3C) |
| **Terceros** | NO usamos Firebase, OneSignal, ni otros servicios externos |
| **Datos almacenados** | endpoint, claves p256dh y auth (generadas por tu navegador) |
| **Control** | Puedes desactivarlas en la configuración del navegador |

> Las notificaciones push son **completamente opcionales**. Puedes usar Runna.io sin activarlas.

---

## 7. TUS DERECHOS (RGPD)

Como usuario tienes derecho a:

### 7.1. Derecho de acceso (Art. 15)
Puedes solicitar una copia de todos tus datos personales.

### 7.2. Derecho de rectificación (Art. 16)
Puedes corregir tus datos desde tu perfil en la aplicación.

### 7.3. Derecho de supresión (Art. 17)
Puedes solicitar la eliminación de tu cuenta y todos tus datos.

### 7.4. Derecho de portabilidad (Art. 20)
Puedes solicitar tus datos en formato JSON para llevarlos a otro servicio.

### 7.5. Derecho de oposición (Art. 21)
Puedes oponerte al procesamiento de tus datos.

### 7.6. Derecho a retirar el consentimiento
Puedes desconectar Polar/Strava y desactivar notificaciones en cualquier momento.

### ¿Cómo ejercer estos derechos?

Envía un email a: **runna.io.service@gmail.com**

- Asunto: "Solicitud RGPD - [Tu derecho]"
- Incluye: Tu nombre de usuario y email de la cuenta
- Plazo de respuesta: **30 días** (RGPD Art. 12)

---

## 8. SEGURIDAD DE TUS DATOS

Implementamos las siguientes medidas:

| Medida | Descripción |
|--------|-------------|
| **Cifrado en tránsito** | HTTPS/TLS en todas las comunicaciones |
| **Cifrado en reposo** | Base de datos Turso con cifrado |
| **Hash de contraseñas** | SHA-256 con salt único (no almacenamos contraseñas en texto plano) |
| **Tokens OAuth** | Almacenados de forma segura, revocables en cualquier momento |
| **Protección DDoS** | Cloudflare protege contra ataques |

---

## 9. RETENCIÓN DE DATOS

| Tipo de dato | Retención |
|--------------|-----------|
| Cuenta de usuario | Hasta que solicites eliminación |
| Actividades importadas | Hasta que solicites eliminación |
| Rutas y territorios | Hasta que solicites eliminación |
| Tokens OAuth | Hasta desconexión o revocación |
| Preferencias email | Hasta eliminación de cuenta |

Cuando eliminas tu cuenta:
1. Todos tus datos se eliminan de forma permanente
2. Tus territorios se liberan (otros usuarios pueden conquistarlos)
3. Se eliminan tus relaciones de amistad
4. La eliminación es **inmediata e irreversible**

---

## 10. EDAD MÍNIMA

### Requisito de edad: **14 años**

En España, la edad de consentimiento digital es **14 años** según el artículo 7 de la LOPD-GDD que implementa el Art. 8 del RGPD.

**Runna.io establece una edad mínima de 14 años** porque:
- Es el mínimo legal establecido en España
- Los datos de actividad física pueden considerarse sensibles
- No disponemos de mecanismo de verificación de consentimiento parental
- Los menores de 14 años deben abstenerse de usar el servicio

Si detectamos que un usuario es menor de 14 años, procederemos a eliminar su cuenta.

---

## 11. TRANSFERENCIAS INTERNACIONALES

| Servicio | Ubicación | Mecanismo legal |
|----------|-----------|-----------------|
| Turso | UE | Sin transferencia fuera de UE |
| Cloudflare | Global | Data Processing Addendum + CCT |
| Resend | EE.UU. | Cláusulas Contractuales Tipo (CCT) |
| Strava | EE.UU. | Cláusulas Contractuales Tipo (CCT) |
| Polar | Finlandia (UE) | Sin transferencia fuera de UE |

---

## 12. CAMBIOS EN ESTA POLÍTICA

Si realizamos cambios significativos:
1. Actualizaremos la fecha de "Última actualización" al inicio del documento
2. Notificaremos por email si los cambios afectan sustancialmente a tus derechos
3. Publicaremos la nueva versión en runna.io/privacy

---

## 13. CONTACTO Y RECLAMACIONES

### Para consultas de privacidad:
**Email:** runna.io.service@gmail.com

### Para reclamaciones ante la autoridad de control:

**Agencia Española de Protección de Datos (AEPD)**
- Web: https://www.aepd.es
- Teléfono: 901 100 099
- Sede electrónica: https://sedeagpd.gob.es
- Dirección: C/ Jorge Juan, 6, 28001 Madrid, España

---

## 14. RESUMEN EJECUTIVO

| Aspecto | Estado |
|---------|--------|
| **Responsable** | Javier Poves Ruiz |
| **Cookies de tracking** | ❌ No usamos |
| **Google Analytics** | ❌ No usamos |
| **Facebook Pixel** | ❌ No usamos |
| **Publicidad** | ❌ No mostramos |
| **Venta de datos** | ❌ No vendemos |
| **Cloudflare Analytics** | ✅ Único analytics (privacy-first, sin cookies) |
| **Emails transaccionales** | ✅ Via Resend |
| **Push notifications** | ✅ Web Push API nativa (sin terceros) |
| **Sincronización deportiva** | ✅ Polar + Strava (opcional, con tu consentimiento) |
| **Base de datos** | ✅ Turso (servidores UE) |
| **Hosting** | ✅ Cloudflare Workers |
| **Edad mínima** | 14 años |

---

**Esta política de privacidad refleja con precisión las prácticas actuales de tratamiento de datos de Runna.io.**

© 2026 Javier Poves Ruiz - Runna.io
