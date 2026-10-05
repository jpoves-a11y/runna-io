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
  // Check ALL recent feed events with victims (territory stealing) - last 24h
  console.log('=== FEED EVENTS WITH VICTIMS (TERRITORY STEALING) ===');
  const feed = await q("SELECT id, user_id, route_id, metadata, created_at FROM feed_events WHERE metadata LIKE '%victims%' ORDER BY created_at DESC LIMIT 10");
  for (const r of feed.rows) {
    const vals = r.map(v => v?.value);
    try {
      const meta = JSON.parse(vals[3]);
      if (meta.victims?.length > 0) {
        console.log(`\n  Route ${vals[2]?.substring(0,8)} by user ${vals[1]?.substring(0,8)} at ${vals[4]}:`);
        for (const v of meta.victims) {
          console.log(`    -> Stole ${(v.stolenArea/1e6).toFixed(4)}km2 from ${v.userName}`);
        }
        if (meta.treasuresCollected?.length > 0) {
          console.log(`    -> Treasures: ${JSON.stringify(meta.treasuresCollected)}`);
        }
      }
    } catch(e) {}
  }

  // Check if route 48635b6b (14.03km from March 10) has a feed event
  console.log('\n=== FEED EVENT FOR 14.03km ROUTE (48635b6b) ===');
  const feed2 = await q("SELECT id, user_id, route_id, metadata, created_at FROM feed_events WHERE route_id LIKE '48635b6b%'");
  for (const r of feed2.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Feed: user=${vals[1]?.substring(0,8)} route=${vals[2]?.substring(0,8)} at=${vals[4]}`);
    if (vals[3]) {
      try {
        const meta = JSON.parse(vals[3]);
        console.log(`  Full metadata: ${JSON.stringify(meta, null, 2)}`);
      } catch(e) {}
    }
  }

  // Check if route 4a2b52aa (14.04km from today) has a feed event
  console.log('\n=== FEED EVENT FOR 14.04km ROUTE (4a2b52aa) ===');
  const feed3 = await q("SELECT id, user_id, route_id, metadata, created_at FROM feed_events WHERE route_id LIKE '4a2b52aa%'");
  for (const r of feed3.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Feed: user=${vals[1]?.substring(0,8)} route=${vals[2]?.substring(0,8)} at=${vals[4]}`);
    if (vals[3]) {
      try {
        const meta = JSON.parse(vals[3]);
        console.log(`  Full metadata: ${JSON.stringify(meta, null, 2)}`);
      } catch(e) {}
    }
  }

  // Check last territory entries for javialpoder
  console.log('\n=== ALL TERRITORIES FOR JAVIALPODER ===');
  const terr = await q("SELECT id, user_id, route_id, area, conquered_at FROM territories WHERE user_id = '1daf5dda2d1d970ad8aa3831bce3d0a3' ORDER BY conquered_at DESC");
  for (const r of terr.rows) {
    const vals = r.map(v => v?.value);
    console.log(`  Territory: id=${vals[0]?.substring(0,8)} route=${vals[2]?.substring(0,8)} area=${(vals[3]/1e6).toFixed(4)}km2 at=${vals[4]}`);
  }

  // Check javialpoder's coordinates for the latest route to compare with treasure location
  console.log('\n=== ROUTE 4a2b52aa COORDINATES (first+last 5) ===');
  const routeData = await q("SELECT id, coordinates FROM routes WHERE id LIKE '4a2b52aa%'");
  if (routeData.rows.length > 0) {
    const coords = JSON.parse(routeData.rows[0][1]?.value || '[]');
    console.log(`  Total coords: ${coords.length}`);
    console.log(`  First 5: ${JSON.stringify(coords.slice(0, 5))}`);
    console.log(`  Last 5: ${JSON.stringify(coords.slice(-5))}`);
    
    // Check distance to treasure at lat=41.631, lng=-0.880
    const treasureLat = 41.630968000963286;
    const treasureLng = -0.8797527821006621;
    let minDist = Infinity;
    let closestCoord = null;
    for (let i = 0; i < coords.length; i++) {
      const [lat, lng] = coords[i];
      // Approximate distance in meters
      const dlat = (lat - treasureLat) * 111320;
      const dlng = (lng - treasureLng) * 111320 * Math.cos(treasureLat * Math.PI / 180);
      const dist = Math.sqrt(dlat * dlat + dlng * dlng);
      if (dist < minDist) {
        minDist = dist;
        closestCoord = coords[i];
      }
    }
    console.log(`\n  Closest point to Doble Conquista treasure (41.631, -0.880):`);
    console.log(`    Coord: ${JSON.stringify(closestCoord)}`);
    console.log(`    Distance: ${minDist.toFixed(0)} meters`);
    console.log(`    Threshold for collection: 100 meters`);
  }

  // Also check 14.03km route (48635b6b)
  console.log('\n=== ROUTE 48635b6b COORDINATES proximity to treasure ===');
  const routeData2 = await q("SELECT id, coordinates FROM routes WHERE id LIKE '48635b6b%'");
  if (routeData2.rows.length > 0) {
    const coords = JSON.parse(routeData2.rows[0][1]?.value || '[]');
    console.log(`  Total coords: ${coords.length}`);
    
    const treasureLat = 41.630968000963286;
    const treasureLng = -0.8797527821006621;
    let minDist = Infinity;
    let closestCoord = null;
    for (let i = 0; i < coords.length; i++) {
      const [lat, lng] = coords[i];
      const dlat = (lat - treasureLat) * 111320;
      const dlng = (lng - treasureLng) * 111320 * Math.cos(treasureLat * Math.PI / 180);
      const dist = Math.sqrt(dlat * dlat + dlng * dlng);
      if (dist < minDist) {
        minDist = dist;
        closestCoord = coords[i];
      }
    }
    console.log(`  Closest point to Doble Conquista treasure:`);
    console.log(`    Coord: ${JSON.stringify(closestCoord)}`);
    console.log(`    Distance: ${minDist.toFixed(0)} meters`);
  }

})().catch(e => console.error(e));
