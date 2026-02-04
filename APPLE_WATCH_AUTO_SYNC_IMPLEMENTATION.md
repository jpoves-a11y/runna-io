# 🔧 Plan Técnico: Implementar Sincronización Automática con Apple Watch

**Para desarrolladores de Runna.io**

---

## 📌 Objetivo

Implementar sincronización **automática** de actividades de Apple Watch desde Strava/Polar sin requerir que el usuario haga clic en el botón "Importar".

**Estado Actual**: Manual (requiere clic)  
**Estado Deseado**: Automático (sucede en background)

---

## 🏗️ Arquitectura Propuesta

```
┌─────────────────────────────────────────────────────────────┐
│ USUARIO TERMINA ACTIVIDAD EN APPLE WATCH                    │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ Strava/Polar Webhook → Runna.io Backend                     │
│ (Notificación de actividad nueva)                           │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ Worker (/api/webhooks/strava o /api/webhooks/polar)         │
│ • Valida token del webhook                                  │
│ • Obtiene detalles de la actividad                          │
│ • Verifica si ya existe                                     │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ Procesa Actividad (igual que ahora)                         │
│ • Decodifica polyline                                       │
│ • Calcula territorios                                       │
│ • Actualiza BD                                              │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ Resultados Visibles al Usuario                              │
│ • Actividad en BD automáticamente                           │
│ • Territorio creado/actualizado                             │
│ • Notificación push si conquistó territorio                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 📋 Opción 1: Strava Webhooks (RECOMENDADA)

### ¿Qué es?
Strava notifica a Runna.io cuando:
- El usuario completa una actividad
- Hace cambios en la actividad
- Eliminación de actividad

### Ventajas
- ✅ Notificación en tiempo real (segundos)
- ✅ Documentación excelente
- ✅ Muy confiable
- ✅ Implementado por mayoría de apps

### Desventajas
- ❌ Requiere webhook público (URL HTTPS)
- ❌ Cloudflare Worker debe ser accesible desde internet

### Esfuerzo de Desarrollo
**Estimado: 16-24 horas** (2-3 días)

---

### 1.1 Configuración de Webhook en Strava

**Paso 1: Registrar aplicación en Strava**

Ya está hecho (STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET existen).

**Paso 2: Crear endpoint de webhook**

Ubicación: [worker/src/routes.ts](worker/src/routes.ts)

```typescript
// ==================== STRAVA WEBHOOKS ====================

