# Script para forzar el reimporte SEGURO de actividades de Polar desde Turso
# Proceso en 4 fases: diagnose → reset → cleanup → process
# Respeta lógica de territorio, evita duplicados, maneja "corrieron juntos"

$WORKER_URL = "https://runna-io-api.runna-io-api.workers.dev"

function Call-API($phase) {
    return Invoke-RestMethod -Uri "$WORKER_URL/api/admin/reimport-polar-activities?phase=$phase" -Method Post -ContentType "application/json"
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " REIMPORTE SEGURO DE ACTIVIDADES POLAR" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ===== FASE 1: DIAGNOSTICO =====
Write-Host "[FASE 1/5] DIAGNOSTICO - Analizando estado actual..." -ForegroundColor Yellow
Start-Sleep -Seconds 1
try {
    $diag = Call-API "diagnose"
    Write-Host ""
    foreach ($u in $diag.diagnostics) {
        Write-Host "  Usuario: $($u.userName)" -ForegroundColor White
        Write-Host "    Actividades Polar: $($u.polarActivities.total) ($($u.polarActivities.unprocessed) sin procesar, $($u.polarActivities.withRoute) con ruta)" -ForegroundColor Gray
        Write-Host "    Rutas: $($u.routes) | Territorios: $($u.territories)" -ForegroundColor Gray
    }
    Write-Host ""
} catch {
    Write-Host "Error en diagnostico: $_" -ForegroundColor Red
    exit 1
}

# Preguntar al usuario si quiere continuar
$confirm = Read-Host "Quieres continuar con el RESET (borrara rutas y territorios para reimportar)? (s/n)"
if ($confirm -ne "s") {
    Write-Host "Abortado por el usuario." -ForegroundColor Yellow
    exit 0
}

# ===== FASE 2: RESET =====
Write-Host ""
Write-Host "[FASE 2/5] RESET - Reseteando actividades y limpiando rutas/territorios..." -ForegroundColor Yellow
Start-Sleep -Seconds 2
try {
    $reset = Call-API "reset"
    foreach ($u in $reset.results) {
        Write-Host "  $($u.userName): $($u.activitiesReset) actividades reseteadas" -ForegroundColor Green
    }
    Write-Host ""
} catch {
    Write-Host "Error en reset: $_" -ForegroundColor Red
    exit 1
}

Start-Sleep -Seconds 3

# ===== FASE 3: CLEANUP =====
Write-Host "[FASE 3/5] CLEANUP - Eliminando duplicados y datos huerfanos..." -ForegroundColor Yellow
Start-Sleep -Seconds 2
try {
    $cleanup = Call-API "cleanup"
    foreach ($u in $cleanup.results) {
        Write-Host "  $($u.userName): $($u.orphanedRoutesDeleted) rutas huerfanas eliminadas, $($u.activitiesReset) actividades reseteadas" -ForegroundColor Green
    }
    Write-Host ""
} catch {
    Write-Host "Error en cleanup: $_" -ForegroundColor Red
    # No fatal, continuamos
}

Start-Sleep -Seconds 3

# ===== FASE 4: PROCESS (una actividad a la vez) =====
Write-Host "[FASE 4/5] PROCESS - Procesando actividades una a una..." -ForegroundColor Yellow
Write-Host ""

$processedCount = 0
$errorCount = 0
$maxAttempts = 60
$attempt = 0

do {
    $attempt++
    
    try {
        $result = Call-API "process"
        
        if ($result.action -eq "all_done") {
            Write-Host ""
            Write-Host "  Todas las actividades procesadas!" -ForegroundColor Green
            break
        }
        
        $icon = switch ($result.action) {
            "processed" { "+" }
            "skipped_no_gps" { "~" }
            "skipped_bad_date" { "~" }  
            "skipped_few_coords" { "~" }
            default { "?" }
        }
        
        $routeInfo = if ($result.routeAction -eq "reused_existing") { " [reutilizada]" } else { "" }
        $territoryInfo = ""
        if ($result.territory -and -not $result.territory.error) {
            $areaKm2 = [math]::Round($result.territory.totalArea / 1000000, 4)
            $stolenKm2 = [math]::Round($result.territory.stolenArea / 1000000, 4)
            $ran = if ($result.territory.ranTogetherWith.Count -gt 0) { " | corrieron juntos: $($result.territory.ranTogetherWith -join ', ')" } else { "" }
            $territoryInfo = " | area: ${areaKm2}km2, robado: ${stolenKm2}km2${ran}"
        }
        
        Write-Host "  [$icon] $($result.user): $($result.activity.name)${routeInfo}${territoryInfo} ($($result.remaining) restantes)" -ForegroundColor $(if ($result.action -eq "processed") { "Green" } else { "DarkGray" })
        
        $processedCount++
        Start-Sleep -Milliseconds 800
        
    } catch {
        $errorCount++
        $errorMsg = $_.Exception.Message
        
        if ($errorMsg -match "1102|429") {
            Write-Host "  [!] Rate limit - esperando 15s..." -ForegroundColor Yellow
            Start-Sleep -Seconds 15
        } else {
            Write-Host "  [X] Error: $errorMsg" -ForegroundColor Red
            Start-Sleep -Seconds 3
        }
        
        if ($errorCount -gt 10) {
            Write-Host ""
            Write-Host "Demasiados errores seguidos. Parando." -ForegroundColor Red
            break
        }
    }
    
} while ($attempt -lt $maxAttempts)

Write-Host ""
Write-Host "Procesamiento completado: $processedCount actividades en $attempt intentos" -ForegroundColor Cyan

# ===== FASE 5: DIAGNOSTICO FINAL =====
Write-Host ""
Write-Host "[FASE 5/5] DIAGNOSTICO FINAL..." -ForegroundColor Yellow
Start-Sleep -Seconds 3
try {
    $finalDiag = Call-API "diagnose"
    Write-Host ""
    foreach ($u in $finalDiag.diagnostics) {
        $status = if ($u.polarActivities.unprocessed -eq 0) { "OK" } else { "PENDIENTE" }
        Write-Host "  [$status] $($u.userName): $($u.polarActivities.total) actividades, $($u.routes) rutas, $($u.territories) territorios ($($u.polarActivities.unprocessed) sin procesar)" -ForegroundColor $(if ($status -eq "OK") { "Green" } else { "Yellow" })
    }
} catch {
    Write-Host "Error en diagnostico final: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " REIMPORTE COMPLETADO" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Si hay actividades pendientes, ejecuta de nuevo este script." -ForegroundColor Yellow
Write-Host "Si los territorios no se ven correctos, ejecuta:" -ForegroundColor Yellow
Write-Host '  Invoke-RestMethod -Uri "$WORKER_URL/api/admin/reimport-polar-activities?phase=reprocess" -Method Post' -ForegroundColor DarkGray
