import { useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { MapContainer, TileLayer, Polyline } from 'react-leaflet';
import L from 'leaflet';
import type { Route } from '@shared/schema';

interface ActivityAnimationViewProps {
  route: Route;
  userColor: string;
  onComplete: () => void;
  animationDuration?: number; // in milliseconds
}

export function ActivityAnimationView({
  route,
  userColor,
  onComplete,
  animationDuration = 7000, // 7 seconds default
}: ActivityAnimationViewProps) {
  const mapRef = useRef(null);
  const [progress, setProgress] = useState(0);
  const [displayArea, setDisplayArea] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  
  // Parse route coordinates (supports geom or coordinates string)
  const coordinates = (() => {
    try {
      if (typeof route.geom === 'string') {
        const parsed = JSON.parse(route.geom);
        if (parsed.type === 'LineString') {
          return parsed.coordinates.map(([lng, lat]: [number, number]) => [lat, lng]);
        }
        if (parsed.type === 'FeatureCollection') {
          const feature = parsed.features[0];
          if (feature.geometry.type === 'LineString') {
            return feature.geometry.coordinates.map(([lng, lat]: [number, number]) => [lat, lng]);
          }
        }
        return parsed.coordinates || [];
      }

      if (typeof route.coordinates === 'string') {
        let parsed: unknown = JSON.parse(route.coordinates);
        if (typeof parsed === 'string') {
          parsed = JSON.parse(parsed);
        }

        if (Array.isArray(parsed)) {
          if (parsed.length > 0 && Array.isArray(parsed[0])) {
            return parsed as Array<[number, number]>;
          }
          if (parsed.length > 0 && typeof parsed[0] === 'object') {
            return (parsed as Array<{ value?: [number, number] }>).
              map((item) => item.value)
              .filter((value): value is [number, number] => Array.isArray(value) && value.length === 2);
          }
        }
      }

      return [];
    } catch (e) {
      console.error('Error parsing route geometry:', e);
      return [];
    }
  })();

  // Calculate total area as area progresses
  useEffect(() => {
    const interval = setInterval(() => {
      setProgress((prev) => {
        const next = Math.min(prev + 100 / (animationDuration / 100), 100);
        
        // Calculate area progression proportionally
        const routeArea = route.routeArea || (route as any).territory?.area || 0;
        setDisplayArea((next / 100) * routeArea);

        if (next >= 100) {
          setIsComplete(true);
          clearInterval(interval);
          setTimeout(onComplete, 500);
        }
        
        return next;
      });
    }, 100);

    return () => clearInterval(interval);
  }, [animationDuration, route.routeArea, onComplete, route]);

  // Calculate animated polyline points
  const animatedCoordinates = coordinates.slice(0, Math.ceil((progress / 100) * coordinates.length));

  // Fit bounds to route
  useEffect(() => {
    if (mapRef.current && coordinates.length > 0) {
      const latlngs = coordinates.map((coord: [number, number]) => L.latLng(coord[0], coord[1]));
      const bounds = L.latLngBounds(latlngs);
      const map = (mapRef.current as any).leafletElement || (mapRef.current as any);
      if (map && map.fitBounds) {
        map.fitBounds(bounds, { padding: [50, 50] });
      }
    }
  }, [coordinates]);

  return (
    <div className="flex flex-col h-full gap-4 p-4">
      {/* Map */}
      <Card className="flex-1 overflow-hidden">
        <MapContainer
          ref={mapRef}
          center={[40, -3]}
          zoom={12}
          style={{ width: '100%', height: '100%' }}
          scrollWheelZoom={false}
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/positron/{z}/{x}/{y}{r}.png"
            attribution='&copy; CartoDB contributors'
          />
          {animatedCoordinates.length > 0 && (
            <Polyline
              positions={animatedCoordinates}
              pathOptions={{
                color: userColor,
                weight: 4,
                opacity: 0.8,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          )}
        </MapContainer>
      </Card>

      {/* Progress Stats */}
      <Card className="p-4">
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium">Progreso de la ruta</label>
              <span className="text-sm font-bold text-primary">{Math.round(progress)}%</span>
            </div>
            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full transition-all duration-100"
                style={{
                  width: `${progress}%`,
                  backgroundColor: userColor,
                }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Recorrido</p>
              <p className="text-lg font-bold">
                {(animatedCoordinates.length / Math.max(coordinates.length, 1) * (route.distance / 1000)).toFixed(2)} km
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Área conquistada</p>
              <p className="text-lg font-bold">
                {(displayArea / 1000000).toFixed(2)} km²
              </p>
            </div>
          </div>

          {isComplete && (
            <div className="text-center py-2 bg-primary/10 rounded-lg">
              <Badge className="bg-primary text-white">Animación completada</Badge>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