app.post('/api/webhooks/strava', async (c) => {
  try {
    const body = await c.req.json();
    
    // Validar token
    const verifyToken = c.env.STRAVA_WEBHOOK_VERIFY_TOKEN;
    const signature = c.req.header('x-strava-hook-id');
    
    // Log para debugging
    console.log('[WEBHOOK] Strava event received:', {
      object_type: body.object_type,
      aspect_type: body.aspect_type,
      owner_id: body.owner_id,
      object_id: body.object_id,
    });

    // Solo procesar actualizaciones de actividades
    if (body.object_type !== 'activity') {
      return c.json({ status: 'ignored - not an activity' });
    }

    // Solo crear (aspect_type: 'create') o actualizar (aspect_type: 'update')
    // Ignorar eliminaciones por ahora
    if (body.aspect_type === 'delete') {
      console.log('[WEBHOOK] Activity deleted, ignoring');
      return c.json({ status: 'deleted - ignored' });
    }

    const { owner_id: stravaAthleteId, object_id: stravaActivityId } = body;

    // Obtener usuario asociado a este Strava athlete
    const db = getDb(c.env);
    const storage = new WorkerStorage(db);
    const stravaAccount = await storage.getStravaAccountByStravaAthleteId(stravaActivityId);

    if (!stravaAccount) {
      console.log('[WEBHOOK] No Strava account found for athlete:', stravaAthleteId);
      return c.json({ status: 'ok - no account' }); // Return 200 anyway
    }

    const userId = stravaAccount.userId;
    console.log('[WEBHOOK] Processing activity for user:', userId);

    // Verificar si ya existe
    const existing = await storage.getStravaActivityByStravaId(stravaActivityId);
    if (existing && existing.processed) {
      console.log('[WEBHOOK] Activity already processed:', stravaActivityId);
      return c.json({ status: 'ok - already processed' });
    }

    // Obtener token válido
    const validToken = await getValidStravaToken(stravaAccount, storage, c.env);
    if (!validToken) {
      console.log('[WEBHOOK] Failed to get valid Strava token');
      return c.json({ status: 'error - no valid token' }, 401);
    }

    // Descargar detalles de la actividad
    console.log('[WEBHOOK] Fetching activity details from Strava...');
    const activityUrl = `https://www.strava.com/api/v3/activities/${stravaActivityId}`;
    const activityResponse = await fetch(activityUrl, {
      headers: {
        'Authorization': `Bearer ${validToken}`,
        'Accept': 'application/json',
      },
    });

    if (!activityResponse.ok) {
      console.error('[WEBHOOK] Failed to fetch activity:', activityResponse.status);
      return c.json({ status: 'error - fetch failed' }, 500);
    }

    const activity: any = await activityResponse.json();
    console.log('[WEBHOOK] Activity data received:', activity.name);

    // Procesar polyline
    let summaryPolyline = activity.map?.summary_polyline || '';
    
    if (!summaryPolyline && activity.map?.polyline) {
      summaryPolyline = activity.map.polyline;
    }

    // Si no hay polyline, no hay GPS
    if (!summaryPolyline) {
      console.log('[WEBHOOK] No polyline, skipping');
      return c.json({ status: 'ok - no polyline' });
    }

    // Validaciones básicas
    if (activity.distance < 100) {
      console.log('[WEBHOOK] Distance too short:', activity.distance);
      return c.json({ status: 'ok - distance too short' });
    }

    if (activity.moving_time < 60) {
      console.log('[WEBHOOK] Duration too short:', activity.moving_time);
      return c.json({ status: 'ok - duration too short' });
    }

    // Crear o actualizar actividad
    if (existing) {
      await storage.updateStravaActivity(existing.id, {
        name: activity.name,
        activityType: activity.type,
        distance: activity.distance,
        duration: activity.moving_time,
        startDate: new Date(activity.start_date),
        summaryPolyline,
      });
      console.log('[WEBHOOK] Activity updated:', stravaActivityId);
    } else {
      await storage.createStravaActivity({
        stravaActivityId: stravaActivityId,
        userId,
        routeId: null,
        territoryId: null,
        name: activity.name,
        activityType: activity.type,
        distance: activity.distance,
        duration: activity.moving_time,
        startDate: new Date(activity.start_date),
        summaryPolyline,
        processed: false,
        processedAt: null,
      });
      console.log('[WEBHOOK] Activity created:', stravaActivityId);
    }

    // IMPORTANTE: Procesar inmediatamente (crear ruta y territorio)
    console.log('[WEBHOOK] Starting automatic processing...');
    const processedCount = await processStravaActivities(userId, db);
    console.log('[WEBHOOK] Processing complete. Processed:', processedCount);

    return c.json({ 
      status: 'ok', 
      processed: processedCount > 0,
      message: `Activity imported and processed for ${processedCount} activities`
    });

  } catch (error: any) {
    console.error('[WEBHOOK] Error:', error);
    return c.json({ error: error.message }, 500);
  }
});

// ==================== WEBHOOK VALIDATION ====================

app.get('/api/webhooks/strava', async (c) => {
  try {
    const mode = c.req.query('hub.mode');
    const verifyToken = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');

    console.log('[WEBHOOK] Validation request:', { mode, verifyToken, challenge });

    const WEBHOOK_VERIFY_TOKEN = c.env.STRAVA_WEBHOOK_VERIFY_TOKEN;

    if (mode === 'subscribe' && verifyToken === WEBHOOK_VERIFY_TOKEN) {
      console.log('[WEBHOOK] Verified!');
      return c.json({ 'hub.challenge': challenge });
    } else {
      console.log('[WEBHOOK] Verification failed');
      return c.json({ error: 'Verification failed' }, 403);
    }
  } catch (error: any) {
    console.error('[WEBHOOK] Validation error:', error);
    return c.json({ error: error.message }, 500);
  }
});
```

### 1.2 Configurar secreto en Cloudflare Worker

```bash
# Set the webhook verify token
wrangler secret put STRAVA_WEBHOOK_VERIFY_TOKEN

