-- ========================================
-- SQL PARA EJECUTAR EN NEON SQL EDITOR
-- Sistema de Amigos Bidireccional
-- ========================================

-- 1. Crear tabla para invitaciones de amigos
CREATE TABLE IF NOT EXISTS friend_invites (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    CONSTRAINT fk_user_id_friend_invites FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 2. Crear índices para optimizar búsquedas
CREATE INDEX IF NOT EXISTS idx_friend_invites_token ON friend_invites(token);
CREATE INDEX IF NOT EXISTS idx_friend_invites_user_id ON friend_invites(user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_user_id ON friendships(user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_friend_id ON friendships(friend_id);

-- 3. Agregar constraint único para evitar amistades duplicadas
ALTER TABLE friendships 
ADD CONSTRAINT IF NOT EXISTS unique_friendship UNIQUE (user_id, friend_id);

-- 4. Función helper para crear amistad bidireccional
CREATE OR REPLACE FUNCTION create_bidirectional_friendship(
    p_user_id VARCHAR,
    p_friend_id VARCHAR
)
RETURNS VOID AS $$
BEGIN
    -- Insertar A -> B
    INSERT INTO friendships (id, user_id, friend_id, created_at)
    VALUES (gen_random_uuid()::TEXT, p_user_id, p_friend_id, NOW())
    ON CONFLICT DO NOTHING;
    
    -- Insertar B -> A
    INSERT INTO friendships (id, user_id, friend_id, created_at)
    VALUES (gen_random_uuid()::TEXT, p_friend_id, p_user_id, NOW())
    ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- 5. Función para eliminar amistad bidireccional
CREATE OR REPLACE FUNCTION delete_bidirectional_friendship(
    p_user_id VARCHAR,
    p_friend_id VARCHAR
)
RETURNS VOID AS $$
BEGIN
    -- Eliminar A -> B
    DELETE FROM friendships 
    WHERE user_id = p_user_id AND friend_id = p_friend_id;
    
    -- Eliminar B -> A
    DELETE FROM friendships 
    WHERE user_id = p_friend_id AND friend_id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- 6. Query para limpiar tokens de invitación expirados (ejecutar periódicamente o vía cron)
DELETE FROM friend_invites WHERE expires_at < NOW();

-- ========================================
-- VERIFICACIÓN
-- ========================================

-- Ver todas las tablas relacionadas con amigos
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('friendships', 'friend_invites');

-- Ver estructura de friendships
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'friendships';

-- Ver estructura de friend_invites
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'friend_invites';
