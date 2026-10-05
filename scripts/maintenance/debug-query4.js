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
  // All territories for ALL users in the friend group
  console.log('=== ALL TERRITORIES (all users) ===');
  const terrs = await q("SELECT id, user_id, route_id, area, conquered_at FROM territories WHERE user_id IN ('42fbe92fbe0f1375b835472b1284e27c', '1daf5dda2d1d970ad8aa3831bce3d0a3', '3d87f41228367efd69653ae3daf8587d', 'ebac909d00d9c4d8457b6eaecf9e4125', '4c49ab03c695883f3caa852b6227e23b', 'a91eb408430e6fd8d7a6d3f37d844041', '0a06649baf21eee0757662f2e938ff2d') ORDER BY conquered_at DESC");
  for (const r of terrs.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Territory: id=${vals[0]?.substring(0,8)} user=${vals[1]?.substring(0,8)} route=${vals[2]?.substring(0,8) || 'null'} area=${(vals[3]/1e6).toFixed(4)}km2 at=${vals[4]}`);
  }

  // All user areas
  console.log('\n=== USER AREAS ===');
  const users = await q("SELECT id, username, name, total_area FROM users WHERE id IN ('42fbe92fbe0f1375b835472b1284e27c', '1daf5dda2d1d970ad8aa3831bce3d0a3', '3d87f41228367efd69653ae3daf8587d', 'ebac909d00d9c4d8457b6eaecf9e4125', '4c49ab03c695883f3caa852b6227e23b')");
  for (const r of users.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  ${vals[2]} (${vals[1]}): ${(vals[3]/1e6).toFixed(4)} km2`);
  }

  // Check all feed events in the last few hours
  console.log('\n=== VERY RECENT FEED EVENTS (last 10 for all users) ===');
  const feed = await q("SELECT id, user_id, event_type, route_id, metadata, created_at FROM feed_events ORDER BY created_at DESC LIMIT 10");
  for (const r of feed.rows) {
    const vals = r.map(v => v?.value);
    console.log(`\n  Feed: user=${vals[1]?.substring(0,8)} type=${vals[2]} route=${vals[3]?.substring(0,8)} at=${vals[5]}`);
    if (vals[4]) {
      try {
        const meta = JSON.parse(vals[4]);
        if (meta.victims?.length > 0) {
          for (const v of meta.victims) {
            console.log(`    STOLE ${(v.stolenArea/1e6).toFixed(4)}km2 from ${v.userName}`);
          }
        }
        if (meta.areaConquered) console.log(`    areaConquered: ${(meta.areaConquered/1e6).toFixed(4)}km2`);
        if (meta.treasuresCollected?.length > 0) console.log(`    treasures: ${JSON.stringify(meta.treasuresCollected)}`);
        if (meta.ranTogetherWith?.length > 0) console.log(`    ranTogether: ${JSON.stringify(meta.ranTogetherWith)}`);
      } catch(e) {}
    }
  }

  // Check if there are territories for the latest route that were added after reprocess
  console.log('\n=== TERRITORIES WITH conquered_at > reprocess time (1773250278) ===');
  const newterrs = await q("SELECT id, user_id, route_id, area, conquered_at FROM territories WHERE conquered_at > '1773250280000' ORDER BY conquered_at DESC LIMIT 10");
  console.log(`  Found: ${newterrs.rows.length} rows`);
  for (const r of newterrs.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Territory: id=${vals[0]?.substring(0,8)} user=${vals[1]?.substring(0,8)} route=${vals[2]?.substring(0,8)} area=${(vals[3]/1e6).toFixed(4)}km2 at=${vals[4]}`);
  }

  // Check territory count per user
  console.log('\n=== TERRITORY COUNT PER USER ===');
  const counts = await q("SELECT user_id, COUNT(*), SUM(area) FROM territories WHERE user_id IN ('42fbe92fbe0f1375b835472b1284e27c', '1daf5dda2d1d970ad8aa3831bce3d0a3') GROUP BY user_id");
  for (const r of counts.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  User ${vals[0]?.substring(0,8)}: ${vals[1]} territories, total area=${(vals[2]/1e6).toFixed(4)}km2`);
  }

})().catch(e => console.error(e));