# Valor recomendado: generar un string aleatorio fuerte
# Ejemplo: $(openssl rand -base64 32)
```

### 1.3 Registrar webhook con Strava

**Opción A: Mediante API (después del deploy)**

```bash
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -H "Authorization: Bearer YOUR_STRAVA_TOKEN" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "callback_url=https://runna-io-api.workers.dev/api/webhooks/strava" \
  -d "verify_token=YOUR_WEBHOOK_VERIFY_TOKEN"
```

**Opción B: Mediante Strava Settings**

1. Login en Strava.com
2. Settings → API Applications
3. Webhook Configuration
4. Callback URL: `https://runna-io-api.workers.dev/api/webhooks/strava`
5. Verify Token: (el mismo que en STRAVA_WEBHOOK_VERIFY_TOKEN)

### 1.4 Helper function para procesar actividades

```typescript
// En worker/src/routes.ts o worker/src/storage.ts

async function processStravaActivities(userId: string, db: Database): Promise<number> {
  const storage = new WorkerStorage(db);
  const unprocessedActivities = await storage.getUnprocessedStravaActivities(userId);
  
  let processed = 0;

  for (const activity of unprocessedActivities) {
    try {
      console.log(`[PROCESS] Processing Strava activity: ${activity.name}`);
      
      if (!activity.summaryPolyline) {
        console.log(`[PROCESS] No polyline, skipping`);
        continue;
      }

      // Decodificar polyline (ya existe en el código)
      const coordinates = decodePolyline(activity.summaryPolyline);
      
      if (coordinates.length < 2) {
        console.log(`[PROCESS] Not enough coordinates`);
        continue;
      }

      // Crear ruta (ya existe en el código)
      const route = await storage.createRoute({
        userId,
        name: activity.name,
        coordinates: JSON.stringify(coordinates),
        distance: activity.distance,
        duration: activity.duration,
        startedAt: new Date(activity.startDate),
        completedAt: new Date(activity.startDate + activity.duration * 1000),
        ranTogetherWith: JSON.stringify([]),
      });

      // Calcular territorios (ya existe en el código)
      const geometry = await calculateTerritoryGeometry(coordinates);
      const area = calculatePolygonArea(geometry);

      const territory = await storage.createTerritory({
        userId,
        routeId: route.id,
        geometry: JSON.stringify(geometry),
        area,
        conqueredAt: new Date(activity.startDate),
      });

      // Marcar como procesada
      await storage.updateStravaActivity(activity.id, {
        processed: true,
        processedAt: new Date(),
        routeId: route.id,
        territoryId: territory.id,
      });

      processed++;
      console.log(`[PROCESS] ✅ Activity processed: ${route.id}`);

    } catch (error: any) {
      console.error(`[PROCESS] ❌ Error processing activity: ${error.message}`);
    }
  }

  return processed;
}
```

---

## 📋 Opción 2: Sincronización Periódica Automática

### ¿Qué es?
Cada X minutos, el backend revisa si hay nuevas actividades sin procesar y las procesa automáticamente.

### Ventajas
- ✅ No requiere webhook público
- ✅ Más simple de implementar
- ✅ Funciona incluso si hay errores

### Desventajas
- ❌ Menos tiempo real (delay de minutos)
- ❌ Mayor carga en API de Strava
- ❌ Requiere cron job

### Esfuerzo de Desarrollo
**Estimado: 8-12 horas** (1-2 días)

---

### 2.1 Crear Scheduled Task

Ubicación: [worker/src/index.ts](worker/src/index.ts)

