# Script de prueba para endpoints del sistema de amigos
# Ejecutar: .\test-friends-api.ps1

$baseUrl = "https://runna-io-api.runna-io-api.workers.dev"
$headers = @{
    "Content-Type" = "application/json"
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "PRUEBA DE ENDPOINTS - SISTEMA DE AMIGOS" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# 1. Obtener leaderboard para ver usuarios disponibles
Write-Host "1. Obteniendo lista de usuarios (leaderboard)..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/leaderboard" -Method Get -Headers $headers
    Write-Host "✓ Usuarios encontrados: $($response.Length)" -ForegroundColor Green
    
    if ($response.Length -ge 2) {
        $user1 = $response[0]
        $user2 = $response[1]
        Write-Host "  - Usuario 1: $($user1.username) (ID: $($user1.id))" -ForegroundColor Gray
        Write-Host "  - Usuario 2: $($user2.username) (ID: $($user2.id))" -ForegroundColor Gray
    } else {
        Write-Host "✗ Se necesitan al menos 2 usuarios para probar" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "✗ Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""

# 2. Buscar usuarios
Write-Host "2. Probando búsqueda de usuarios..." -ForegroundColor Yellow
try {
    $searchQuery = $user2.username.Substring(0, 3)
    $searchUrl = $baseUrl + "/api/users/search?query=" + $searchQuery + "`&userId=" + $user1.id
    $response = Invoke-RestMethod -Uri $searchUrl -Method Get -Headers $headers
    Write-Host "✓ Búsqueda exitosa. Usuarios encontrados: $($response.Length)" -ForegroundColor Green
    $response | ForEach-Object { Write-Host "  - $($_.username) ($($_.name))" -ForegroundColor Gray }
} catch {
    Write-Host "✗ Error: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""

# 3. Crear amistad bidireccional
Write-Host "3. Creando amistad entre $($user1.username) y $($user2.username)..." -ForegroundColor Yellow
try {
    $body = @{
        userId = $user1.id
        friendId = $user2.id
    } | ConvertTo-Json

    $response = Invoke-RestMethod -Uri "$baseUrl/api/friends" -Method Post -Headers $headers -Body $body
    Write-Host "✓ Amistad creada exitosamente" -ForegroundColor Green
    Write-Host "  Response: $($response | ConvertTo-Json -Compress)" -ForegroundColor Gray
} catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 400) {
        Write-Host "⚠ Amistad ya existe (esperado si se ejecutó antes)" -ForegroundColor Yellow
    } else {
        Write-Host "✗ Error: $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ""

# 4. Obtener lista de amigos
Write-Host "4. Obteniendo amigos de $($user1.username)..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/friends/$($user1.id)" -Method Get -Headers $headers
    Write-Host "✓ Amigos encontrados: $($response.Length)" -ForegroundColor Green
    $response | ForEach-Object { 
        Write-Host "  - $($_.username) (Área: $($_.totalArea) m²)" -ForegroundColor Gray 
    }
} catch {
    Write-Host "✗ Error: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""

# 5. Obtener leaderboard solo de amigos
Write-Host "5. Obteniendo ranking entre amigos de $($user1.username)..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/leaderboard/friends/$($user1.id)" -Method Get -Headers $headers
    Write-Host "✓ Ranking de amigos obtenido: $($response.Length) amigos" -ForegroundColor Green
    $response | ForEach-Object { 
        Write-Host "  #$($_.rank) - $($_.username) ($($_.totalArea) m²)" -ForegroundColor Gray 
    }
} catch {
    Write-Host "✗ Error: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""

# 6. Obtener territorios solo de amigos
Write-Host "6. Obteniendo territorios de amigos..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/territories/friends/$($user1.id)" -Method Get -Headers $headers
    Write-Host "✓ Territorios de amigos: $($response.Length)" -ForegroundColor Green
    if ($response.Length -gt 0) {
        Write-Host "  Ejemplo: Usuario $($response[0].user.username) tiene territorio de $($response[0].area) m²" -ForegroundColor Gray
    }
} catch {
    Write-Host "✗ Error: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""

# 7. Crear invitación de amistad
Write-Host "7. Creando link de invitación..." -ForegroundColor Yellow
try {
    $body = @{
        userId = $user1.id
    } | ConvertTo-Json

    $response = Invoke-RestMethod -Uri "$baseUrl/api/friends/invite" -Method Post -Headers $headers -Body $body
    Write-Host "✓ Invitación creada exitosamente" -ForegroundColor Green
    Write-Host "  Token: $($response.token)" -ForegroundColor Gray
    Write-Host "  URL: $($response.url)" -ForegroundColor Cyan
    
    $inviteToken = $response.token
} catch {
    Write-Host "✗ Error: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""

# 8. Simular aceptación de invitación (con tercer usuario si existe)
if ($response.Length -ge 3) {
    $user3 = $response[2]
    Write-Host "8. Simulando aceptación de invitación por $($user3.username)..." -ForegroundColor Yellow
    try {
        $body = @{
            userId = $user3.id
        } | ConvertTo-Json

        $acceptResponse = Invoke-RestMethod -Uri "$baseUrl/api/friends/accept/$inviteToken" -Method Post -Headers $headers -Body $body
        Write-Host "✓ Invitación aceptada exitosamente" -ForegroundColor Green
        Write-Host "  Nuevo amigo: $($acceptResponse.friendId)" -ForegroundColor Gray
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 400) {
            Write-Host "⚠ Error esperado (mismo usuario o invitación expirada)" -ForegroundColor Yellow
        } else {
            Write-Host "✗ Error: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
} else {
    Write-Host "8. Omitiendo prueba de aceptación (se necesitan al menos 3 usuarios)" -ForegroundColor Yellow
}

Write-Host ""

# 9. Eliminar amistad
Write-Host "9. Eliminando amistad entre $($user1.username) y $($user2.username)..." -ForegroundColor Yellow
$confirmDelete = Read-Host "¿Deseas eliminar la amistad creada? (s/n)"
if ($confirmDelete -eq "s") {
    try {
        $body = @{
            userId = $user1.id
        } | ConvertTo-Json

        $response = Invoke-RestMethod -Uri "$baseUrl/api/friends/$($user2.id)" -Method Delete -Headers $headers -Body $body
        Write-Host "✓ Amistad eliminada exitosamente" -ForegroundColor Green
    } catch {
        Write-Host "✗ Error: $($_.Exception.Message)" -ForegroundColor Red
    }
} else {
    Write-Host "⚠ Amistad mantenida" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "PRUEBAS COMPLETADAS" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
