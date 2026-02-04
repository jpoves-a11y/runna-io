# 🚀 Soluciones Prácticas: Múltiples Usuarios en Strava

**Cómo realmente solucionar el problema**

---

## 🎯 El Problema Real Identificado

Strava API **SÍ permite múltiples usuarios**, pero hay un problema de implementación.

### Síntomas Observados
- ❌ "Solo se puede conectar un usuario a la vez"
- ❌ Nuevo usuario desconecta al anterior
- ❌ Error al conectarse múltiples usuarios

### Causa Probable
El endpoint OAuth callback está mal diseñado.

---

## 🔍 Diagnóstico: ¿Dónde Está el Bug?

### Problema 1: OAuth Callback no usa userId

**Código actual (INCORRECTO)**:
```typescript
app.get('/api/strava/callback', async (c) => {
  // ❌ El callback es global
  // ❌ No sabe a qué usuario conectar
  // ❌ Nuevo usuario pisotea al anterior
});
```

**Debería ser**:
```typescript
app.get('/api/strava/callback/:userId', async (c) => {
  const userId = c.req.param('userId');
  // ✅ Cada usuario tiene su propio callback
  // ✅ Múltiples simultáneamente
});

// O usar "state" parameter:
app.get('/api/strava/callback', async (c) => {
  const state = c.req.query('state'); // state = userId
  // ✅ Cada usuario identificado
});
```

### Problema 2: State Parameter No Usado

**Flujo de OAuth correcto**:
```
1. Usuario hace click "Conectar Strava"
   → Frontend guarda su userId en variable

2. Frontend redirige a Strava:
   https://www.strava.com/oauth/authorize
   ?client_id=XXX
   &state=USER_ID_DEL_USUARIO  ← IMPORTANTE
   &redirect_uri=...

3. Strava redirige de vuelta:
   /api/strava/callback?code=XXX&state=USER_ID_DEL_USUARIO
                                 ↑
                            IDENTIFICAMOS AL USUARIO

4. Guardamos token para ese usuario específico
```

**Verificar en el código actual**:
```typescript
// En línea ~1285
const redirectUri = `${c.env.WORKER_URL || 'https://...'}/api/strava/callback`;
// ❌ Esto no incluye userId

// Debería ser:
const redirectUri = `${c.env.WORKER_URL}/api/strava/callback?userId=${userId}`;
// O mejor:
const state = userId; // Pasar userId en state
```

---

## ✅ Solución 1: Fijar OAuth con State Parameter (2-4 horas)

### Step 1: Frontend - Guardar userId en Strava OAuth link

```typescript
// client/src/pages/ProfilePage.tsx

const handleConnectStrava = () => {
  const userId = user?.id; // ID del usuario actual
  
  // Construir OAuth URL con state
  const stravaOAuthUrl = 
    `https://www.strava.com/oauth/authorize` +
    `?client_id=YOUR_CLIENT_ID` +
    `&response_type=code` +
    `&redirect_uri=https://runna-io.workers.dev/api/strava/callback` +
    `&approval_prompt=force` +
    `&scope=profile:read_all,activity:read_all` +
    `&state=${userId}`; // ← userId en state
  
  window.location.href = stravaOAuthUrl;
};
```

### Step 2: Backend - Leer userId del state parameter

```typescript
// worker/src/routes.ts

app.get('/api/strava/callback', async (c) => {
  try {
    const code = c.req.query('code');
    const state = c.req.query('state'); // ← Obtener userId del state
    const userId = state; // El userId viene en state
    
    if (!userId) {
      return c.json({ error: 'No user ID provided' }, 400);
    }

    console.log(`[STRAVA] Connecting user: ${userId}`);

    const db = getDb(c.env);
    const storage = new WorkerStorage(db);

    // Token exchange
    const tokenResponse = await fetch(
      'https://www.strava.com/api/v3/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: c.env.STRAVA_CLIENT_ID,
          client_secret: c.env.STRAVA_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
        }),
      }
    );

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      console.error(`[STRAVA] Token exchange failed:`, error);
      return c.json({ error: 'Token exchange failed' }, 400);
    }

    const tokenData = await tokenResponse.json();
    
    console.log(
      `[STRAVA] ✅ Got token for athlete:`,
      tokenData.athlete.id,
      `user:`,
      userId
    );

    // Guardar token para ESTE usuario específico
    await storage.createStravaAccount({
      userId, // ← Key: guardar para usuario específico
      stravaAthleteId: tokenData.athlete.id,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: new Date(tokenData.expires_at * 1000),
      scope: tokenData.scope,
      athleteData: JSON.stringify(tokenData.athlete),
    });

    console.log(`[STRAVA] ✅ Saved for user: ${userId}`);

    // Redirigir con éxito
    return c.redirect(
      `/profile?strava_connected=true&user=${userId}`
    );

  } catch (error: any) {
    console.error('[STRAVA] Callback error:', error);
    return c.json({ error: error.message }, 500);
  }
});
```

---

## ✅ Solución 2: Manejar Expiración de Tokens (2-3 horas)

Strava tokens expiran. Si no se refreshan, el usuario se desconecta.

### Implementar Token Refresh Automático

```typescript
// worker/src/routes.ts

