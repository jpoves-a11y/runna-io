import { useEffect, useRef, memo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * Leaflet-based route animation for feed posts.
 * Uses real dark map tiles (CartoDB Dark Matter) with animated polyline drawing.
 * IntersectionObserver pauses animation when off-screen.
 * Supports children overlay (stats bar).
 */

interface FeedRouteAnimationProps {
  coordinates: [number, number][];
  userColor: string;
  height?: number;
  children?: React.ReactNode;
}

const FeedRouteAnimation = memo(function FeedRouteAnimation({
  coordinates,
  userColor,
  height = 150,
  children,
}: FeedRouteAnimationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const animationRef = useRef<number | null>(null);
  const isVisibleRef = useRef(false);
  const polylineRef = useRef<L.Polyline | null>(null);
  const runnerRef = useRef<L.CircleMarker | null>(null);
  const endMarkerRef = useRef<L.CircleMarker | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const mapEl = mapContainerRef.current;
    if (!container || !mapEl || coordinates.length < 2) return;

    const map = L.map(mapEl, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
      boxZoom: false,
      keyboard: false,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);

    const latlngs = coordinates.map(([lat, lng]) => L.latLng(lat, lng));
    const fullPolyline = L.polyline(latlngs);
    const bounds = fullPolyline.getBounds();
    map.fitBounds(bounds, { padding: [20, 20] });

    // Ghost trail
    L.polyline(latlngs, {
      color: '#888',
      weight: 2,
      opacity: 0.15,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);

    // Start marker
    L.circleMarker(latlngs[0], {
      radius: 5,
      color: '#fff',
      fillColor: '#16a34a',
      fillOpacity: 1,
      weight: 1.5,
    }).addTo(map);

    // Animated polyline
    polylineRef.current = L.polyline([], {
      color: userColor,
      weight: 2.5,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);

    // Runner dot
    runnerRef.current = L.circleMarker(latlngs[0], {
      radius: 3.5,
      color: '#fff',
      fillColor: userColor,
      fillOpacity: 1,
      weight: 1.5,
    }).addTo(map);

    mapRef.current = map;

    setTimeout(() => {
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [20, 20] });

      const ANIMATION_DURATION = 3000;
      const PAUSE_DURATION = 800;
      const totalPoints = latlngs.length;

      const startCycle = () => {
        if (polylineRef.current) polylineRef.current.setLatLngs([]);
        if (endMarkerRef.current) {
          map.removeLayer(endMarkerRef.current);
          endMarkerRef.current = null;
        }
        if (!runnerRef.current) {
          runnerRef.current = L.circleMarker(latlngs[0], {
            radius: 3.5, color: '#fff', fillColor: userColor, fillOpacity: 1, weight: 1.5,
          }).addTo(map);
        } else {
          runnerRef.current.setLatLng(latlngs[0]);
        }

        const startTime = performance.now();

        const animate = (currentTime: number) => {
          if (!isVisibleRef.current) {
            animationRef.current = requestAnimationFrame(animate);
            return;
          }

          const elapsed = currentTime - startTime;
          const progress = Math.min(elapsed / ANIMATION_DURATION, 1);
          const eased = 1 - Math.pow(1 - progress, 3);
          const pointCount = Math.max(1, Math.floor(eased * totalPoints));
          const currentPoints = latlngs.slice(0, pointCount);

          if (polylineRef.current) polylineRef.current.setLatLngs(currentPoints);
          if (runnerRef.current && currentPoints.length > 0) {
            runnerRef.current.setLatLng(currentPoints[currentPoints.length - 1]);
          }

          if (progress < 1) {
            animationRef.current = requestAnimationFrame(animate);
          } else {
            endMarkerRef.current = L.circleMarker(latlngs[latlngs.length - 1], {
              radius: 5, color: '#fff', fillColor: '#dc2626', fillOpacity: 1, weight: 1.5,
            }).addTo(map);
            if (runnerRef.current) {
              map.removeLayer(runnerRef.current);
              runnerRef.current = null;
            }
            setTimeout(() => { if (mapRef.current) startCycle(); }, PAUSE_DURATION);
          }
        };

        animationRef.current = requestAnimationFrame(animate);
      };

      startCycle();
    }, 300);

    const observer = new IntersectionObserver(
      (entries) => { for (const entry of entries) isVisibleRef.current = entry.isIntersecting; },
      { threshold: 0.1 }
    );
    observer.observe(container);
    isVisibleRef.current = true;

    return () => {
      observer.disconnect();
      if (animationRef.current) { cancelAnimationFrame(animationRef.current); animationRef.current = null; }
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, [coordinates, userColor, height]);

  if (coordinates.length < 2) return null;

  return (
    <div ref={containerRef} className="relative w-full rounded-xl overflow-hidden" style={{ height }}>
      <div ref={mapContainerRef} className="absolute inset-0 w-full h-full" />
      {children}
    </div>
  );
});

export { FeedRouteAnimation };
