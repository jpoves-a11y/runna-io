// Asks OpenStreetMap for the chest places of some cities, exactly as the Worker does, and prints a
// summary; with --html <file> it also writes a map (Leaflet) with every place and the urban radius.
//
//   node --import tsx scripts/chest-places/preview.ts "Zaragoza:41.65:-0.88" "Alfajarín:41.61:-0.70" --html places.html
//
// Each city is "Name:lat:lng" (the lat/lng of roughly where the club members live).
import { writeFileSync } from 'node:fs';
import { prepareArea, distanceM, type PreparedArea } from '../../worker/src/chestSpots';

const args = process.argv.slice(2);
const htmlIndex = args.indexOf('--html');
const htmlFile = htmlIndex >= 0 ? args[htmlIndex + 1] : null;
const cities = args.filter((a, i) => a.includes(':') && i !== htmlIndex + 1);
if (cities.length === 0) {
  console.error('Usage: preview.ts "Name:lat:lng" ... [--html file]');
  process.exit(2);
}

const results: Array<{ name: string; area?: PreparedArea; error?: string }> = [];
for (const spec of cities) {
  const [name, lat, lng] = spec.split(':');
  try {
    const area = await prepareArea({ name, lat: Number(lat), lng: Number(lng) }, (url, init) => fetch(url, init));
    results.push({ name, area });
    const byKind: Record<string, number> = {};
    for (const s of area.spots) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    const farthest = Math.max(0, ...area.spots.map((s) => distanceM(s, area.place)));
    console.log(`\n== ${name} -> ${area.place.name} (${area.place.placeType}, population ${area.place.population ?? '?'})`);
    console.log(`   centre ${area.place.lat.toFixed(5)}, ${area.place.lng.toFixed(5)} · mode ${area.mode} · radius ${area.radiusM} m`);
    console.log(`   ${area.spots.length} places: ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ')} · farthest ${Math.round(farthest)} m`);
    const named = area.spots.filter((s) => s.name).slice(0, 25).map((s) => `${s.name} (${s.kind})`);
    console.log(`   e.g. ${named.join(' · ')}`);
  } catch (error) {
    results.push({ name, error: String(error) });
    console.log(`\n== ${name}: ERROR ${error}`);
  }
  // Be gentle with the public Overpass server
  await new Promise((r) => setTimeout(r, 2000));
}

if (htmlFile) {
  const layers = results.filter((r) => r.area).map((r) => ({
    name: r.name,
    centre: [r.area!.place.lat, r.area!.place.lng],
    radius: r.area!.radiusM,
    spots: r.area!.spots.map((s) => [s.lat, s.lng, s.kind, s.name ?? '']),
  }));
  writeFileSync(htmlFile, `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sitios de cofres</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>html,body,#map{height:100%;margin:0;font-family:system-ui,sans-serif}</style></head><body><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const layers = ${JSON.stringify(layers)};
const colours = { landmark: '#d4a017', square: '#e4572e', pedestrian: '#f08a4b', park: '#2a9d4b', track: '#3a86ff', fountain: '#8ecae6', street: '#7a7a7a' };
const map = L.map('map');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors' }).addTo(map);
const bounds = [];
for (const layer of layers) {
  L.circle(layer.centre, { radius: layer.radius, color: '#111', weight: 1, fill: false, dashArray: '4 4' }).addTo(map).bindTooltip(layer.name);
  for (const [lat, lng, kind, name] of layer.spots) {
    L.circleMarker([lat, lng], { radius: 5, color: colours[kind] || '#000', fillOpacity: 0.85, weight: 1 }).addTo(map).bindTooltip((name || '(sin nombre)') + ' · ' + kind);
    bounds.push([lat, lng]);
  }
}
if (bounds.length) map.fitBounds(bounds); else map.setView([40.4, -3.7], 6);
</script></body></html>`);
  console.log(`\nMap written to ${htmlFile}`);
}
