# Push Notifications Setup

## 1. Generar VAPID Keys

Ejecuta:
```bash
npm install web-push --save-dev
npx web-push generate-vapid-keys
```

Esto generará:
```
Public Key: BLx...
Private Key: 7Q3...
```

## 2. Configurar las keys

### Frontend
Edita `client/src/lib/pushNotifications.ts` línea 4:
```typescript
const VAPID_PUBLIC_KEY = 'TU_PUBLIC_KEY_AQUI';
```

### Backend (Cloudflare Worker)
Agrega secrets al worker:
```bash
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

Para VAPID_SUBJECT usa: `mailto:tu@email.com` o `https://runna.io`

## 3. Migración SQL

Ejecuta en Neon:
```sql
CREATE TABLE push_subscriptions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

## 4. Deploy

```bash
npm run worker:deploy
npm run pages:build
npm run pages:deploy
```

## 5. Prueba

1. Abre la app en tu móvil
2. Ve a Perfil
3. Activa "Notificaciones"
4. Dale permiso al navegador
5. Haz que un amigo conquiste tu territorio
6. Deberías recibir una notificación instantánea 🔔
