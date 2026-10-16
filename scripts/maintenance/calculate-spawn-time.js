#!/usr/bin/env node

/**
 * Calcula la hora exacta de spawn del cofre para un día y ID de competición
 * Usa el mismo algoritmo que routes.ts línea 6050-6060
 */

function calculateSpawnHour(date, competitionId) {
  // Formato: "2026-03-03"
  const dateStr = date.toISOString().slice(0, 10);
  const seed = dateStr + competitionId;
  
  console.log(`\n📅 Fecha: ${dateStr}`);
  console.log(`🎯 Competición ID: ${competitionId}`);
  console.log(`🔑 Seed para hash: "${seed}"`);
  
  // Algoritmo DJB2 hash (mismo que routes.ts)
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  
  console.log(`#️⃣  Hash calculado: ${hash}`);
  
  // Convertir a hora (0-23)
  const spawnHour = ((hash % 24) + 24) % 24;
  
  console.log(`\n✅ HORA DE SPAWN: ${spawnHour}:00 UTC`);
  
  // Convertir a CET (Zaragoza)
  // UTC+1 en invierno (hasta 30 marzo), UTC+2 en verano
  const isCET = date < new Date('2026-03-29'); // Cambio a CEST el último domingo de marzo
  const cetHour = isCET ? (spawnHour + 1) % 24 : (spawnHour + 2) % 24;
  const timezone = isCET ? 'CET (UTC+1)' : 'CEST (UTC+2)';
  
  console.log(`🕐 Hora local Zaragoza: ${cetHour}:00 ${timezone}`);
  
  return {
    spawnHour,
    cetHour,
    timezone,
    dateStr,
    competitionId
  };
}

// Uso
const today = new Date('2026-03-03T00:00:00Z');

// Ejemplo con un ID de competición
// Puedes reemplazar esto con el ID real
const exampleCompetitionId = 'la-primera-conquista-del-ebro-comp-id';

console.log('\n🗺️  CALCULADORA DE SPAWN DE COFRES - RUNNA.IO');
console.log('═'.repeat(50));

// Si se pasa un argumento, usarlo
const competitionId = process.argv[2] || exampleCompetitionId;

const result = calculateSpawnHour(today, competitionId);

console.log('\n' + '═'.repeat(50));
console.log('💡 Upstash ejecuta POST /api/tasks/spawn-treasure cada hora.');
console.log('   Solo spawneará en la hora exacta calculada.');
console.log('\n📝 Para usar tu ID real, ejecuta:');
console.log(`   node calculate-spawn-time.js "tu-competition-id-aqui"`);