// Helper: obtener token válido (existente pero verificar)
async function getValidStravaToken(
  stravaAccount: StravaAccount,
  storage: WorkerStorage,
  env: Env
): Promise<string | null> {
  try {
    // Verificar si token expiró
    const expiresAt = new Date(stravaAccount.expiresAt);
    const now = new Date();

    if (now < expiresAt) {
      // Token aún válido, retornar
      console.log('[STRAVA] Token still valid');
      return stravaAccount.accessToken;
    }

    console.log('[STRAVA] Token expired, refreshing...');

    // Token expiró, refrescar
    const refreshResponse = await fetch(
      'https://www.strava.com/api/v3/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: env.STRAVA_CLIENT_ID,
          client_secret: env.STRAVA_CLIENT_SECRET,
          refresh_token: stravaAccount.refreshToken,
          grant_type: 'refresh_token',
        }),
      }
    );

    if (!refreshResponse.ok) {
      console.error('[STRAVA] Refresh failed:', await refreshResponse.text());
      return null;
    }

    const newTokenData = await refreshResponse.json();

    // Guardar token nuevo
    await storage.updateStravaAccount(stravaAccount.userId, {
      accessToken: newTokenData.access_token,
      refreshToken: newTokenData.refresh_token,
      expiresAt: new Date(newTokenData.expires_at * 1000),
    });

    console.log('[STRAVA] ✅ Token refreshed');
    return newTokenData.access_token;

  } catch (error: any) {
    console.error('[STRAVA] Token validation error:', error);
    return null;
  }
}

