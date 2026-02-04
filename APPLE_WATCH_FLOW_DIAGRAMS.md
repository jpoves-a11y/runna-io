# 🔄 Flujos de Sincronización: Apple Watch → Runna.io

**Diagramas visuales de cada opción**

---

## 📊 Flujo Actual: Manual (Requiere clic)

```
┌──────────────────────────────────────────────────────────────────┐
│ SEMANA DE RUNNING CON APPLE WATCH                                │
└──────────────────────────────────────────────────────────────────┘

Lunes                     Jueves                      Domingo
  │                        │                            │
  ▼                        ▼                            ▼
┌─────┐                 ┌─────┐                     ┌─────┐
│ 5km │                 │ 10km│                     │ 15km│
│ Run │                 │ Run │                     │ Run │
└─────┘                 └─────┘                     └─────┘
  │                        │                            │
  └────────────────────────┼────────────────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   Strava     │
                    │ Sincroniza   │
                    │ automáticam. │
                    └──────────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │ Actividades en      │
                │ Strava Cloud (✅)   │
                └─────────────────────┘
                           │
                ┌──────────┴──────────┐
                │                     │
                ▼                     ▼
            ┌─────────┐          ┌────────────────┐
            │ Usuario │          │ Actividades    │
            │ abre    │          │ visibles en    │
            │ Runna.io│          │ Strava Web (✅)│
            └─────────┘          └────────────────┘
                │
                ▼
            ┌──────────────────────┐
            │ Perfil → Integraciones
            └──────────────────────┘
                │
                ▼
            ┌──────────────────────┐
            │ Click: "Importar de  │
            │ Strava"              │
            │ ⚠️ PASO MANUAL      │
            └──────────────────────┘
                │
                ▼
            ┌──────────────────────┐
            │ Runna.io Backend:    │
            │ • Obtiene actividades│
            │ • Decodifica route   │
            │ • Crea territorio    │
            │ • Actualiza ranking  │
            └──────────────────────┘
                │
                ▼
            ┌──────────────────────┐
            │ ✅ Mapa actualizado  │
            │ 30km conquistados    │
            │ Ranking: #3          │
            └──────────────────────┘

⏱️ Tiempo total: Manual (30 minutos a días)
⚠️ Fricción: Requiere acción del usuario
```

---

## 🚀 Flujo Propuesto 1: Webhooks de Strava (RECOMENDADO)

```
┌──────────────────────────────────────────────────────────────────┐
│ USUARIO COMPLETA ACTIVIDAD EN APPLE WATCH                        │
└──────────────────────────────────────────────────────────────────┘
          │
          ▼
    ┌──────────────────────┐
    │ Apple Watch 📱       │
    │ • GPS capturando...  │
    │ • Frecuencia cardíaca│
    │ • Datos de movimiento│
    └──────────────────────┘
          │
          │ "Actividad completada"
          ▼
    ┌──────────────────────┐
    │ Strava App (Watch)   │
    │ • Recibe datos       │
    │ • Calcula métricas   │
    └──────────────────────┘
          │
          │ Sincroniza automáticamente
          ▼
    ┌──────────────────────┐
    │ Strava Cloud ☁️      │
    │ • Almacena actividad │
    │ • Disponible en API  │
    └──────────────────────┘
          │
          │ Webhook notification
          │ (Instantáneo)
          ▼
    ┌──────────────────────────────────────────┐
    │ Runna.io Backend (Cloudflare Worker)     │
    │ POST /api/webhooks/strava                │
    │ • Recibe notificación                    │
    │ • Valida origen (verify token)           │
    │ • Obtiene detalles de actividad          │
    │ • Decodifica polyline (ruta)             │
    │ • Calcula territorio conquistado         │
    │ • Actualiza BD                           │
    │ • Calcula reconquistas de otros usuarios │
    │ • Genera eventos para notificaciones      │
    └──────────────────────────────────────────┘
          │
          ▼
    ┌──────────────────────┐
    │ ✅ BD Actualizada     │
    │ • Actividad creada    │
    │ • Territorio creado   │
    │ • Ranking calculado   │
    │ • Eventos registrados │
    └──────────────────────┘
          │
          │ Push notification
          │ (instantáneo)
          ▼
    ┌──────────────────────┐
    │ iPhone Usuario 📱    │
    │ Notificación:        │
    │ "¡Territorio         │
    │ conquistado!"        │
    │ "5km | 45min"        │
    └──────────────────────┘
          │
          ▼
    ┌──────────────────────┐
    │ Usuario abre Runna.io│
    │ Mapa ya actualizado  │
    │ • Nueva ruta visible │
    │ • Territorios teñidos│
    │ • Ranking actualizado│
    │ ✅ LISTO             │
    └──────────────────────┘

⏱️ Tiempo total: ~30 segundos (automático)
✅ Fricción: CERO (100% automático)
🎯 Experiencia: Excelente (notificación en tiempo real)
```

---

## 📊 Comparativa de Flujos

