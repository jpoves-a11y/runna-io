# 🏃 Garmin Connect Integration Analysis

## Resumen Ejecutivo

Este documento analiza cómo implementar la integración con Garmin Connect en Runna.io, siguiendo el mismo patrón utilizado para Polar Flow.

---

## 📊 Comparación: Polar vs Garmin

| Característica | Polar | Garmin |
|---------------|-------|--------|
| **Tipo de OAuth** | OAuth 2.0 | OAuth 2.0 |
| **Acceso** | Público (AccessLink API) | Programa de Desarrollador (requiere aprobación) |
| **Costo** | Gratuito | Gratuito para desarrollo, posibles fees comerciales |
| **Datos disponibles** | Actividades, ejercicios, HR | Actividades, salud, HR, sueño, estrés, más |
| **Push notifications** | Webhooks disponibles | Push callbacks disponibles |
| **Formato de datos** | JSON + GPX/TCX | JSON + FIT/GPX/TCX |

---

## 🔐 Autenticación OAuth 2.0

### Polar (Implementación actual)

```
1. Usuario → /api/polar/connect
2. Redirect → https://flow.polar.com/oauth2/authorization
3. Callback → /api/polar/callback con code
4. Token exchange → https://polarremote.com/v2/oauth2/token
5. User registration → https://www.polaraccesslink.com/v3/users
6. Guardar access_token + polar_user_id
```

### Garmin (Propuesto)

```
1. Usuario → /api/garmin/connect
2. Redirect → https://connect.garmin.com/oauthConfirm (OAuth 2.0)
3. Callback → /api/garmin/callback con code
4. Token exchange → Garmin OAuth endpoint
5. Guardar access_token + garmin_user_id
```

---

## 🛠️ Garmin Connect Developer Program

### Requisitos para Acceso

1. **Solicitar acceso** en: https://www.garmin.com/en-US/forms/GarminConnectDeveloperAccess/
2. **Aprobación típica**: 2 días hábiles
3. **Incluye**:
   - Documentación de API completa
   - Entorno de evaluación
   - Consumer Key y Consumer Secret
   - Acceso a Developer Portal

### APIs Disponibles

| API | Descripción | Uso para Runna.io |
|-----|-------------|-------------------|
| **Health API** | Pasos, HR, sueño, estrés | Opcional - métricas generales |
| **Activity API** | Actividades completas (running, cycling, etc.) | **PRINCIPAL** - sincronizar actividades |
| **Training API** | Push entrenamientos a dispositivos | Futuro - enviar planes |
| **Courses API** | Push rutas a dispositivos | Futuro - compartir rutas |
| **Women's Health API** | Ciclo menstrual, embarazo | No aplica |

### Activity API - Datos Disponibles

- **Tipo de actividad**: Running, Walking, Cycling, Swimming, Yoga, etc.
- **Métricas**: Distancia, duración, calorías, HR, cadencia, pace
- **Ubicación**: GPS tracks, polylines
- **Formatos**: JSON resumen + archivos FIT/GPX/TCX completos

---

## 📁 Esquema de Base de Datos Propuesto

### Tabla: garmin_accounts

```sql
CREATE TABLE garmin_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  garmin_user_id TEXT NOT NULL UNIQUE,  -- Garmin user access token ID
  access_token TEXT NOT NULL,
  access_token_secret TEXT NOT NULL,    -- OAuth 1.0a requiere secret
  -- Si usan OAuth 2.0:
  -- refresh_token TEXT,
  -- expires_at TEXT,
  registered_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Tabla: garmin_activities

```sql
CREATE TABLE garmin_activities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  garmin_activity_id TEXT NOT NULL UNIQUE,  -- ID único de Garmin
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT REFERENCES routes(id) ON DELETE SET NULL,
  territory_id TEXT REFERENCES territories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  distance REAL NOT NULL,         -- metros
  duration INTEGER NOT NULL,       -- segundos
  start_date TEXT NOT NULL,
  summary_polyline TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

---

## 🔄 Flujo de Integración Propuesto

### 1. Conexión Inicial (OAuth)