// Usar en endpoints de sync
app.post('/api/strava/sync/:userId', async (c) => {
  try {
    const userId = c.req.param('userId');
    const db = getDb(c.env);
    const storage = new WorkerStorage(db);
    
    const stravaAccount = await storage.getStravaAccountByUserId(userId);
    
    if (!stravaAccount) {
      return c.json({ error: 'Strava not connected' }, 404);
    }

    // ✅ Obtener token válido (refresh si es necesario)
    const validToken = await getValidStravaToken(stravaAccount, storage, c.env);
    
    if (!validToken) {
      console.log('[STRAVA] No valid token, disconnecting account');
      await storage.deleteStravaAccount(userId);
      return c.json({ error: 'Token expired, please reconnect' }, 401);
    }

    // Ahora continuar con sync usando validToken
    const response = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=50`,
      {
        headers: { 'Authorization': `Bearer ${validToken}` },
      }
    );

    // ... rest del código
  } catch (error: any) {
    console.error('[STRAVA] Sync error:', error);
    return c.json({ error: error.message }, 500);
  }
});
```

---

## ✅ Solución 3: Rate Limiting - Cachear Tokens (2 horas)

Si muchos usuarios sincronizan simultáneamente, Strava puede rate-limitar.

### Implementar Cache Local

```typescript
// worker/src/routes.ts

// In-memory cache (perderá datos si worker reinicia, pero es OK)
const tokenCache = new Map<string, {
  token: string;
  expiresAt: number;
}>();

async function getStravaTokenCached(
  userId: string,
  storage: WorkerStorage,
  env: Env
): Promise<string | null> {
  // Verificar cache
  const cached = tokenCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    console.log('[STRAVA] Token from cache for user:', userId);
    return cached.token;
  }

  // No está en cache o expiró, obtener de BD
  const stravaAccount = await storage.getStravaAccountByUserId(userId);
  if (!stravaAccount) {
    return null;
  }

  // Validar token de BD
  const validToken = await getValidStravaToken(stravaAccount, storage, env);
  
  if (validToken) {
    // Guardar en cache
    tokenCache.set(userId, {
      token: validToken,
      expiresAt: new Date(stravaAccount.expiresAt).getTime(),
    });
  }

  return validToken;
}

// Usar en sync
app.post('/api/strava/sync/:userId', async (c) => {
  const userId = c.req.param('userId');
  const db = getDb(c.env);
  const storage = new WorkerStorage(db);
  
  // ✅ Obtener token del cache si existe
  const token = await getStravaTokenCached(userId, storage, c.env);
  
  if (!token) {
    return c.json({ error: 'No valid token' }, 401);
  }

  // ... continuar con sync
});
```

---

## ✅ Solución 4: Manejar Revocación de Tokens (1 hora)

A veces usuarios desconectan en Strava pero la app no lo sabe.

### Detectar y Manejar Desconexiones

```typescript
// worker/src/routes.ts

async function syncStravaActivities(
  userId: string,
  validToken: string,
  storage: WorkerStorage,
  env: Env
): Promise<{ imported: number; error?: string }> {
  try {
    const response = await fetch(
      'https://www.strava.com/api/v3/athlete/activities?per_page=50',
      {
        headers: { 'Authorization': `Bearer ${validToken}` },
      }
    );

    // Detectar revocación de token
    if (response.status === 401) {
      console.warn(`[STRAVA] Token revoked for user: ${userId}`);
      
      // Limpiar BD
      await storage.deleteStravaAccount(userId);
      
      // Limpiar cache
      tokenCache.delete(userId);
      
      return {
        imported: 0,
        error: 'Token revoked - please reconnect',
      };
    }

    if (!response.ok) {
      console.error('[STRAVA] Activities fetch failed:', response.status);
      return {
        imported: 0,
        error: `Strava API error: ${response.status}`,
      };
    }

    const activities = await response.json();
    let imported = 0;

    for (const activity of activities) {
      // Procesar actividad...
      imported++;
    }

    return { imported };

  } catch (error: any) {
    console.error('[STRAVA] Sync error:', error);
    return {
      imported: 0,
      error: error.message,
    };
  }
}
```

---

## 📋 Checklist de Implementación

### Fase 1: Diagnosticar (1 hora)
- [ ] Revisar logs de Strava callbacks
- [ ] Ver qué userId llega en state parameter
- [ ] Ver si tokens se guardan correctamente
- [ ] Ver si tokens se refrescan

### Fase 2: Fijar OAuth (2-3 horas)
- [ ] Asegurar state parameter incluye userId
- [ ] Modificar callback para leer state
- [ ] Guardar token para userId correcto
- [ ] Testing con 2-3 usuarios simultáneamente

### Fase 3: Token Management (2-3 horas)
- [ ] Implementar getValidStravaToken()
- [ ] Refresh automático si expira
- [ ] Detectar revocación
- [ ] Limpiar BD si token inválido

### Fase 4: Caching (1-2 horas)
- [ ] Cache en-memory de tokens
- [ ] Expiración de cache
- [ ] Testing de rate limits

### Fase 5: Testing (2 horas)
- [ ] 5+ usuarios simultáneos
- [ ] Token expiration/refresh
- [ ] Revocación de tokens
- [ ] Rate limiting

**Total**: 8-12 horas (1-1.5 días)

---

## 🧪 Testing Script

```bash
#!/bin/bash

# Test múltiples usuarios Strava simultáneamente

USER_IDS=(
  "user1"
  "user2"
  "user3"
  "user4"
  "user5"
)

for uid in "${USER_IDS[@]}"; do
  echo "Testing user: $uid"
  
  # Conectar a Strava (simulado)
  curl -X GET "https://runna-io.workers.dev/api/strava/oauth?userId=$uid"
  
  # Esperar callback (3-5 segundos)
  sleep 3
  
  # Sincronizar actividades
  curl -X POST "https://runna-io.workers.dev/api/strava/sync/$uid"
  
  echo "---"
done

echo "All users tested"
```

---

## 📊 Comparativa: Antes vs Después

| Aspecto | Antes | Después |
|---------|-------|---------|
| **Usuarios simultáneos** | 1 | ∞ |
| **Error al reconectar** | ❌ Sí | ✅ No |
| **Token expirado** | ❌ Error | ✅ Auto-refresh |
| **Revocación detectada** | ❌ No | ✅ Sí |
| **Cache de tokens** | ❌ No | ✅ Sí |
| **Tiempo de implementación** | N/A | 8-12h |

---

## ✅ Conclusión

**No necesitas conectarte directamente a Apple Watch.**

El problema es que Strava OAuth está mal configurado para múltiples usuarios. La solución es:

1. ✅ **Usar state parameter** correctamente
2. ✅ **Refresh tokens** automáticamente
3. ✅ **Cachear tokens** localmente
4. ✅ **Detectar revocación**

Con estos cambios:
- ✅ Múltiples usuarios funcionan simultáneamente
- ✅ Strava funciona perfectamente
- ✅ Mejor rendimiento (cache)
- ✅ 100% automático

**Tiempo total**: 1-2 días de desarrollo
**ROI**: Resuelve el problema completamente

---

Implementar estas 4 soluciones y el sistema funcionará sin limitaciones.
