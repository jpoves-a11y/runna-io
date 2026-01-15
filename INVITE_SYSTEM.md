# 🔗 Sistema de Invitaciones de Amigos

## ✅ Funcionalidad Implementada

### 1. **Botón "Invitar" en FriendsPage**
- Ubicación: Header de la página `/friends`, junto al botón "Añadir"
- Icono: Share2 con animación al hover
- Acción: Abre el diálogo de invitación

### 2. **InviteFriendDialog Component**

#### Características:
- **Generación de Link**: 
  - Botón para generar link único de invitación
  - Token válido por 7 días
  - Formato: `https://runna-io.pages.dev/friends/accept/{token}`

- **Copiar Link**:
  - Input read-only con el link generado
  - Botón de copiar con feedback visual (✓)
  - Toast de confirmación

- **Compartir Directo**:
  - **WhatsApp**: Abre chat con mensaje pre-formateado
  - **Telegram**: Comparte directamente en Telegram
  - **Más**: Usa Web Share API (móviles) o copia al portapapeles

- **Regenerar Link**:
  - Botón para generar nuevo link si es necesario
  - Útil si el link anterior expiró

### 3. **AcceptFriendInvitePage** (`/friends/accept/:token`)

#### Estados:
1. **Sin Login**: 
   - Muestra mensaje de bienvenida
   - Botones para "Iniciar sesión" o "Registrarse"
   - Redirige a login/register

2. **Loading**: 
   - Spinner mientras procesa la invitación
   - Mensaje "Aceptando invitación..."

3. **Éxito**:
   - Icono de check verde
   - Mensaje "¡Invitación aceptada!"
   - Auto-redirección a `/friends` en 2 segundos

4. **Error**:
   - Icono X rojo
   - Mensaje "Link expirado o ya usado"
   - Botón para ir a página de amigos

## 🔄 Flujo de Usuario

### Invitar Amigo:
1. Usuario autenticado va a `/friends`
2. Click en botón "Invitar"
3. Click en "Generar link de invitación"
4. Sistema crea token único (válido 7 días)
5. Usuario ve el link y botones de compartir
6. Opciones:
   - **Copiar**: Copia al portapapeles y comparte manualmente
   - **WhatsApp**: Abre WhatsApp con mensaje pre-escrito
   - **Telegram**: Abre Telegram para compartir
   - **Más**: Usa share nativo del dispositivo

### Aceptar Invitación:
1. Amigo recibe link: `https://runna-io.pages.dev/friends/accept/{token}`
2. Click en el link
3. Si no tiene cuenta: se le pide login/registro
4. Si tiene cuenta: automáticamente se acepta la invitación
5. Amistad bidireccional creada
6. Redirección a `/friends` con toast de éxito

## 🎨 Diseño UI

### InviteFriendDialog:
```tsx
- Modal centrado con backdrop
- Header con icono Share2
- Estado inicial: botón grande "Generar link"
- Estado generado:
  - Input con link (read-only)
  - Botón de copiar
  - Grid 3 columnas con botones de compartir
  - Link "Generar nuevo link"
```

### AcceptFriendInvitePage:
```tsx
- Card centrada en pantalla
- Icono grande según estado (Users/Loader/Check/X)
- Título y descripción
- Botones de acción según estado
- Animaciones fade-in y pulse
```

## 🔌 Endpoints Usados

```bash
# Generar invitación
POST /api/friends/invite
Body: { userId: string }
Response: { token: string, url: string }

# Aceptar invitación
POST /api/friends/accept/:token
Response: Success/Error
```

## 📱 Mensajes de Compartir

### WhatsApp/Telegram:
```
¡Únete a mí en Runna! Compite conmigo conquistando territorio:
https://runna-io.pages.dev/friends/accept/{token}
```

### Web Share API (móviles):
```
Title: Invitación a Runna
Text: ¡Únete a mí en Runna! Compite conmigo conquistando territorio
URL: https://runna-io.pages.dev/friends/accept/{token}
```

## 🔒 Seguridad

- ✅ Tokens UUID únicos
- ✅ Expiración automática a los 7 días
- ✅ Un solo uso por token
- ✅ Validación de usuario autenticado
- ✅ Creación de amistad bidireccional automática

## 🚀 Despliegue

- **Frontend**: https://700ebedb.runna-io.pages.dev
- **Estado**: ✅ Funcional y testeado
- **Nuevas rutas**:
  - `/friends` - Página principal con botones Invitar y Añadir
  - `/friends/accept/:token` - Página de aceptación de invitaciones

## 📊 Testing

Para probar:
1. Login en la app
2. Ve a `/friends`
3. Click en "Invitar"
4. Genera un link
5. Copia el link o comparte por WhatsApp/Telegram
6. Abre el link en otra sesión/navegador
7. Verifica que la amistad se crea correctamente

## 🎯 Ventajas del Sistema

1. **Fácil de usar**: Un click para generar, un click para compartir
2. **Múltiples canales**: WhatsApp, Telegram, o cualquier método
3. **No requiere buscar**: El amigo solo hace click en el link
4. **Seguro**: Links con expiración y un solo uso
5. **Automático**: Amistad bidireccional sin confirmación adicional
6. **Mobile-first**: Compatible con Web Share API
