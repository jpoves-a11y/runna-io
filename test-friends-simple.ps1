# Script simplificado de prueba - Sistema de Amigos
$baseUrl = "https://runna-io-api.runna-io-api.workers.dev"

Write-Host ""
Write-Host "========== PRUEBA DE ENDPOINTS - SISTEMA DE AMIGOS ==========" -ForegroundColor Cyan
Write-Host ""

# 1. Obtener usuarios
Write-Host "1. Obteniendo lista de usuarios..." -ForegroundColor Yellow
$users = Invoke-RestMethod -Uri "$baseUrl/api/leaderboard" -Method Get
Write-Host "OK Usuarios: $($users.Length)" -ForegroundColor Green

if ($users.Length -lt 2) {
    Write-Host "ERROR Se necesitan al menos 2 usuarios" -ForegroundColor Red
    exit
}

$user1 = $users[0]
$user2 = $users[1]
Write-Host "  User 1: $($user1.username) (ID: $($user1.id))" -ForegroundColor Gray
Write-Host "  User 2: $($user2.username) (ID: $($user2.id))" -ForegroundColor Gray
Write-Host ""

# 2. Buscar usuarios
Write-Host "2. Buscando usuarios..." -ForegroundColor Yellow
$query = $user2.username.Substring(0,2)
$searchUrl = "$baseUrl/api/users/search?query=$query" + ([char]38) + "userId=$($user1.id)"
$searchResults = Invoke-RestMethod -Uri $searchUrl -Method Get
Write-Host "OK Resultados: $($searchResults.Length)" -ForegroundColor Green
Write-Host ""

# 3. Crear amistad
Write-Host "3. Creando amistad..." -ForegroundColor Yellow
try {
    $body = @{ userId = $user1.id; friendId = $user2.id } | ConvertTo-Json
    $friendResult = Invoke-RestMethod -Uri "$baseUrl/api/friends" -Method Post -Body $body -ContentType "application/json"
    Write-Host "OK Amistad creada" -ForegroundColor Green
} catch {
    Write-Host "ADVERTENCIA Error (puede ser que ya exista): $($_.Exception.Message)" -ForegroundColor Yellow
}
Write-Host ""

# 4. Obtener amigos
Write-Host "4. Obteniendo lista de amigos..." -ForegroundColor Yellow
$friends = Invoke-RestMethod -Uri "$baseUrl/api/friends/$($user1.id)" -Method Get
Write-Host "OK Amigos: $($friends.Length)" -ForegroundColor Green
$friends | ForEach-Object { Write-Host "  - $($_.username)" -ForegroundColor Gray }
Write-Host ""

# 5. Leaderboard de amigos
Write-Host "5. Obteniendo ranking de amigos..." -ForegroundColor Yellow
$friendLeaderboard = Invoke-RestMethod -Uri "$baseUrl/api/leaderboard/friends/$($user1.id)" -Method Get
Write-Host "OK Amigos en ranking: $($friendLeaderboard.Length)" -ForegroundColor Green
$friendLeaderboard | ForEach-Object { Write-Host "  #$($_.rank) - $($_.username) ($($_.totalArea) m²)" -ForegroundColor Gray }
Write-Host ""

# 6. Territorios de amigos
Write-Host "6. Obteniendo territorios de amigos..." -ForegroundColor Yellow
$friendTerritories = Invoke-RestMethod -Uri "$baseUrl/api/territories/friends/$($user1.id)" -Method Get
Write-Host "OK Territorios: $($friendTerritories.Length)" -ForegroundColor Green
Write-Host ""

# 7. Crear invitación
Write-Host "7. Creando link de invitación..." -ForegroundColor Yellow
$body = @{ userId = $user1.id } | ConvertTo-Json
$invite = Invoke-RestMethod -Uri "$baseUrl/api/friends/invite" -Method Post -Body $body -ContentType "application/json"
Write-Host "OK Token: $($invite.token)" -ForegroundColor Green
Write-Host "  URL: $($invite.url)" -ForegroundColor Cyan
Write-Host ""

# 8. Eliminar amistad (opcional)
Write-Host "8. Eliminar amistad creada? (s/n)" -ForegroundColor Yellow -NoNewline
$confirm = Read-Host " "
if ($confirm -eq "s") {
    $body = @{ userId = $user1.id } | ConvertTo-Json
    Invoke-RestMethod -Uri "$baseUrl/api/friends/$($user2.id)" -Method Delete -Body $body -ContentType "application/json"
    Write-Host "OK Amistad eliminada" -ForegroundColor Green
} else {
    Write-Host "OK Amistad mantenida" -ForegroundColor Green
}
Write-Host ""

Write-Host "========== PRUEBAS COMPLETADAS ==========" -ForegroundColor Cyan
Write-Host ""
