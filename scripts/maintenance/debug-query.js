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
  // Get users
  const users = await q("SELECT id, username, name, total_area FROM users WHERE id IN ('42fbe92fbe0f1375b835472b1284e27c', '1daf5dda2d1d970ad8aa3831bce3d0a3')");
  console.log('=== USERS ===');
  for (const r of users.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  ID: ${vals[0]}, username: ${vals[1]}, name: ${vals[2]}, area: ${vals[3]}`);
  }

  // Recent routes for javialpoder (Pufalo)
  console.log('\n=== RECENT ROUTES (javialpoder / Pufalo) ===');
  const r1 = await q("SELECT id, user_id, started_at, completed_at, distance, name FROM routes WHERE user_id = '1daf5dda2d1d970ad8aa3831bce3d0a3' ORDER BY completed_at DESC LIMIT 5");
  for (const r of r1.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Route: ${vals[0]?.substring(0,8)}.. name=${vals[5]} dist=${(vals[4]/1000).toFixed(2)}km started=${vals[2]} completed=${vals[3]}`);
  }

  // Recent routes for juan giron
  console.log('\n=== RECENT ROUTES (Juan Girón) ===');
  const r2 = await q("SELECT id, user_id, started_at, completed_at, distance, name FROM routes WHERE user_id = '42fbe92fbe0f1375b835472b1284e27c' ORDER BY completed_at DESC LIMIT 5");
  for (const r of r2.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Route: ${vals[0]?.substring(0,8)}.. name=${vals[5]} dist=${(vals[4]/1000).toFixed(2)}km started=${vals[2]} completed=${vals[3]}`);
  }

  // Check conquest metrics between these two
  console.log('\n=== RECENT CONQUEST METRICS (between them) ===');
  const cm = await q("SELECT id, attacker_id, defender_id, area_stolen, route_id, created_at FROM conquest_metrics WHERE (attacker_id = '1daf5dda2d1d970ad8aa3831bce3d0a3' AND defender_id = '42fbe92fbe0f1375b835472b1284e27c') OR (attacker_id = '42fbe92fbe0f1375b835472b1284e27c' AND defender_id = '1daf5dda2d1d970ad8aa3831bce3d0a3') ORDER BY created_at DESC LIMIT 10");
  for (const r of cm.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Metric: attacker=${vals[1]?.substring(0,8)} defender=${vals[2]?.substring(0,8)} stolen=${(vals[3]/1e6).toFixed(4)}km2 route=${vals[4]?.substring(0,8)} at=${vals[5]}`);
  }

  // Check feed events related to territory stealing
  console.log('\n=== RECENT FEED EVENTS (javialpoder) ===');
  const feed = await q("SELECT id, user_id, event_type, metadata, created_at FROM feed_events WHERE user_id = '1daf5dda2d1d970ad8aa3831bce3d0a3' ORDER BY created_at DESC LIMIT 5");
  for (const r of feed.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Feed: ${vals[2]} at=${vals[4]}`);
    if (vals[3]) {
      try {
        const meta = JSON.parse(vals[3]);
        console.log(`    metadata: victims=${JSON.stringify(meta.victims)}, treasures=${JSON.stringify(meta.treasuresCollected)}, ranTogether=${JSON.stringify(meta.ranTogetherWith)}`);
      } catch(e) {}
    }
  }

  // Check active treasures
  console.log('\n=== ACTIVE TREASURES (doble conquista) ===');
  const treasures = await q("SELECT id, power_type, name, lat, lng, active, collected_by, expires_at FROM treasures WHERE power_type = 'double_area' ORDER BY created_at DESC LIMIT 10");
  for (const r of treasures.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Treasure: ${vals[2]} type=${vals[1]} lat=${vals[3]} lng=${vals[4]} active=${vals[5]} collected_by=${vals[6]} expires=${vals[7]}`);
  }

  // Check if javialpoder has any active powers
  console.log('\n=== ACTIVE POWERS (javialpoder) ===');
  const powers = await q("SELECT id, user_id, power_type, status, treasure_id FROM user_powers WHERE user_id = '1daf5dda2d1d970ad8aa3831bce3d0a3' ORDER BY rowid DESC LIMIT 10");
  for (const r of powers.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Power: type=${vals[2]} status=${vals[3]} treasure=${vals[4]}`);
  }

  // Check territories - last modified
  console.log('\n=== TERRITORIES ===');
  const terrs = await q("SELECT id, user_id, area, conquered_at FROM territories WHERE user_id IN ('42fbe92fbe0f1375b835472b1284e27c', '1daf5dda2d1d970ad8aa3831bce3d0a3') ORDER BY conquered_at DESC LIMIT 10");
  for (const r of terrs.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Territory: user=${vals[1]?.substring(0,8)} area=${(vals[2]/1e6).toFixed(4)}km2 conquered=${vals[3]}`);
  }

})().catch(e => console.error(e));
