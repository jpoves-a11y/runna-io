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
  // Check treasures schema first
  console.log('=== TREASURE TABLE SCHEMA ===');
  const schema = await q("PRAGMA table_info(treasures)");
  for (const r of schema.rows) {
    console.log(`  Col: ${r[1]?.value} type=${r[2]?.value}`);
  }

  // Active double_area treasures
  console.log('\n=== DOUBLE_AREA TREASURES ===');
  const treasures = await q("SELECT id, power_type, name, lat, lng, active, collected_by, expires_at, zone FROM treasures WHERE power_type = 'double_area' ORDER BY expires_at DESC LIMIT 10");
  for (const r of treasures.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Treasure: id=${vals[0]?.substring(0,8)} name=${vals[2]} lat=${vals[3]} lng=${vals[4]} active=${vals[5]} collected_by=${vals[6]?.substring(0,8)} expires=${vals[7]} zone=${vals[8]}`);
  }
  
  // ALL active treasures right now
  console.log('\n=== ALL ACTIVE/UNCOLLECTED TREASURES ===');
  const activeTr = await q("SELECT id, power_type, name, lat, lng, active, collected_by, expires_at FROM treasures WHERE active = 1 AND collected_by IS NULL ORDER BY expires_at DESC LIMIT 20");
  for (const r of activeTr.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Active: id=${vals[0]?.substring(0,8)} type=${vals[1]} name=${vals[2]} lat=${vals[3]} lng=${vals[4]} expires=${vals[7]}`);
  }

  // ALL conquest metrics (most recent)
  console.log('\n=== ALL RECENT CONQUEST METRICS ===');
  const cm = await q("SELECT id, attacker_id, defender_id, area_stolen, route_id, created_at FROM conquest_metrics ORDER BY created_at DESC LIMIT 15");
  for (const r of cm.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Metric: attacker=${vals[1]?.substring(0,8)} defender=${vals[2]?.substring(0,8)} stolen=${(vals[3]/1e6).toFixed(4)}km2 route=${vals[4]?.substring(0,8)} at=${vals[5]}`);
  }

  // Check the most recent feed events for BOTH users
  console.log('\n=== LATEST FEED EVENTS (ALL USERS, last 15) ===');
  const feed = await q("SELECT id, user_id, event_type, route_id, metadata, created_at FROM feed_events WHERE user_id IN ('42fbe92fbe0f1375b835472b1284e27c', '1daf5dda2d1d970ad8aa3831bce3d0a3') ORDER BY created_at DESC LIMIT 15");
  for (const r of feed.rows) {
    const vals = r.map(v => v?.value);
    const userId = vals[1]?.substring(0,8);
    console.log(`  Feed: user=${userId} type=${vals[2]} route=${vals[3]?.substring(0,8)} at=${vals[5]}`);
    if (vals[4]) {
      try {
        const meta = JSON.parse(vals[4]);
        if (meta.victims?.length > 0) console.log(`    victims: ${JSON.stringify(meta.victims)}`);
        if (meta.treasuresCollected?.length > 0) console.log(`    treasures: ${JSON.stringify(meta.treasuresCollected)}`);
        if (meta.ranTogetherWith?.length > 0) console.log(`    ranTogether: ${JSON.stringify(meta.ranTogetherWith)}`);
        if (meta.areaConquered) console.log(`    areaConquered: ${(meta.areaConquered/1e6).toFixed(4)}km2`);
        if (meta.areaStolen) console.log(`    areaStolen: ${(meta.areaStolen/1e6).toFixed(4)}km2`);
      } catch(e) {}
    }
  }
  
  // Check route 4a2b52aa (javialpoder's latest 14.04km route) for territory data
  console.log('\n=== TERRITORY FOR LATEST ROUTE (4a2b52aa) ===');
  const t1 = await q("SELECT id, user_id, route_id, area, conquered_at FROM territories WHERE route_id LIKE '4a2b52aa%' LIMIT 5");
  for (const r of t1.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Territory: user=${vals[1]?.substring(0,8)} route=${vals[2]?.substring(0,8)} area=${(vals[3]/1e6).toFixed(4)}km2 at=${vals[4]}`);
  }

  // Check active competition
  console.log('\n=== ACTIVE COMPETITION ===');
  const comp = await q("SELECT id, name, status, starts_at, ends_at FROM competitions ORDER BY rowid DESC LIMIT 3");
  for (const r of comp.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Competition: id=${vals[0]?.substring(0,8)} name=${vals[1]} status=${vals[2]} start=${vals[3]} end=${vals[4]}`);
  }

})().catch(e => console.error(e));
