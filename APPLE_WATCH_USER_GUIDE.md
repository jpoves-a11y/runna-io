# 📱 Guía Práctica: Sincronizar Apple Watch con Runna.io

**Para usuarios finales de Runna.io**

---

## 🎯 El Punto: ¿Qué quiero hacer?

Quiero que mis actividades de **Apple Watch** aparezcan automáticamente en **Runna.io**.

### La buena noticia ✅
**¡Esto es posible y muy fácil!**

No necesitas hacer nada especial. Apple Watch ya es completamente compatible con las plataformas que Runna.io usa (Strava y Polar).

---

## 🚀 Quick Start (3 minutos)

### Opción A: Usando Strava (Recomendado) ⭐

**Paso 1: Instala Strava en Apple Watch**
1. Abre App Store en tu Apple Watch
2. Busca "Strava"
3. Descárgalo e instala
4. Abre Strava, inicia sesión con tu cuenta

**Paso 2: Conecta Strava a Runna.io**
1. Abre Runna.io en tu iPhone
2. Ve a **Perfil** → **Integraciones**
3. Busca la sección "Strava"
4. Haz clic en **"Conectar Strava"**
5. Autoriza el acceso

**Paso 3: ¡Listo! Ahora**
1. Cuando hagas una actividad en Apple Watch (correr, ciclismo, etc.)
2. Abre la app Strava en tu reloj
3. Inicia la actividad
4. Corre normalmente
5. Strava registra todo automáticamente

**Paso 4: Importa a Runna.io**
1. Vuelve a Runna.io
2. Ve a **Perfil** → **Strava**
3. Haz clic en **"Importar de Strava"**
4. ✅ Tus actividades aparecen en Runna.io
5. ✅ Los territorios se crean automáticamente

---

### Opción B: Usando Polar ⭐

**Paso 1: Instala Polar Sports en Apple Watch**
1. Abre App Store en tu Apple Watch
2. Busca "Polar Sports"
3. Descárgalo e instala
4. Abre Polar, inicia sesión

**Paso 2: Conecta Polar a Runna.io**
1. Abre Runna.io en tu iPhone
2. Ve a **Perfil** → **Integraciones**
3. Busca la sección "Polar"
4. Haz clic en **"Conectar Polar"**
5. Autoriza el acceso

**Paso 3: ¡Listo! Ahora**
1. Cuando hagas una actividad en Apple Watch
2. Abre la app Polar en tu reloj
3. Inicia la actividad
4. Entrena normalmente
5. Polar registra todo

**Paso 4: Importa a Runna.io**
1. Vuelve a Runna.io
2. Ve a **Perfil** → **Polar**
3. Haz clic en **"Importar de Polar"**
4. ✅ Tus actividades importadas
5. ✅ Territorios creados

---

## 📊 ¿Cuál elegir? Strava vs Polar

| Aspecto | Strava | Polar |
|--------|--------|-------|
| **Facilidad** | Muy fácil | Muy fácil |
| **Comunidad** | Enorme (90M+ usuarios) | Menor pero muy técnica |
| **Precio** | Freemium (~$80/año Strava+) | Gratis |
| **Apple Watch** | ✅ Perfecto | ✅ Perfecto |
| **Datos de salud** | Buenos | Excelentes |
| **Sincronización** | Automática a Strava | Automática a Polar |
| **Recomendación** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |

**Nuestro consejo**: Empieza con **Strava** (más usuarios, mejor comunidad), pero Polar es excelente si te interesa el análisis de training.

---

## 🔄 ¿Cómo funciona por dentro?

