const TURSO_URL = process.env.TURSO_PIPELINE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
if (!process.env.TURSO_PIPELINE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('Set TURSO_PIPELINE_URL (https://<db>.turso.io/v3/pipeline) and TURSO_AUTH_TOKEN first.');
  process.exit(1);
}

async function query(sql) {
  const res = await fetch(TURSO_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + TURSO_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }, { type: 'close' }] })
  });
  const data = await res.json();
  if (!data.results || !data.results[0] || !data.results[0].response || !data.results[0].response.result) {
    console.error('Query failed:', JSON.stringify(data, null, 2));
    return [];
  }
  const result = data.results[0].response.result;
  return result.rows.map(row => {
    const obj = {};
    result.cols.forEach((col, i) => obj[col.name] = row[i] ? row[i].value : null);
    return obj;
  });
}

(async () => {
  // Get ALL feed events
  console.log('=== ALL FEED EVENTS ===');
  const allEvents = await query("SELECT id, user_id, event_type, route_id, metadata, area_stolen, victim_id, new_area, created_at FROM feed_events ORDER BY created_at DESC");
  allEvents.forEach(e => {
    const meta = e.metadata ? (e.metadata.length > 100 ? e.metadata.substring(0, 100) + '...' : e.metadata) : 'NULL';
    console.log(`  ${e.created_at} | user=${e.user_id.substring(0,8)} | type=${e.event_type} | route=${e.route_id ? e.route_id.substring(0,8) : 'null'} | area=${e.new_area} | stolen=${e.area_stolen} | victim=${e.victim_id ? e.victim_id.substring(0,8) : 'null'} | meta=${meta}`);
  });

  // Get conquest metrics for all users
  console.log('\n=== CONQUEST METRICS ===');
  const metrics = await query("SELECT cm.route_id, cm.attacker_id, cm.defender_id, cm.area_stolen, u.username as defender_name, u.color as defender_color FROM conquest_metrics cm LEFT JOIN users u ON cm.defender_id = u.id ORDER BY cm.route_id");
  metrics.forEach(m => {
    console.log(`  route=${(m.route_id||'null').substring(0,8)} | attacker=${(m.attacker_id||'null').substring(0,8)} | defender=${m.defender_name}(${(m.defender_id||'null').substring(0,8)}) | stolen=${m.area_stolen}`);
  });

  // Find feed events with empty/null metadata that have conquest data
  console.log('\n=== FEED EVENTS NEEDING METADATA UPDATE ===');
  for (const event of allEvents) {
    if (event.route_id && (!event.metadata || event.metadata === '{}' || event.metadata === 'null')) {
      const routeMetrics = metrics.filter(m => m.route_id === event.route_id);
      if (routeMetrics.length > 0) {
        console.log(`  Event ${event.id} (route ${event.route_id.substring(0,8)}) needs metadata:`);
        routeMetrics.forEach(m => console.log(`    victim: ${m.defender_name} (${m.defender_id}), stolen: ${m.area_stolen}`));
      }
    }
  }
})();
