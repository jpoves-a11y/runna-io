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
  // Check ALL conquest metrics with route_id (from queue processing, not reprocess)
  console.log('=== CONQUEST METRICS WITH ROUTE IDs (queue processed) ===');
  const cm1 = await q("SELECT id, attacker_id, defender_id, area_stolen, route_id, created_at FROM conquest_metrics WHERE route_id IS NOT NULL ORDER BY created_at DESC LIMIT 20");
  console.log(`  Found: ${cm1.rows.length} rows`);
  for (const r of cm1.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  ${vals[1]?.substring(0,8)} -> ${vals[2]?.substring(0,8)} stolen=${(vals[3]/1e6).toFixed(4)}km2 route=${vals[4]?.substring(0,8)} at=${vals[5]}`);
  }

  // Check the territory conquered_at timestamp more carefully
  console.log('\n=== TERRITORY TIMESTAMPS (javialpoder) ===');
  const t1 = await q("SELECT id, route_id, area, conquered_at, LENGTH(geometry) as geom_len FROM territories WHERE user_id = '1daf5dda2d1d970ad8aa3831bce3d0a3'");
  for (const r of t1.rows) {
    const vals = r.map(v => v?.value);
    const ts = Number(vals[3]);
    let dateStr = vals[3];
    if (ts > 1000000000000) dateStr = new Date(ts).toISOString();
    console.log(`  Territory: id=${vals[0]?.substring(0,8)} route=${vals[1]?.substring(0,8)} area=${(vals[2]/1e6).toFixed(4)}km2 conquered=${dateStr} geom_len=${vals[4]}`);
  }

  // Check Juan Girón's territory too
  console.log('\n=== TERRITORY TIMESTAMPS (Juan Girón) ===');
  const t2 = await q("SELECT id, route_id, area, conquered_at, LENGTH(geometry) as geom_len FROM territories WHERE user_id = '42fbe92fbe0f1375b835472b1284e27c'");
  for (const r of t2.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Territory: id=${vals[0]?.substring(0,8)} route=${vals[1]?.substring(0,8)} area=${(vals[2]/1e6).toFixed(4)}km2 conquered=${vals[3]} geom_len=${vals[4]}`);
  }

  // ============ Check if the latest route might have been processed ============
  // Look at the queue processing - check route status
  console.log('\n=== ROUTE 4a2b52aa STATUS ===');
  const r1 = await q("SELECT id, user_id, name, distance, started_at, completed_at, ran_together_with FROM routes WHERE id LIKE '4a2b52aa%'");
  for (const r of r1.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Route: ${vals[0]?.substring(0,8)} name=${vals[2]} dist=${(vals[3]/1000).toFixed(2)}km started=${vals[4]} completed=${vals[5]} ranTogether=${vals[6]}`);
  }

  // Check the latest feed events more carefully
  console.log('\n=== ALL FEED EVENTS FOR JAVIALPODER (last 10) ===');
  const f1 = await q("SELECT id, event_type, route_id, metadata, created_at FROM feed_events WHERE user_id = '1daf5dda2d1d970ad8aa3831bce3d0a3' ORDER BY created_at DESC LIMIT 10");
  for (const r of f1.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Feed: type=${vals[1]} route=${vals[2]?.substring(0,8)} at=${vals[4]}`);
    if (vals[3]) {
      try {
        const meta = JSON.parse(vals[3]);
        console.log(`    meta keys: ${Object.keys(meta).join(', ')}`);
        if (meta.victims?.length) console.log(`    victims: ${JSON.stringify(meta.victims.map(v => v.userName + '=' + (v.stolenArea/1e6).toFixed(4)))}`);
        if (meta.newAreaKm2) console.log(`    newArea: ${meta.newAreaKm2}km2`);
        if (meta.areaConquered) console.log(`    areaConquered: ${(meta.areaConquered/1e6).toFixed(4)}km2`);
        if (meta.treasuresCollected?.length) console.log(`    treasures: ${JSON.stringify(meta.treasuresCollected)}`);
      } catch(e) {}
    }
  }

  // Double check - maybe route processed but under different feed event or user
  console.log('\n=== FEED EVENTS REFERENCING ROUTE 4a2b52aa ===');
  const f2 = await q("SELECT id, user_id, event_type, metadata, created_at FROM feed_events WHERE route_id LIKE '4a2b52aa%' OR metadata LIKE '%4a2b52aa%'");
  console.log(`  Found: ${f2.rows.length} rows`);
  for (const r of f2.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Feed: user=${vals[1]?.substring(0,8)} type=${vals[2]} at=${vals[4]}`);
  }

})().catch(e => console.error(e));
