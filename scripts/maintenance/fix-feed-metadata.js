/**
 * Fix territory stealing AND feed event metadata for Juan Girón's friend group.
 * Runs locally to avoid Cloudflare Worker CPU timeout limits.
 * 
 * This script:
 * 1. Re-processes all routes chronologically with full stealing logic (same as before)
 * 2. Tracks per-route victims data
 * 3. Updates feed events with proper metadata (victims, area)
 * 4. Also updates route territory areas and conquest metrics with route_id
 */
import * as turf from '@turf/turf';
import { randomUUID } from 'crypto';

const DB_URL = process.env.TURSO_PIPELINE_URL;
const TOKEN = process.env.TURSO_AUTH_TOKEN;
if (!process.env.TURSO_PIPELINE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('Set TURSO_PIPELINE_URL (https://<db>.turso.io/v3/pipeline) and TURSO_AUTH_TOKEN first.');
  process.exit(1);
}

const FRIEND_GROUP = [
  '42fbe92fbe0f1375b835472b1284e27c', // Juan Girón
  '1daf5dda2d1d970ad8aa3831bce3d0a3', // Pufalo/javialpoder
  '3d87f41228367efd69653ae3daf8587d', // lauritas
  'ebac909d00d9c4d8457b6eaecf9e4125', // María Poves
  '4c49ab03c695883f3caa852b6227e23b', // Miguel Rodrigo
  'a91eb408430e6fd8d7a6d3f37d844041', // Pablo Girón Poves
  '0a06649baf21eee0757662f2e938ff2d', // Carlos Molla
];

let friendshipMap = new Map();
let userMap = new Map(); // userId -> { name, username, color }

async function dbQuery(sql) {
  const resp = await fetch(DB_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }] }),
  });
  const json = await resp.json();
  if (json.results[0].type === 'error') {
    throw new Error(json.results[0].error.message);
  }
  return json.results[0].response.result;
}

async function dbExec(sql) {
  return dbQuery(sql);
}

function routeToEnclosedPolygon(coords, bufferMeters = 150) {
  if (coords.length < 10) return null;
  try {
    const simplified = coords.length > 150 ? simplifyCoordinates(coords, 150) : coords;
    // Flip [lat, lng] → [lng, lat] for GeoJSON convention (CRITICAL!)
    const ring = simplified.map(c => [c[1], c[0]]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    }
    try {
      const poly = turf.polygon([ring]);
      const area = turf.area(poly);
      if (!area || area <= 0 || !isFinite(area)) return null;
      return poly;
    } catch (e) {
      try {
        const line = turf.lineString(ring.slice(0, -1));
        const hull = turf.convex(turf.explode(line));
        if (hull && turf.area(hull) > 0) return hull;
      } catch (_) {}
      return null;
    }
  } catch (e) {
    return null;
  }
}

function simplifyCoordinates(coords, maxPoints = 150) {
  if (coords.length <= maxPoints) return coords;
  const step = Math.ceil(coords.length / maxPoints);
  const simplified = [];
  for (let i = 0; i < coords.length; i += step) {
    simplified.push(coords[i]);
  }
  if (simplified[simplified.length - 1] !== coords[coords.length - 1]) {
    simplified.push(coords[coords.length - 1]);
  }
  return simplified;
}

function toFeature(geom) {
  return geom.type === 'MultiPolygon'
    ? turf.multiPolygon(geom.coordinates)
    : turf.polygon(geom.coordinates);
}

function activitiesOverlapInTime(startA, endA, startB, endB) {
  const sA = new Date(startA).getTime();
  const eA = new Date(endA).getTime();
  const sB = new Date(startB).getTime();
  const eB = new Date(endB).getTime();
  const FIFTEEN_MIN = 15 * 60 * 1000;
  return Math.abs(sA - sB) <= FIFTEEN_MIN || (sA <= eB && sB <= eA);
}

function geometriesOverlapByPercentage(geomA, geomB, threshold = 0.90) {
  try {
    const fA = toFeature(geomA);
    const fB = toFeature(geomB);
    const intersection = turf.intersect(turf.featureCollection([fA, fB]));
    if (!intersection) return false;
    const iArea = turf.area(intersection);
    const aArea = turf.area(fA);
    const bArea = turf.area(fB);
    const smallerArea = Math.min(aArea, bArea);
    return smallerArea > 0 && (iArea / smallerArea) >= threshold;
  } catch (e) {
    return false;
  }
}

