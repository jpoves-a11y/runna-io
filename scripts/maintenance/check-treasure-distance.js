// Check distance from Juan Girón's last route to active treasures
const BASE = 'https://runna-io-api.runna-io-api.workers.dev';
const JUAN_ID = '42fbe92fbe0f1375b835472b1284e27c';
const ROUTE_ID = 'def1411449ce43388bfebfd167430c36';

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function main() {
  // Get route
  const routesResp = await fetch(`${BASE}/api/routes/${JUAN_ID}`);
  const routes = await routesResp.json();
  const route = routes.find(r => r.id === ROUTE_ID);
  if (!route) { console.log('Route not found!'); return; }
  
  console.log(`Route: ${route.name} (${route.id})`);
  console.log(`Distance: ${(route.distance/1000).toFixed(1)}km`);
  console.log(`Started: ${route.startedAt}`);
  console.log(`Coordinates: ${route.coordinates.length} points`);
  console.log();
  
  // Get treasures
  const tResp = await fetch(`${BASE}/api/treasures/active`);
  const { treasures } = await tResp.json();
  
  console.log(`Active treasures: ${treasures.length}`);
  console.log();
  
  for (const t of treasures) {
    let minDist = Infinity;
    let closestIdx = -1;
    for (let i = 0; i < route.coordinates.length; i++) {
      const [lat, lng] = route.coordinates[i];
      const d = haversine(lat, lng, t.lat, t.lng);
      if (d < minDist) { minDist = d; closestIdx = i; }
    }
    const closest = route.coordinates[closestIdx];
    console.log(`Treasure: ${t.name} (${t.powerType}, ${t.rarity})`);
    console.log(`  Location: [${t.lat}, ${t.lng}]`);
    console.log(`  Min distance: ${minDist.toFixed(1)}m`);
    console.log(`  Closest route point [${closestIdx}]: [${closest[0]}, ${closest[1]}]`);
    console.log(`  Within 100m? ${minDist <= 100 ? 'YES ✅' : 'NO ❌'}`);
    console.log(`  Within 200m? ${minDist <= 200 ? 'YES' : 'NO'}`);
    console.log();
  }

  // Also check already collected treasures for Juan
  try {
    const userResp = await fetch(`${BASE}/api/users/${JUAN_ID}`);
    const user = await userResp.json();
    console.log(`Juan Girón total area: ${(user.totalArea/1e6).toFixed(4)} km²`);
  } catch(e) {}
}

main().catch(console.error);
