import { useEffect, useRef, useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { X } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { decodePolyline } from '@/lib/polyline';

interface ActivityAnimationViewProps {
  summaryPolyline: string;
  distance: number; // meters
  userColor: string;
  onComplete: () => void;
  onClose: () => void;
  animationDuration?: number;
  territoryArea?: number; // area in m²
}

export function ActivityAnimationView({
  summaryPolyline,
  distance,
  userColor,
  onComplete,
  onClose,
  animationDuration = 5000,
  territoryArea = 0,
}: ActivityAnimationViewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const polylineLayerRef = useRef<L.Polyline | null>(null);
  const animationRef = useRef<number | null>(null);
  const startMarkerRef = useRef<L.CircleMarker | null>(null);
  const endMarkerRef = useRef<L.CircleMarker | null>(null);
  const runnerMarkerRef = useRef<L.CircleMarker | null>(null);

  // DOM refs for direct manipulation (no React re-renders during animation)
  const progressBarRef = useRef<HTMLDivElement>(null);
  const progressTextRef = useRef<HTMLSpanElement>(null);
  const distanceTextRef = useRef<HTMLParagraphElement>(null);
  const areaTextRef = useRef<HTMLParagraphElement>(null);
  const completeBadgeRef = useRef<HTMLDivElement>(null);

  // Stable refs for callbacks
  const onCompleteRef = useRef(onComplete);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const coordinates = useMemo(() => {
    try {
      return decodePolyline(summaryPolyline);
    } catch {
      return [];
    }
  }, [summaryPolyline]);

  useEffect(() => {
    if (!mapContainerRef.current || coordinates.length === 0) return;

    // Reset DOM elements directly
    if (progressBarRef.current) progressBarRef.current.style.width = '0%';
    if (progressTextRef.current) progressTextRef.current.textContent = '0%';
    if (distanceTextRef.current) distanceTextRef.current.textContent = '0.00 km';
    if (areaTextRef.current) areaTextRef.current.textContent = '0.00 km²';
    if (completeBadgeRef.current) completeBadgeRef.current.style.display = 'none';

    // Clean up previous
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }

    const map = L.map(mapContainerRef.current, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(map);

    const latlngs = coordinates.map(([lat, lng]) => L.latLng(lat, lng));
    const fullPolyline = L.polyline(latlngs);
    const bounds = fullPolyline.getBounds();
    map.fitBounds(bounds, { padding: [40, 40] });

    // Start marker (green)
    startMarkerRef.current = L.circleMarker(latlngs[0], {
      radius: 8,
      color: '#fff',
      fillColor: '#16a34a',
      fillOpacity: 1,
      weight: 2,
    }).addTo(map);

    // Animated polyline - starts empty
    polylineLayerRef.current = L.polyline([], {
      color: userColor || '#D4213D',
      weight: 4,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);

    // Runner dot
    runnerMarkerRef.current = L.circleMarker(latlngs[0], {
      radius: 6,
      color: '#fff',
      fillColor: userColor || '#D4213D',
      fillOpacity: 1,
      weight: 2,
    }).addTo(map);

    // Start animation after map tiles load
    setTimeout(() => {
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [40, 40] });

      const startTime = performance.now();
      const totalPoints = latlngs.length;
      const distKm = distance / 1000;
      const areaKm2 = territoryArea / 1000000;

      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const rawProgress = Math.min(elapsed / animationDuration, 1);

        // Ease-out cubic
        const eased = 1 - Math.pow(1 - rawProgress, 3);
        const pointCount = Math.max(1, Math.floor(eased * totalPoints));
        const currentPoints = latlngs.slice(0, pointCount);

        // Update Leaflet polyline
        if (polylineLayerRef.current) {
          polylineLayerRef.current.setLatLngs(currentPoints);
        }

        // Move runner dot
        if (runnerMarkerRef.current && currentPoints.length > 0) {
          runnerMarkerRef.current.setLatLng(currentPoints[currentPoints.length - 1]);
        }

        // Direct DOM updates (no React re-render)
        const pct = eased * 100;
        if (progressBarRef.current) progressBarRef.current.style.width = `${pct}%`;
        if (progressTextRef.current) progressTextRef.current.textContent = `${Math.round(pct)}%`;
        if (distanceTextRef.current) distanceTextRef.current.textContent = `${(eased * distKm).toFixed(2)} km`;
        if (areaTextRef.current) areaTextRef.current.textContent = `${(eased * areaKm2).toFixed(2)} km²`;

        if (rawProgress < 1) {
          animationRef.current = requestAnimationFrame(animate);
        } else {
          // Animation complete
          endMarkerRef.current = L.circleMarker(latlngs[latlngs.length - 1], {
            radius: 8,
            color: '#fff',
            fillColor: '#dc2626',
            fillOpacity: 1,
            weight: 2,
          }).addTo(map);

          if (runnerMarkerRef.current) {
            map.removeLayer(runnerMarkerRef.current);
            runnerMarkerRef.current = null;
          }

          // Final values via DOM
          if (progressBarRef.current) progressBarRef.current.style.width = '100%';
          if (progressTextRef.current) progressTextRef.current.textContent = '100%';
          if (distanceTextRef.current) distanceTextRef.current.textContent = `${distKm.toFixed(2)} km`;
          if (areaTextRef.current) areaTextRef.current.textContent = `${areaKm2.toFixed(2)} km²`;
          if (completeBadgeRef.current) completeBadgeRef.current.style.display = 'block';
          setTimeout(() => onCompleteRef.current(), 800);
        }
      };

      animationRef.current = requestAnimationFrame(animate);
    }, 500);

    mapRef.current = map;

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordinates, userColor, animationDuration, territoryArea]);

  if (coordinates.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Sin datos de ruta para animar</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-3 p-3 relative" style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top, 0px))' }}>
      {/* Close button */}
      <button
        onClick={() => onCloseRef.current()}
        className="absolute right-4 z-[1000] bg-background/80 backdrop-blur-sm border border-border rounded-full p-2.5 shadow-lg hover:bg-background transition-colors active:scale-95"
        style={{ top: 'calc(1rem + env(safe-area-inset-top, 0px))' }}
        aria-label="Cerrar animación"
      >
        <X className="h-5 w-5" />
      </button>

      {/* Map */}
      <Card className="flex-1 overflow-hidden rounded-xl">
        <div ref={mapContainerRef} className="w-full h-full" />
      </Card>

      {/* Progress Stats */}
      <Card className="p-3">
        <div className="space-y-2">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium">Progreso de la ruta</label>
              <span ref={progressTextRef} className="text-sm font-bold text-primary">0%</span>
            </div>
            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
              <div
                ref={progressBarRef}
                className="h-full"
                style={{
                  width: '0%',
                  backgroundColor: userColor || '#D4213D',
                }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Recorrido</p>
              <p ref={distanceTextRef} className="text-lg font-bold">0.00 km</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Área conquistada</p>
              <p ref={areaTextRef} className="text-lg font-bold">0.00 km²</p>
            </div>
          </div>

          <div ref={completeBadgeRef} className="text-center py-1 bg-primary/10 rounded-lg" style={{ display: 'none' }}>
            <Badge className="bg-primary text-white">¡Ruta completada!</Badge>
          </div>
        </div>
      </Card>
    </div>
  );
}