### Flujo Actual (Manual)
```
Actividad en Apple Watch
        ↓
Esperar a que usuario vuelva a abrir Runna.io
        ↓
Navigate a Perfil → Integraciones
        ↓
Click "Importar de Strava"
        ↓
Esperar procesamiento
        ↓
Ver cambios

⏱️ Peor caso: 24 horas
✋ Requiere acción: SÍ
```

### Flujo con Webhooks (Propuesto)
```
Actividad en Apple Watch
        ↓
Webhook de Strava → Runna.io
        ↓
Procesamiento automático
        ↓
BD actualizada
        ↓
Notificación push al usuario
        ↓
Usuario abre Runna.io (cuando quiera)
        ↓
Todo ya actualizado

⏱️ Latencia: 5-30 segundos
✋ Requiere acción: NO
```

---

## 🔄 Flujo Completo: De Actividad a Territorio

```
ENTRADA: Webhook de Strava
│
│ {
│   "object_type": "activity",
│   "aspect_type": "create",
│   "owner_id": 12345,
│   "object_id": 67890
│ }
│
▼
┌─────────────────────────────────────┐
│ 1. VALIDACIÓN                       │
│ • Verificar verify_token            │
│ • Confirmar que es actividad        │
│ • Buscar usuario en BD              │
│ • Obtener token válido de Strava    │
└─────────────────────────────────────┘
    │ ✅ Validación OK
    ▼
┌─────────────────────────────────────┐
│ 2. OBTENER DETALLES                │
│ • Llamar Strava API: /activities/ID│
│ • Recibir:                          │
│   - name: "Morning Run"             │
│   - distance: 5234 (metros)         │
│   - moving_time: 2340 (segundos)   │
│   - start_date: "2026-02-03T08:15" │
│   - map.summary_polyline: "encoded"│
└─────────────────────────────────────┘
    │ ✅ Detalles obtenidos
    ▼
┌─────────────────────────────────────┐
│ 3. PROCESAR POLYLINE                │
│ • Decodificar polyline de Strava    │
│ • Obtener array de coordenadas      │
│   [                                  │
│     [40.7128, -74.0060],  // NYC    │
│     [40.7129, -74.0061],            │
│     [40.7130, -74.0062],            │
│     ...                              │
│   ]                                  │
│ • Validar >2 puntos                 │
│ • Validar distancia >100m           │
│ • Validar duración >60s             │
└─────────────────────────────────────┘
    │ ✅ Polyline válido
    ▼
┌─────────────────────────────────────┐
│ 4. CREAR RUTA EN BD                 │
│ INSERT routes {                     │
│   id: "abc123",                     │
│   userId: "user456",                │
│   name: "Morning Run",              │
│   coordinates: JSON.stringify(...), │
│   distance: 5234,                   │
│   duration: 2340,                   │
│   startedAt: timestamp,             │
│   completedAt: timestamp            │
│ }                                   │
└─────────────────────────────────────┘
    │ ✅ Ruta creada
    ▼
┌─────────────────────────────────────┐
│ 5. CALCULAR TERRITORIO              │
│ • Crear polígono desde polyline     │
│ • Buffer de 10m alrededor           │
│ • Simplificar polígono              │
│ • Calcular área en m²               │
│   = 23456 m²                        │
│ • Convertir a GeoJSON               │
└─────────────────────────────────────┘
    │ ✅ Territorio calculado
    ▼
┌─────────────────────────────────────┐
│ 6. GUARDAR TERRITORIO EN BD         │
│ INSERT territories {                │
│   id: "ter789",                     │
│   userId: "user456",                │
│   routeId: "abc123",                │
│   geometry: GeoJSON,                │
│   area: 23456,                      │
│   conqueredAt: timestamp            │
│ }                                   │
└─────────────────────────────────────┘
    │ ✅ Territorio guardado
    ▼
┌─────────────────────────────────────┐
│ 7. VERIFICAR RECONQUISTAS           │
│ • Buscar otros territorios que      │
│   solapan con este                  │
│ • Para cada solapamiento:           │
│   - Calcular % conquistado          │
│   - Si >50% = territorio reconquistado
│   - Transferir ownership            │
│   - Crear evento de reconquista     │
└─────────────────────────────────────┘
    │ ✅ Reconquistas detectadas
    ▼
┌─────────────────────────────────────┐
│ 8. ACTUALIZAR RANKING               │
│ • Recalcular total de usuario:      │
│   new_total = sum(territories.area) │
│ • Recalcular rankings globales      │
│ • Actualizar leaderboard            │
└─────────────────────────────────────┘
    │ ✅ Ranking actualizado
    ▼
┌─────────────────────────────────────┐
│ 9. GENERAR NOTIFICACIONES           │
│ • Crear evento en tabla de eventos  │
│ • Push notification al usuario      │
│   "¡Conquistaste 2.3 hectáreas!"   │
│ • Email de resumen (opcional)       │
│ • Notificar usuarios reconquistados │
└─────────────────────────────────────┘
    │ ✅ Notificaciones enviadas
    ▼
┌─────────────────────────────────────┐
│ 10. RESPONDER AL WEBHOOK            │
│ HTTP 200 OK                         │
│ {                                   │
│   "status": "ok",                   │
│   "processed": true,                │
│   "territory_area": 23456,          │
│   "reconquests": 0,                 │
│   "processing_time_ms": 234         │
│ }                                   │
└─────────────────────────────────────┘
    │
    ▼
SALIDA: Todo completado en <500ms
```

