/**
 * Fix Miguel Rodrigo's latest activity (22.53km):
 * 1. Delete duplicate/stale feed events for route 6922d195
 * 2. Delete the territory created by failed attempts
 * 3. Delete the route
 * 4. Reset the Polar activity to unprocessed
 * After this, deploy the fixed worker and call POST /api/polar/process/:userId
 */
const DB_URL = process.env.TURSO_PIPELINE_URL;
const TOKEN = process.env.TURSO_AUTH_TOKEN;
if (!process.env.TURSO_PIPELINE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('Set TURSO_PIPELINE_URL (https://<db>.turso.io/v3/pipeline) and TURSO_AUTH_TOKEN first.');
  process.exit(1);
}

async function q(sql) {
  const resp = await fetch(DB_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }] }),
  });
  const json = await resp.json();
  if (json.results[0].type === 'error') throw new Error(json.results[0].error.message);
  return json.results[0].response.result;
}

(async () => {
  const userId = '4c49ab03c695883f3caa852b6227e23b';
  const routeId = '6922d195fc2448bd49007c5e35178042';
  
  console.log('=== FIXING MIGUEL RODRIGO 22.53km ACTIVITY ===\n');

  // 1. Check current feed events for this route
  console.log('--- Feed events for route 6922d195 ---');
  const feeds = await q(`SELECT id, distance, new_area, metadata, created_at FROM feed_events WHERE route_id = '${routeId}'`);
  console.log(`Found ${feeds.rows.length} feed events (should be 1)`);
  for (const r of feeds.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Feed ${vals[0]?.substring(0,8)} | dist=${vals[1]} | area=${vals[2]} | meta=${(vals[3] || 'null').substring(0,60)} | created=${vals[4]}`);
  }

  // 2. Check territory for this route
  console.log('\n--- Territories for route 6922d195 ---');
  const terrs = await q(`SELECT id, area, conquered_at FROM territories WHERE route_id = '${routeId}'`);
  console.log(`Found ${terrs.rows.length} territories`);
  for (const r of terrs.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Territory ${vals[0]?.substring(0,8)} | area=${(vals[1]/1e6).toFixed(4)}km² | conquered=${vals[2]}`);
  }

  // 3. Check all territories for this user
  console.log('\n--- All territories for Miguel ---');
  const allTerrs = await q(`SELECT id, area, route_id, conquered_at FROM territories WHERE user_id = '${userId}'`);
  console.log(`Found ${allTerrs.rows.length} total territories`);
  for (const r of allTerrs.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Territory ${vals[0]?.substring(0,8)} | area=${(vals[1]/1e6).toFixed(4)}km² | route=${vals[2]?.substring(0,8)} | conquered=${vals[3]}`);
  }

  // 4. Check Polar activity state
  console.log('\n--- Polar activity e1c057c5 ---');
  const polar = await q(`SELECT id, processed, route_id, processed_at FROM polar_activities WHERE id = 'e1c057c595cd27780b806dcf5d348253'`);
  if (polar.rows.length > 0) {
    const vals = polar.rows[0].map(v => v?.value);
    console.log(`  processed=${vals[1]} | routeId=${vals[2]} | processedAt=${vals[3]}`);
  }

  // 5. CLEANUP: Delete all feed events for this route
  if (feeds.rows.length > 0) {
    console.log(`\n🗑️ Deleting ${feeds.rows.length} feed events...`);
    await q(`DELETE FROM feed_comments WHERE feed_event_id IN (SELECT id FROM feed_events WHERE route_id = '${routeId}')`);
    await q(`DELETE FROM feed_events WHERE route_id = '${routeId}'`);
    console.log('  ✅ Feed events deleted');
  }

  // 6. CLEANUP: Delete territory for this route
  if (terrs.rows.length > 0) {
    console.log(`🗑️ Deleting ${terrs.rows.length} territory(ies) for this route...`);
    await q(`DELETE FROM territories WHERE route_id = '${routeId}'`);
    console.log('  ✅ Territory deleted');
  }

  // 7. Delete the route itself
  console.log('🗑️ Deleting route 6922d195...');
  await q(`DELETE FROM routes WHERE id = '${routeId}'`);
  console.log('  ✅ Route deleted');

  // 8. Reset Polar activity
  console.log('🔄 Resetting Polar activity to unprocessed...');
  await q(`UPDATE polar_activities SET processed = 0, processed_at = NULL, route_id = NULL WHERE id = 'e1c057c595cd27780b806dcf5d348253'`);
  console.log('  ✅ Reset done');

  // 9. Also check if territories from OTHER users overlap with Miguel's area (victims who weren't subtracted)
  console.log('\n--- Check: Do victims have unsubtracted territory? ---');
  // We know Miguel's latest route was in the Zaragoza area. Check recent victim territories.
  const feed14km = await q(`SELECT metadata FROM feed_events WHERE route_id = '4a2b52aa0ad6b215fca691cb19ab0e28'`);
  if (feed14km.rows.length > 0 && feed14km.rows[0][0]?.value) {
    console.log('  Previous 14km run had metadata:', feed14km.rows[0][0].value.substring(0, 200));
  }

  console.log('\n✅ CLEANUP COMPLETE!');
  console.log(`\n⚡ Deploy the fixed worker, then call:`);
  console.log(`   POST /api/polar/process/${userId}`);
})().catch(e => console.error(e));