```
┌─────────────────────────────────────────────────────────┐
│ Cuando CORRES en Apple Watch                            │
└─────────────────────────────────────────────────────────┘
                         ⬇️
┌─────────────────────────────────────────────────────────┐
│ Apple Watch 📱                                          │
│ • Registra GPS en tiempo real                           │
│ • Mide distancia, tiempo, calorías                      │
│ • Captura frecuencia cardíaca                           │
└─────────────────────────────────────────────────────────┘
                         ⬇️
┌─────────────────────────────────────────────────────────┐
│ Strava App (en el reloj)                                │
│ • Recibe datos del reloj                                │
│ • Sincroniza automáticamente a Strava Cloud             │
└─────────────────────────────────────────────────────────┘
                         ⬇️
┌─────────────────────────────────────────────────────────┐
│ Strava Cloud ☁️                                          │
│ • Almacena tu actividad                                 │
│ • Disponible en API REST                                │
└─────────────────────────────────────────────────────────┘
                         ⬇️
┌─────────────────────────────────────────────────────────┐
│ Runna.io Backend                                        │
│ • Lee tu actividad desde API de Strava                  │
│ • Convierte a ruta en Runna.io                          │
│ • Calcula territorios conquistados                      │
└─────────────────────────────────────────────────────────┘
                         ⬇️
┌─────────────────────────────────────────────────────────┐
│ Tu Mapa en Runna.io 🗺️                                  │
│ • Tu ruta aparece en el mapa                            │
│ • Los territorios se pintan con tu color               │
│ • Se actualiza tu ranking                               │
└─────────────────────────────────────────────────────────┘
```

**Tiempo total**: Automático al terminar la actividad (depende de sincronización de Strava)

---

## ❓ Preguntas Frecuentes

### ¿Necesito hacer algo especial en el Apple Watch?
**No**. Simplemente usa Strava o Polar como lo harías normalmente. Ellos se encargan de todo.

### ¿Se sincroniza automáticamente?
**Parcialmente**:
- ✅ Strava sincroniza automáticamente a su cloud
- ✅ Polar sincroniza automáticamente a su cloud
- ⚠️ Runna.io requiere un clic en "Importar" (por ahora)

Estamos trabajando en hacerlo 100% automático.

### ¿Qué datos se comparten?
```
De Strava/Polar a Runna.io:
✅ Ruta exacta (coordenadas GPS)
✅ Distancia recorrida
✅ Tiempo de actividad
✅ Tipo de deporte (running, cycling, etc.)
✅ Fecha y hora de inicio
✅ Frecuencia cardíaca (disponible)
```

### ¿Es privado?
**Sí**, totalmente:
- Tus datos se almacenan en Runna.io
- No se comparten con nadie
- Nunca vendemos datos
- Puedes eliminar todo cuando quieras

### ¿Puedo usar otra app para registrar en Apple Watch?
**Posiblemente**, si la app sincroniza a Strava:
- Garmin → Strava ✅
- Fitbit → Strava ✅
- Runkeeper → Strava ✅
- Komoot → Strava ✅
- La mayoría de apps → Strava ✅

**Respuesta corta**: Si la app se conecta a Strava, funciona con Runna.io.

### ¿Funciona sin Strava o Polar?
Actualmente no. Necesitas una de estas dos plataformas como intermediario.

Estamos explorando conectar directamente con Apple HealthKit en el futuro.

### ¿Cuánto cuesta?
```
Apple Watch Series 4+     → Precio del reloj (~$400)
Strava                    → Gratis (o $80/año para más datos)
Polar                     → Gratis
Runna.io                  → Gratis ✅
────────────────────────────────────
TOTAL: Lo que gastes en el reloj + Strava opcional
```

### ¿Qué Apple Watch necesito?
```
Necesario:
✅ Series 4 o más nuevo (incluye GPS)
✅ Ultra
✅ SE (generación 2)

No funciona:
❌ Series 3 o anterior (sin GPS)
❌ Apple Watch Edition (es igual a Series)
```

**Mínimo**: Apple Watch Series 4 (~$250)

### ¿Funciona si no tengo iPhone?
**No**, necesitas:
- ✅ iPhone con Runna.io app (es PWA, funciona en cualquier navegador)
- ✅ Apple Watch emparejado con el iPhone
- ✅ Strava/Polar instalados en ambos dispositivos