---

## 🎮 Experiencia del Usuario (Antes vs Después)

### ANTES (Manual)
```
Lunes 8:00 AM
│
├─ Corro 5km con Strava en Apple Watch
│
├─ 8:30 AM: Vuelvo a casa
│  └─ Actividad visible en Strava
│
├─ ... pasan horas ...
│
├─ Martes 10:00 PM (34 horas después)
│  └─ Me acuerdo de Runna.io
│
├─ Abro app
├─ Voy a Perfil
├─ Hago clic en "Importar de Strava"
├─ Espero procesamiento
│
└─ Finalmente veo la ruta en el mapa

⏱️ Delay: 34+ horas
😞 Experiencia: Desconectada
```

### DESPUÉS (Webhooks)
```
Lunes 8:00 AM
│
├─ Corro 5km con Strava en Apple Watch
│
├─ 8:00:30 AM
│  └─ Webhook activado
│
├─ 8:00:35 AM
│  ├─ Push notification: "¡5km conquistados!"
│  └─ Mapa actualizado en background
│
├─ Abro app en el momento
│  └─ Territorio ya visible
│
└─ Veo mis amigos rechazando/defendiendo territorio

⏱️ Delay: 30 segundos
😊 Experiencia: Tiempo real y atractiva
```

---

## 🔐 Validación de Seguridad

```
Strava → Runna.io (Webhook)

1. Strava envía POST a https://runna.io/api/webhooks/strava
   
2. Headers validados:
   ✅ X-Strava-Signature (aunque simple)
   ✅ TLS/SSL (HTTPS obligatorio)
   
3. Body contiene:
   - object_type (verificado = "activity")
   - aspect_type (verificado = "create" o "update")
   - owner_id (usado para buscar usuario)
   - object_id (ID de actividad en Strava)
   
4. Runna.io valida:
   ✅ Existe usuario con ese Strava ID
   ✅ Usuario tiene token válido
   ✅ Token no ha expirado
   
5. Si pasa validaciones:
   ✅ Procesa actividad
   ✅ Retorna HTTP 200 OK
   
6. Si falla validación:
   ✅ Retorna HTTP 401 o 403
   ✅ Strava reintenta (hasta 8 veces)

⚠️ Rate limiting implementado
⚠️ Deduplicación implementada
⚠️ Logging de todos los webhooks
```

---

## 📈 Métricas de Rendimiento

```
Webhook Processing Benchmark:

Actividad simple (5km, 20 minutos):
  • Validación: 10ms
  • Obtener detalles: 150ms (HTTP call a Strava)
  • Procesar polyline: 50ms
  • Crear ruta: 30ms
  • Calcular territorio: 100ms
  • Guardar territorio: 30ms
  • Verificar reconquistas: 50ms
  • Actualizar ranking: 40ms
  • Notificaciones: 80ms
  ─────────────────────
  TOTAL: ~540ms
  
Actividad larga (20km, 120 minutos):
  • Similar pero con polyline más larga
  • Calcular territorio: 200ms (más puntos)
  • Verificar reconquistas: 150ms (más territorios)
  ─────────────────────
  TOTAL: ~800ms

Limits:
  ✅ <1 segundo es aceptable
  ✅ <100ms sería ideal
  ✅ Strava no espera respuesta inmediata
  ✅ Timeout de Strava: ~30 segundos (seguro)
```

---

## ✅ Implementación Checklist

```
FASE 1: Desarrollo
□ Crear endpoint POST /api/webhooks/strava
□ Crear endpoint GET /api/webhooks/strava (validación)
□ Implementar función processStravaActivities()
□ Agregar helper getValidStravaToken()
□ Configurar logging/monitoring
□ Tests unitarios
□ Tests de integración

FASE 2: Deployment
□ Generar STRAVA_WEBHOOK_VERIFY_TOKEN
□ Agregar a wrangler.toml
□ Deploy a staging
□ Validar en staging
□ Deploy a production
□ Configurar alertas

FASE 3: Registro
□ Registrar webhook con Strava API
□ O configurar en Strava Settings
□ Verificación: Test webhook

FASE 4: Testing en Producción
□ Usuario hace actividad
□ Webhook se recibe
□ Actividad aparece en Runna.io
□ Notificación enviada
□ Territorio visible en mapa
□ Ranking actualizado

FASE 5: Comunicación
□ Actualizar UI (ya no necesita botón)
□ Documentación de usuario
□ Blog post explicando feature
□ Email a usuarios existentes
```

---

**Diagrama preparado**: Febrero 3, 2026  
**Versión**: 1.0  
**Status**: Completo ✅
