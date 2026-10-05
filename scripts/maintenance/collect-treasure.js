const DB_URL = process.env.TURSO_PIPELINE_URL;
const TOKEN = process.env.TURSO_AUTH_TOKEN;
if (!process.env.TURSO_PIPELINE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('Set TURSO_PIPELINE_URL (https://<db>.turso.io/v3/pipeline) and TURSO_AUTH_TOKEN first.');
  process.exit(1);
}
import * as turf from '@turf/turf';
import { randomUUID } from 'crypto';

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
  // Find the Ojo del Halcón treasure that should be collected
  console.log('=== FINDING COLLECTABLE TREASURE ===');
  const treasures = await q("SELECT id, power_type, name, lat, lng, competition_id FROM treasures WHERE active = 1 AND collected_by IS NULL");
  
  // Get the route coordinates
  const routeData = await q("SELECT coordinates FROM routes WHERE id LIKE '4a2b52aa%'");
  const coords = JSON.parse(routeData.rows[0][1]?.value || routeData.rows[0][0]?.value || '[]');
  
  let collectedTreasure = null;
  for (const tr of treasures.rows) {
    const tid = tr[0].value;
    const ptype = tr[1].value;
    const tname = tr[2].value;
    const tlat = tr[3].value;
    const tlng = tr[4].value;
    const compId = tr[5].value;
    
    let minDist = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const dist = turf.distance(
        turf.point([coords[i][1], coords[i][0]]),
        turf.point([tlng, tlat]),
        { units: 'meters' }
      );
      if (dist < minDist) minDist = dist;
    }
    
    if (minDist <= 100) {
      console.log(`  ✅ COLLECTING: ${tname} (${ptype}) - dist ${minDist.toFixed(0)}m - treasure ID: ${tid}`);
      collectedTreasure = { id: tid, type: ptype, name: tname, compId };
      
      // Collect the treasure
      const now = new Date().toISOString();
      const userId = '1daf5dda2d1d970ad8aa3831bce3d0a3'; // javialpoder
      await q(`UPDATE treasures SET collected_by = '${userId}', collected_at = '${now}', active = 0 WHERE id = '${tid}' AND collected_by IS NULL`);
      
      // Create user power
      const powerId = randomUUID().replace(/-/g, '');
      await q(`INSERT INTO user_powers (id, user_id, competition_id, power_type, treasure_id, status) VALUES ('${powerId}', '${userId}', '${compId}', '${ptype}', '${tid}', 'available')`);
      
      console.log(`  ✅ Power created: ${ptype} (power ID: ${powerId})`);
    } else {
      console.log(`  ❌ ${tname} (${ptype}): ${minDist.toFixed(0)}m (too far)`);
    }
  }

  // Now update the feed event for route 4a2b52aa with treasure info
  if (collectedTreasure) {
    console.log('\n=== UPDATING FEED EVENT WITH TREASURE ===');
    const feedResult = await q("SELECT id, metadata FROM feed_events WHERE route_id LIKE '4a2b52aa%'");
    if (feedResult.rows.length > 0) {
      const feedId = feedResult.rows[0][0].value;
      const existingMeta = JSON.parse(feedResult.rows[0][1]?.value || '{}');
      existingMeta.treasuresCollected = [{
        treasureId: collectedTreasure.id,
        treasureName: collectedTreasure.name,
        powerType: collectedTreasure.type,
      }];
      const metaJson = JSON.stringify(existingMeta).replace(/'/g, "''");
      await q(`UPDATE feed_events SET metadata = '${metaJson}' WHERE id = '${feedId}'`);
      console.log(`  ✅ Updated feed event ${feedId.substring(0,8)} with treasure data`);
    }
  }

  // Final state check
  console.log('\n=== FINAL STATE ===');
  const users = await q("SELECT id, name, username, total_area FROM users WHERE id IN ('42fbe92fbe0f1375b835472b1284e27c', '1daf5dda2d1d970ad8aa3831bce3d0a3') ORDER BY total_area DESC");
  for (const r of users.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  ${vals[1]} (${vals[2]}): ${(vals[3]/1e6).toFixed(4)} km²`);
  }
  
  console.log('\n=== TERRITORIES ===');
  const terrs = await q("SELECT user_id, area FROM territories WHERE user_id IN ('42fbe92fbe0f1375b835472b1284e27c', '1daf5dda2d1d970ad8aa3831bce3d0a3')");
  for (const r of terrs.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  User ${vals[0]?.substring(0,8)}: ${(vals[1]/1e6).toFixed(4)} km² territory`);
  }

  console.log('\n=== FEED EVENT FOR 4a2b52aa ===');
  const feed = await q("SELECT id, user_id, metadata, created_at FROM feed_events WHERE route_id LIKE '4a2b52aa%'");
  for (const r of feed.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Feed: ${vals[0]?.substring(0,8)} at=${vals[3]}`);
    if (vals[2]) {
      const meta = JSON.parse(vals[2]);
      console.log(`  Metadata:`, JSON.stringify(meta, null, 2));
    }
  }

  console.log('\n=== JAVIALPODER ACTIVE POWERS ===');
  const powers = await q("SELECT id, power_type, status, treasure_id FROM user_powers WHERE user_id = '1daf5dda2d1d970ad8aa3831bce3d0a3' AND status = 'available'");
  for (const r of powers.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Power: ${vals[1]} status=${vals[2]}`);
  }

  console.log('\n✅ Done!');
})().catch(e => console.error(e));