### ¿Puedo desconectarme cuando quiera?
**Sí**, en cualquier momento:
1. Ve a **Perfil** → **Integraciones**
2. Busca Strava o Polar
3. Haz clic en **"Desconectar"**
4. ✅ Automáticamente se deja de sincronizar
5. Tus actividades antiguas quedan en Runna.io (si quieres, las puedes eliminar)

---

## 🐛 Troubleshooting

### "No me aparece el botón de Strava/Polar"
**Solución**:
1. Cierra Runna.io completamente
2. Abre de nuevo
3. Ve a **Perfil** → **Integraciones**
4. Deberías ver la sección "Strava" o "Polar"

Si no aparece, actualiza la app.

### "No me sincroniza las actividades"
**Checklist**:
- [ ] ¿Strava/Polar está instalada en Apple Watch?
- [ ] ¿Iniciaste la actividad en Strava/Polar (no otra app)?
- [ ] ¿El reloj tiene conexión (WiFi o iPhone cerca)?
- [ ] ¿Esperaste 5 minutos después de terminar?
- [ ] ¿Hiciste clic en "Importar" en Runna.io?

**Solución rápida**:
1. Abre Strava en iPhone → confirma que la actividad aparece
2. Si aparece en Strava pero no en Runna.io → haz clic en "Importar"
3. Si no aparece en Strava → revisa configuración de Strava/Apple Watch

### "No me aparecen las coordenadas GPS"
**Posibles causas**:
- El Apple Watch no tenía GPS activado
- No tenía conexión durante la actividad
- La actividad fue muy corta

**Solución**:
1. Ve a **Apple Watch Settings** → **Privacy**
2. Asegúrate que Strava tiene permiso para **Location**
3. La próxima vez verifica que el reloj diga "Usando GPS"

### "Dice error al conectar Strava/Polar"
**Solución**:
1. Cierra la app completamente
2. Abre Runna.io de nuevo
3. Intenta conectar nuevamente
4. Si sigue fallando: Limpia cache (Settings → Storage → Clear Cache)

---

## 📞 Necesito más ayuda

Si nada de esto funciona:

1. **Verifica que tienes**:
   - Apple Watch Series 4 o más nuevo
   - iOS 14 o superior
   - Conexión a internet

2. **Prueba estos pasos**:
   - Reinicia Apple Watch (Settings → General → Shut Down)
   - Reinicia iPhone
   - Desinstala/reinstala Strava o Polar
   - Desconecta y reconecta en Runna.io

3. **Contacta soporte**:
   - En Runna.io: (botón de ayuda)
   - En Strava: support.strava.com
   - En Polar: support.polar.com

---

## ✅ Checklist: Todo listo para Apple Watch

- [ ] Tengo Apple Watch Series 4 o superior
- [ ] Tengo iOS 14 o más nuevo en mi iPhone
- [ ] Instalé Strava (o Polar) en Apple Watch
- [ ] Instalé Strava (o Polar) en iPhone
- [ ] Tengo cuenta en Strava (o Polar)
- [ ] Conecté Strava (o Polar) a Runna.io
- [ ] Hice una prueba: una actividad en el reloj
- [ ] Verificué que aparece en Strava/Polar
- [ ] Hice clic en "Importar" en Runna.io
- [ ] ✅ ¡La actividad aparece en mi mapa!

**Si marcaste todo**: ¡Ya estás listo! 🎉

---

## 🚀 Próximas mejoras planificadas

1. **Sincronización automática** (Sin hacer clic en "Importar")
   - Target: Marzo 2026

2. **Soporte para más wearables**
   - Garmin Watch
   - Fitbit
   - Samsung Galaxy Watch
   - Target: Q2 2026

3. **Notificaciones en tiempo real**
   - Alertas cuando conquistes territorio
   - Target: Marzo 2026

4. **Integración directa con HealthKit** (iOS nativa)
   - Target: Q3 2026

---

**Última actualización**: Febrero 3, 2026  
**Versión**: 1.0  
**¿Preguntas?** Contacta a soporte en Runna.io