async function main() {
  console.log('🏃 Starting full reprocess with feed metadata update...');

  // 1. Fetch user data
  console.log('\n📋 Loading user data...');
  const userResult = await dbQuery(
    `SELECT id, name, username, color FROM users WHERE id IN ('${FRIEND_GROUP.join("','")}')`
  );
  for (const row of userResult.rows) {
    userMap.set(row[0].value, {
      name: row[1].value,
      username: row[2].value,
      color: row[3].value,
    });
  }

  // 2. Fetch friendship data
  console.log('📋 Loading friendships...');
  const friendResult = await dbQuery(
    `SELECT user_id, friend_id FROM friendships WHERE user_id IN ('${FRIEND_GROUP.join("','")}')`
  );
  for (const row of friendResult.rows) {
    const uid = row[0].value;
    const fid = row[1].value;
    if (!friendshipMap.has(uid)) friendshipMap.set(uid, new Set());
    friendshipMap.get(uid).add(fid);
  }

  // 3. Fetch all routes chronological
  console.log('📋 Loading routes...');
  const routeResult = await dbQuery(
    `SELECT id, user_id, coordinates, started_at, completed_at, distance FROM routes WHERE user_id IN ('${FRIEND_GROUP.join("','")}') ORDER BY started_at ASC`
  );
  const allRoutes = routeResult.rows.map(r => ({
    id: r[0].value,
    userId: r[1].value,
    coordinates: r[2].value,
    startedAt: r[3].value,
    completedAt: r[4].value,
    distance: r[5]?.value || 0,
  }));
  console.log(`   Found ${allRoutes.length} routes`);

  // 4. Fetch existing feed events to update
  console.log('📋 Loading feed events...');
  const feedResult = await dbQuery(
    `SELECT id, route_id, metadata FROM feed_events WHERE event_type = 'activity' AND user_id IN ('${FRIEND_GROUP.join("','")}')`
  );
  const feedEventByRoute = new Map();
  for (const row of feedResult.rows) {
    const id = row[0].value;
    const routeId = row[1]?.value;
    const metadata = row[2]?.value;
    if (routeId) {
      feedEventByRoute.set(routeId, { id, metadata: metadata ? JSON.parse(metadata) : {} });
    }
  }
  console.log(`   Found ${feedEventByRoute.size} activity feed events with route_id`);

  // 5. Delete existing territories and conquest metrics
  console.log('\n🗑️  Wiping territories and conquest metrics...');
  await dbExec(`DELETE FROM territories WHERE user_id IN ('${FRIEND_GROUP.join("','")}')`);
  await dbExec(`DELETE FROM conquest_metrics WHERE attacker_id IN ('${FRIEND_GROUP.join("','")}') OR defender_id IN ('${FRIEND_GROUP.join("','")}')`);
  await dbExec(`UPDATE users SET total_area = 0 WHERE id IN ('${FRIEND_GROUP.join("','")}')`);

  // 6. Process routes chronologically with stealing — track per-route victims
  const userGeometries = new Map();
  const routePolygonCache = new Map();
  const routesByUser = new Map();
  const conquestStats = new Map();
  const routeVictims = new Map(); // routeId -> Array<{ userId, userName, userColor, stolenArea }>
  const routeRanTogether = new Map(); // routeId -> Array<{ id, name }> of users who ran together
  const routeNewArea = new Map(); // routeId -> area of what this route contributed

  for (const r of allRoutes) {
    if (!routesByUser.has(r.userId)) routesByUser.set(r.userId, []);
    routesByUser.get(r.userId).push(r);
  }

  console.log('\n🏃 Processing routes chronologically...');
  let processedCount = 0;

  for (const route of allRoutes) {
    try {
      const coords = typeof route.coordinates === 'string'
        ? JSON.parse(route.coordinates)
        : route.coordinates;

      if (!Array.isArray(coords) || coords.length < 10) continue;

      const enclosedPoly = routeToEnclosedPolygon(coords, 150);
      if (!enclosedPoly) continue;

      const routeGeometry = enclosedPoly.geometry;
      routePolygonCache.set(route.id, routeGeometry);
      const routeOwnerFriends = friendshipMap.get(route.userId) || new Set();
      const victims = []; // per-route victims

      // Steal from friends
      for (const [otherUserId, otherGeometry] of userGeometries) {
        if (otherUserId === route.userId) continue;
        if (!routeOwnerFriends.has(otherUserId)) continue;

        try {
          const otherFeature = toFeature(otherGeometry);
          const routeFeature = toFeature(routeGeometry);

          const intersection = turf.intersect(turf.featureCollection([otherFeature, routeFeature]));
          if (intersection) {
            // Ran-together check
            if (route.startedAt && route.completedAt) {
              const otherRoutes = routesByUser.get(otherUserId) || [];
              let ranTogether = false;
              for (const otherRoute of otherRoutes) {
                if (!otherRoute.startedAt || !otherRoute.completedAt) continue;
                const timeOverlap = activitiesOverlapInTime(
                  route.startedAt, route.completedAt,
                  otherRoute.startedAt, otherRoute.completedAt
                );
                if (timeOverlap) {
                  const otherRoutePolygon = routePolygonCache.get(otherRoute.id);
                  if (otherRoutePolygon) {
                    const areaOverlap = geometriesOverlapByPercentage(routeGeometry, otherRoutePolygon, 0.90);
                    if (areaOverlap) {
                      ranTogether = true;
                      // Track ran together
                      const otherUser = userMap.get(otherUserId);
                      if (otherUser) {
                        if (!routeRanTogether.has(route.id)) routeRanTogether.set(route.id, []);
                        routeRanTogether.get(route.id).push({ id: otherUserId, name: otherUser.name });
                        // Also mark the other route as ran together with this user
                        if (!routeRanTogether.has(otherRoute.id)) routeRanTogether.set(otherRoute.id, []);
                        const thisUser = userMap.get(route.userId);
                        if (thisUser && !routeRanTogether.get(otherRoute.id).find(u => u.id === route.userId)) {
                          routeRanTogether.get(otherRoute.id).push({ id: route.userId, name: thisUser.name });
                        }
                      }
                      break;
                    }
                  }
                }
              }
              if (ranTogether) {
                continue;
              }
            }

            const stolenArea = turf.area(intersection);
            if (stolenArea > 0) {
              const remaining = turf.difference(turf.featureCollection([otherFeature, routeFeature]));
              if (remaining) {
                userGeometries.set(otherUserId, remaining.geometry);
              } else {
                userGeometries.delete(otherUserId);
              }

              // Track per-route victim
              const victimUser = userMap.get(otherUserId);
              victims.push({
                userId: otherUserId,
                userName: victimUser ? victimUser.name : otherUserId,
                userColor: victimUser ? victimUser.color : '#888888',
                stolenArea: stolenArea,
              });

              // Track aggregate stats
              if (!conquestStats.has(route.userId)) conquestStats.set(route.userId, { stole: {}, lost: {} });
              if (!conquestStats.has(otherUserId)) conquestStats.set(otherUserId, { stole: {}, lost: {} });
              const attackerStats = conquestStats.get(route.userId);
              const victimStats = conquestStats.get(otherUserId);
              attackerStats.stole[otherUserId] = (attackerStats.stole[otherUserId] || 0) + stolenArea;
              victimStats.lost[route.userId] = (victimStats.lost[route.userId] || 0) + stolenArea;
            }
          }
        } catch (e) {
          // geometry op failed, skip
        }
      }

      // Save per-route victims
      if (victims.length > 0) {
        routeVictims.set(route.id, victims);
      }

      // Compute how much area this route ADDED
      const routeArea = turf.area(toFeature(routeGeometry));

      // Merge route into owner's territory
      const existing = userGeometries.get(route.userId);
      if (existing) {
        try {
          const existingArea = turf.area(toFeature(existing));
          const merged = turf.union(turf.featureCollection([toFeature(existing), toFeature(routeGeometry)]));
          if (merged) {
            userGeometries.set(route.userId, merged.geometry);
            const mergedArea = turf.area(merged);
            routeNewArea.set(route.id, mergedArea - existingArea); // net new area from this route
          }
        } catch (e) {
          routeNewArea.set(route.id, routeArea);
        }
      } else {
        userGeometries.set(route.userId, routeGeometry);
        routeNewArea.set(route.id, routeArea);
      }

      processedCount++;
      if (processedCount % 5 === 0) {
        const areas = [];
        for (const [uid, geom] of userGeometries) {
          const u = userMap.get(uid);
          areas.push(`${u ? u.username : uid.slice(0,8)}: ${(turf.area(geom) / 1000000).toFixed(2)} km²`);
        }
        console.log(`   ✅ ${processedCount}/${allRoutes.length} | ${areas.join(', ')}`);
      }
    } catch (err) {
      console.error(`   ❌ Error on route ${route.id}:`, err.message);
    }
  }

  console.log(`\n✅ Processed ${processedCount} routes total`);
  console.log(`   Routes with victims: ${routeVictims.size}`);
  console.log(`   Routes with ran-together: ${routeRanTogether.size}`);

  // 7. Persist territories
  console.log('\n💾 Saving territories...');
  for (const [uid, geometry] of userGeometries) {
    const totalArea = turf.area(geometry);
    const geomJson = JSON.stringify(geometry).replace(/'/g, "''");
    const territoryId = randomUUID().replace(/-/g, '');
    await dbExec(`INSERT INTO territories (id, user_id, geometry, area) VALUES ('${territoryId}', '${uid}', '${geomJson}', ${totalArea})`);
    await dbExec(`UPDATE users SET total_area = ${totalArea} WHERE id = '${uid}'`);
    const u = userMap.get(uid);
    console.log(`   ${u ? u.name : uid}: ${(totalArea / 1000000).toFixed(4)} km²`);
  }
  for (const uid of FRIEND_GROUP) {
    if (!userGeometries.has(uid)) {
      await dbExec(`UPDATE users SET total_area = 0 WHERE id = '${uid}'`);
    }
  }

  // 8. Save conquest metrics (with route_id this time)
  console.log('\n📊 Saving conquest metrics...');
  for (const [uid, stats] of conquestStats) {
    for (const [victimId, area] of Object.entries(stats.stole)) {
      const metricId = randomUUID().replace(/-/g, '');
      await dbExec(`INSERT INTO conquest_metrics (id, attacker_id, defender_id, area_stolen) VALUES ('${metricId}', '${uid}', '${victimId}', ${area})`);
    }
  }

  // 9. UPDATE FEED EVENTS WITH METADATA
  console.log('\n📝 Updating feed event metadata...');
  let updatedCount = 0;

  for (const route of allRoutes) {
    const feedEvent = feedEventByRoute.get(route.id);
    if (!feedEvent) continue;

    const victims = routeVictims.get(route.id) || [];
    const ranTogether = routeRanTogether.get(route.id) || [];
    const newArea = routeNewArea.get(route.id) || 0;

    // Build metadata - merge with existing
    const existingMeta = feedEvent.metadata || {};
    const newMeta = { ...existingMeta };

    if (victims.length > 0) {
      newMeta.victims = victims;
    }
    if (ranTogether.length > 0) {
      newMeta.ranTogetherWith = ranTogether;
    }
    // Keep existing records, treasures etc

    const metaJson = JSON.stringify(newMeta).replace(/'/g, "''");
    
    // Also compute total area stolen for this route
    const totalStolen = victims.reduce((sum, v) => sum + v.stolenArea, 0);

    // Update feed event
    const updateSql = `UPDATE feed_events SET metadata = '${metaJson}', new_area = ${newArea}${totalStolen > 0 ? `, area_stolen = ${totalStolen}` : ''} WHERE id = '${feedEvent.id}'`;
    
    try {
      await dbExec(updateSql);
      updatedCount++;
      if (victims.length > 0 || ranTogether.length > 0) {
        const u = userMap.get(route.userId);
        console.log(`   ${u ? u.username : route.userId.slice(0,8)} route ${route.id.slice(0,8)}: ${victims.length} victims, ${ranTogether.length} ran-together, area=${(newArea/1e6).toFixed(4)} km²`);
      }
    } catch (err) {
      console.error(`   ❌ Failed to update feed event ${feedEvent.id}:`, err.message);
    }
  }

  console.log(`\n   Updated ${updatedCount} feed events`);

  // 10. Print summary
  console.log('\n📊 FINAL SUMMARY:');
  console.log('─'.repeat(60));
  for (const uid of FRIEND_GROUP) {
    const u = userMap.get(uid);
    const name = u ? u.name : uid;
    const geom = userGeometries.get(uid);
    const area = geom ? (turf.area(geom) / 1000000).toFixed(4) : '0';
    const stats = conquestStats.get(uid) || { stole: {}, lost: {} };
    
    console.log(`\n  ${name} (${u ? u.username : uid.slice(0,8)})`);
    console.log(`    Total area: ${area} km²`);
    
    const stoleEntries = Object.entries(stats.stole);
    if (stoleEntries.length > 0) {
      console.log('    Stole from:');
      for (const [vid, a] of stoleEntries) {
        const vu = userMap.get(vid);
        console.log(`      → ${vu ? vu.name : vid}: ${(a / 1000000).toFixed(4)} km²`);
      }
    }
  }

  console.log('\n✅ Done! Feed events now have proper victim metadata.');
}

main().catch(console.error);