```typescript
// worker/src/routes.ts
app.get('/api/garmin/connect', async (c) => {
  const userId = c.req.query('userId');
  const GARMIN_CONSUMER_KEY = c.env.GARMIN_CONSUMER_KEY;
  
  if (!userId || !GARMIN_CONSUMER_KEY) {
    return c.json({ error: "userId required and Garmin not configured" }, 400);
  }

  const state = btoa(JSON.stringify({ userId, ts: Date.now() }));
  const redirectUri = `${c.env.WORKER_URL}/api/garmin/callback`;
  
  // Garmin OAuth 2.0 Authorization URL
  const authUrl = `https://connect.garmin.com/oauthConfirm?` +
    `client_id=${GARMIN_CONSUMER_KEY}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}` +
    `&scope=activity_export`;
  
  return c.json({ authUrl });
});
```

### 2. Callback y Token Exchange

```typescript
app.get('/api/garmin/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  
  // Decodificar state para obtener userId
  const { userId } = JSON.parse(atob(state));
  
  // Intercambiar code por access_token
  const tokenResponse = await fetch('https://connectapi.garmin.com/oauth-service/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa(`${GARMIN_CONSUMER_KEY}:${GARMIN_CONSUMER_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  
  const tokenData = await tokenResponse.json();
  // Guardar tokens en DB...
});
```

### 3. Sincronización de Actividades

```typescript
app.post('/api/garmin/sync/:userId', async (c) => {
  const userId = c.req.param('userId');
  const garminAccount = await storage.getGarminAccountByUserId(userId);
  
  // Obtener lista de actividades
  const activitiesResponse = await fetch(
    'https://apis.garmin.com/wellness-api/rest/activities',
    {
      headers: {
        'Authorization': `Bearer ${garminAccount.accessToken}`,
      },
    }
  );
  
  const activities = await activitiesResponse.json();
  
  // Procesar cada actividad (similar a Polar)
  for (const activity of activities) {
    // Verificar si ya existe
    const existing = await storage.getGarminActivityByGarminId(activity.activityId);
    if (existing) continue;
    
    // Crear nueva actividad
    await storage.createGarminActivity({
      garminActivityId: activity.activityId.toString(),
      userId,
      name: activity.activityName || 'Garmin Activity',
      activityType: mapGarminActivityType(activity.activityType),
      distance: activity.distanceInMeters || 0,
      duration: activity.durationInSeconds || 0,
      startDate: activity.startTimeGMT,
      summaryPolyline: null, // Obtener de archivo FIT/GPX si necesario
    });
  }
});
```

### 4. Push Notifications (Webhooks)

Garmin soporta **Push Architecture** donde ellos envían datos automáticamente:

```typescript
// Endpoint para recibir webhooks de Garmin
app.post('/api/garmin/webhook', async (c) => {
  const signature = c.req.header('X-Garmin-Signature');
  // Verificar firma HMAC
  
  const payload = await c.req.json();
  
  // Tipos de eventos:
  // - activities: Nueva actividad disponible
  // - dailies: Resumen diario
  // - epochs: Datos de HR por intervalos
  
  if (payload.activities) {
    for (const activity of payload.activities) {
      // Procesar nueva actividad
      await processGarminActivity(activity);
    }
  }
  
  return c.json({ success: true });
});
```

---

## 🎯 Mapeo de Tipos de Actividad

```typescript
function mapGarminActivityType(garminType: string): string {
  const mapping: Record<string, string> = {
    'running': 'Run',
    'trail_running': 'Run',
    'treadmill_running': 'Run',
    'walking': 'Walk',
    'hiking': 'Walk',
    'cycling': 'Ride',
    'mountain_biking': 'Ride',
    'swimming': 'Swim',
    'open_water_swimming': 'Swim',
    'yoga': 'Workout',
    'strength_training': 'Workout',
    // ... más mapeos
  };
  
  return mapping[garminType.toLowerCase()] || 'Workout';
}
```

---

## 📋 Pasos de Implementación

### Fase 1: Configuración (1-2 días)

1. [ ] Solicitar acceso al Garmin Connect Developer Program
2. [ ] Esperar aprobación (~2 días hábiles)
3. [ ] Obtener Consumer Key y Consumer Secret
4. [ ] Agregar variables de entorno:
   ```
   GARMIN_CONSUMER_KEY=xxx
   GARMIN_CONSUMER_SECRET=xxx
   ```

### Fase 2: Base de Datos (1 día)

1. [ ] Crear migración para `garmin_accounts`
2. [ ] Crear migración para `garmin_activities`
3. [ ] Agregar tipos en `shared/schema.ts`
4. [ ] Agregar métodos en storage

### Fase 3: Backend API (2-3 días)

1. [ ] Implementar `/api/garmin/connect` - Iniciar OAuth
2. [ ] Implementar `/api/garmin/callback` - Procesar callback
3. [ ] Implementar `/api/garmin/status/:userId` - Estado de conexión
4. [ ] Implementar `/api/garmin/sync/:userId` - Sincronización manual
5. [ ] Implementar `/api/garmin/disconnect` - Desconexión

### Fase 4: Frontend (1-2 días)

1. [ ] Agregar botón "Conectar Garmin" en ProfilePage
2. [ ] Mostrar estado de conexión
3. [ ] Botón de sincronizar actividades
4. [ ] Lista de actividades de Garmin

### Fase 5: Procesamiento (1 día)

1. [ ] Reutilizar lógica existente de procesamiento de rutas
2. [ ] Parsear polylines/GPX de Garmin
3. [ ] Crear rutas y territorios desde actividades

### Fase 6: Webhooks (Opcional - 1 día)

1. [ ] Configurar endpoint de webhook en Garmin Developer Portal
2. [ ] Implementar verificación de firma
3. [ ] Procesamiento automático de nuevas actividades

---

## ⚠️ Consideraciones Importantes

### 1. OAuth Version
Garmin históricamente usó **OAuth 1.0a**, pero está migrando a **OAuth 2.0**. Verificar documentación actual al solicitar acceso.

### 2. Rate Limits
- Garmin tiene límites de requests por minuto/hora
- Implementar exponential backoff
- Usar webhooks para evitar polling excesivo

### 3. Formatos de Datos
- **FIT**: Formato binario propietario de Garmin (más completo)
- **GPX/TCX**: Formatos XML estándar
- Considerar usar librería `fit-file-parser` para FIT

### 4. User Experience
- Garmin no permite auto-sync sin intervención del usuario
- El usuario debe sincronizar su reloj → Garmin Connect → Tu app
- Webhooks mejoran esto notificando cuando hay datos nuevos

### 5. Scope de Permisos
Solicitar solo lo necesario:
- `activity_export` - Exportar actividades
- `activity_read` - Leer actividades (opcional si solo export)

---

## 📚 Referencias

- **Garmin Developer Program**: https://developer.garmin.com/gc-developer-program/overview/
- **Activity API**: https://developer.garmin.com/gc-developer-program/activity-api/
- **Program FAQ**: https://developer.garmin.com/gc-developer-program/program-faq/
- **Solicitar acceso**: https://www.garmin.com/en-US/forms/GarminConnectDeveloperAccess/
- **Garth (OAuth library)**: https://github.com/matin/garth
- **Python Garmin Connect**: https://github.com/cyberjunky/python-garminconnect

---

## 🔄 Código de Referencia: Polar vs Garmin

### Polar (Actual)

```typescript
// Endpoints usados:
// Auth: https://flow.polar.com/oauth2/authorization
// Token: https://polarremote.com/v2/oauth2/token
// Register: https://www.polaraccesslink.com/v3/users
// Exercises: https://www.polaraccesslink.com/v3/users/{id}/exercise-transactions
```

### Garmin (Propuesto)

```typescript
// Endpoints (verificar con documentación actual):
// Auth: https://connect.garmin.com/oauthConfirm
// Token: https://connectapi.garmin.com/oauth-service/oauth/token
// Activities: https://apis.garmin.com/wellness-api/rest/activities
// Webhook: Configurado en Developer Portal
```

---

## ✅ Checklist Final

- [ ] Acceso al Developer Program aprobado
- [ ] Variables de entorno configuradas
- [ ] Migraciones de DB ejecutadas
- [ ] Endpoints de API implementados
- [ ] UI de conexión funcionando
- [ ] Sincronización manual funcionando
- [ ] Procesamiento de rutas funcionando
- [ ] (Opcional) Webhooks configurados
- [ ] Testing end-to-end completado

---

*Documento creado: Febrero 2026*
*Última actualización: Febrero 2026*
