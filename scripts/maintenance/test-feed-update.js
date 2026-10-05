const DB_URL = process.env.TURSO_PIPELINE_URL;
const TOKEN = process.env.TURSO_AUTH_TOKEN;
if (!process.env.TURSO_PIPELINE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('Set TURSO_PIPELINE_URL (https://<db>.turso.io/v3/pipeline) and TURSO_AUTH_TOKEN first.');
  process.exit(1);
}

async function q(sql) {
  const r = await fetch(DB_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }] })
  });
  const j = await r.json();
  if (j.results[0].type === 'error') throw new Error(j.results[0].error.message);
  return j.results[0].response.result;
}

const MIGUEL_ID = '4c49ab03c695883f3caa852b6227e23b';
const POLAR_ACTIVITY = 'e1c057c595cd27780b806dcf5d348253';

async function cleanup() {
  // Find any routes and delete related data
  const routes = await q(`SELECT id FROM routes WHERE user_id='${MIGUEL_ID}'`);
  console.log('Routes to clean:', routes.rows.length);
  
  // Delete all territories, conquest_metrics, feed_events for this user's routes
  await q(`DELETE FROM feed_events WHERE user_id='${MIGUEL_ID}'`);
  await q(`DELETE FROM territories WHERE user_id='${MIGUEL_ID}'`);
  await q(`DELETE FROM conquest_metrics WHERE attacker_id='${MIGUEL_ID}'`);
  for (const r of routes.rows) {
    const routeId = r[0].value;
    await q(`DELETE FROM routes WHERE id='${routeId}'`);
  }
  
  // Reset polar activity
  await q(`UPDATE polar_activities SET processed=0, processed_at=NULL, route_id=NULL WHERE id='${POLAR_ACTIVITY}'`);
  
  // Reset user area
  await q(`UPDATE users SET total_area=0 WHERE id='${MIGUEL_ID}'`);
  
  console.log('Cleanup done');
}

async function check(routeId) {
  const t = await q(`SELECT id, area, route_id FROM territories WHERE user_id='${MIGUEL_ID}'`);
  console.log('Territories:', t.rows.length);
  for (const r of t.rows) {
    const v = r.map(x => x?.value);
    console.log('  T', v[0]?.substring(0,8), 'area='+(v[1]/1e6).toFixed(4)+'km2 route='+v[2]?.substring(0,8));
  }
  
  if (routeId) {
    const f = await q(`SELECT id, new_area, metadata FROM feed_events WHERE route_id='${routeId}'`);
    console.log('Feed events:', f.rows.length);
    for (const r of f.rows) {
      const v = r.map(x => x?.value);
      console.log('  F', v[0]?.substring(0,8), 'area='+v[1], 'meta='+(v[2]||'null').substring(0,200));
    }
  }
  
  const u = await q(`SELECT name, total_area FROM users WHERE id='${MIGUEL_ID}'`);
  console.log('User:', u.rows.map(r => r.map(x => x?.value)));
}

const cmd = process.argv[2];
if (cmd === 'cleanup') cleanup().catch(e => console.error(e));
else if (cmd === 'check') check(process.argv[3]).catch(e => console.error(e));
else console.log('Usage: node test-feed-update.js [cleanup|check] [routeId]');