```typescript
// Auto-sync handler para ejecutar cada 30 minutos
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // ... existing code ...
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    console.log('[AUTO-SYNC] Starting scheduled auto-sync');
    
    try {
      const db = getDb(env);
      const storage = new WorkerStorage(db);

      // Obtener todos los usuarios con Strava conectado
      const stravaAccounts = await storage.getAllStravaAccounts();
      console.log(`[AUTO-SYNC] Found ${stravaAccounts.length} Strava accounts`);

      for (const account of stravaAccounts) {
        try {
          // Validar token
          const validToken = await getValidStravaToken(account, storage, env);
          if (!validToken) {
            console.warn(`[AUTO-SYNC] Invalid token for user: ${account.userId}`);
            continue;
          }

          // Sincronizar actividades
          const syncResult = await syncStravaActivitiesForUser(account.userId, validToken, storage, env);
          console.log(`[AUTO-SYNC] Synced ${syncResult.imported} activities for user: ${account.userId}`);

          // Procesar actividades
          const processedCount = await processStravaActivities(account.userId, db);
          console.log(`[AUTO-SYNC] Processed ${processedCount} activities for user: ${account.userId}`);

        } catch (error: any) {
          console.error(`[AUTO-SYNC] Error processing user ${account.userId}:`, error);
        }
      }

      console.log('[AUTO-SYNC] Scheduled sync complete');

    } catch (error: any) {
      console.error('[AUTO-SYNC] Fatal error:', error);
    }
  }
};
```

### 2.2 Configurar Cron en wrangler.toml

```toml
# wrangler.toml

[[triggers.crons]]
cron = "0 */30 * * * *"  # Ejecutar cada 30 minutos

# Otras opciones:
# "0 * * * * *"      # Cada hora
# "0 0 * * *"        # Cada día a medianoche
# "0 0 * * 0"        # Semanalmente (domingo)
```

### 2.3 Helpers necesarios

```typescript
async function syncStravaActivitiesForUser(
  userId: string, 
  accessToken: string, 
  storage: WorkerStorage,
  env: Env
): Promise<{ imported: number; skipped: number }> {
  // Similar a lo que ya existe en POST /api/strava/sync/:userId
  // Pero reutilizable como función
  
  const stravaUrl = 'https://www.strava.com/api/v3/athlete/activities?per_page=200';
  const response = await fetch(stravaUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Strava API error: ${response.status}`);
  }

  const activities = await response.json();
  let imported = 0;
  let skipped = 0;

  for (const activity of activities) {
    const existing = await storage.getStravaActivityByStravaId(activity.id);
    
    if (existing) {
      skipped++;
      continue;
    }

    // ... crear actividad como antes ...
    imported++;
  }

  return { imported, skipped };
}
```

---

## 🔐 Consideraciones de Seguridad

### Webhook
```typescript
// Validar origen del webhook (IMPORTANTE)
app.post('/api/webhooks/strava', async (c) => {
  const signature = c.req.header('x-strava-hook-id');
  const timestamp = c.req.header('x-strava-hook-timestamp');
  const body = await c.req.text();

  // Verificar que es de Strava
  // Strava no envía firma HMAC, pero podemos validar el token
  const verifyToken = c.req.query('hub.verify_token');
  if (verifyToken !== c.env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
    return c.json({ error: 'Invalid token' }, 403);
  }

  // ... resto del código ...
});
```

### Rate Limiting
```typescript
// Rate limit para evitar abuso
const rateLimit = new Map<string, number[]>();

app.post('/api/webhooks/strava', async (c) => {
  const userId = body.owner_id;
  const now = Date.now();
  
  const userRequests = rateLimit.get(userId) || [];
  const recentRequests = userRequests.filter(t => now - t < 60000); // 1 minuto

  if (recentRequests.length > 10) {
    return c.json({ status: 'rate limited' }, 429);
  }

  rateLimit.set(userId, [...recentRequests, now]);
  
  // ... proceso ...
});
```

### Deduplicación
```typescript
// Evitar procesar la misma actividad dos veces
const processed = new Set<string>();

app.post('/api/webhooks/strava', async (c) => {
  const key = `${owner_id}-${object_id}`;
  
  if (processed.has(key)) {
    return c.json({ status: 'already processing' });
  }

  processed.add(key);
  
  // ... proceso ...
  
  processed.delete(key); // Limpiar después
});
```

---

## 📊 Monitoreo y Alertas

### Logging
```typescript
// Crear estructura de logs
interface WebhookLog {
  timestamp: string;
  userId: string;
  stravaActivityId: number;
  status: 'success' | 'error' | 'skipped';
  reason?: string;
  processingTime: number;
}

// Guardar en tabla
const webhookLogs = sqliteTable("webhook_logs", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  stravaActivityId: integer("strava_activity_id"),
  status: text("status"),
  reason: text("reason"),
  processingTime: integer("processing_time"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});
```

### Alerts
```typescript
// Notificar al usuario si hay errores
async function notifyWebhookError(userId: string, error: string) {
  // Enviar email o notificación push
  await emailer.send({
    to: user.email,
    subject: 'Error importing Strava activity',
    body: `Failed to import activity: ${error}`,
  });
}
```

---

## 🧪 Testing

### Unit Tests
```typescript
// test/webhooks.test.ts

import { describe, it, expect } from 'vitest';
import { handleStravaWebhook } from '../worker/src/routes';

describe('Strava Webhooks', () => {
  it('should process activity creation', async () => {
    const payload = {
      object_type: 'activity',
      aspect_type: 'create',
      owner_id: 12345,
      object_id: 67890,
    };

    const result = await handleStravaWebhook(payload);
    expect(result.status).toBe('ok');
    expect(result.processed).toBe(true);
  });

  it('should ignore already processed activities', async () => {
    // ... test ...
  });

  it('should validate webhook token', async () => {
    // ... test ...
  });
});
```

### Manual Testing
```bash
# Test webhook locally
curl -X POST http://localhost:8787/api/webhooks/strava \
  -H "Content-Type: application/json" \
  -d '{
    "object_type": "activity",
    "aspect_type": "create",
    "owner_id": 12345,
    "object_id": 67890
  }'
```

---

## 📈 Implementación Timeline

### Fase 1: Webhooks (Recomendado)
| Tarea | Duración | Owner |
|-------|----------|-------|
| Implementar endpoint POST /api/webhooks/strava | 4h | Dev |
| Implementar endpoint GET /api/webhooks/strava (validación) | 2h | Dev |
| Crear función `processStravaActivities()` | 4h | Dev |
| Testing local | 4h | QA |
| Deploy a staging | 2h | DevOps |
| Register webhook con Strava | 1h | Dev |
| Testing en staging | 2h | QA |
| Deploy a production | 1h | DevOps |
| **TOTAL** | **20 horas** | |

**Timeline**: 2-3 días de desarrollo

---

### Fase 2: Mejorar UX (Seguimiento)
| Tarea | Duración |
|-------|----------|
| Actualizar UI para indicar "sincronizando automáticamente" | 2h |
| Agregar notificaciones de actividades importadas | 4h |
| Testing | 2h |
| **TOTAL** | **8 horas** |

**Timeline**: 1 día adicional

---

## ✅ Checklist de Deployment

- [ ] Código implementado en feature branch
- [ ] Tests unitarios passing (>80% coverage)
- [ ] Tests de integración con Strava funcionando
- [ ] Code review aprobado
- [ ] Secreto STRAVA_WEBHOOK_VERIFY_TOKEN configurado
- [ ] wrangler.toml actualizado
- [ ] Deployed a staging
- [ ] Testing manual en staging (5+ pruebas)
- [ ] Webhook registrado con Strava
- [ ] Monitoring configurado
- [ ] Alertas configuradas
- [ ] Documentación actualizada
- [ ] Deployed a production
- [ ] Monitoring en production activo (24h)
- [ ] Release notes publicadas

---

## 🚀 Post-Implementation

### Métricas a monitorear
- Latencia de webhook (target: <5 segundos)
- Success rate de procesamiento (target: >99%)
- Errores por día (target: <5)
- Usuarios con sincronización automática (target: >90%)

### Próximas mejoras
1. Polar webhooks (similar)
2. Apple HealthKit directo (si hay demanda)
3. Sincronización en background en PWA (Service Workers)
4. Real-time updates con WebSockets

---

**Documento preparado**: Febrero 3, 2026  
**Versión**: 1.0  
**Status**: Plan Técnico Completo ✅
