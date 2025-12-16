import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Button } from '@/components/ui/button';
import { ZoomIn, ZoomOut, Locate, Layers } from 'lucide-react';
import type { TerritoryWithUser } from '@shared/schema';
import { DEFAULT_CENTER, getCurrentPosition } from '@/lib/geolocation';

interface MapViewProps {
  territories: TerritoryWithUser[];
  center?: { lat: number; lng: number };
  onLocationFound?: (coords: { lat: number; lng: number }) => void;
}

export function MapView({ territories, center = DEFAULT_CENTER, onLocationFound }: MapViewProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const [mapStyle, setMapStyle] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    // Initialize map with more zoom
    const map = L.map(mapContainer.current, {
      center: [center.lat, center.lng],
      zoom: 14,
      zoomControl: false,
      attributionControl: false,
    });

    // Use Cartodb Positron for clean, minimalist look
    const lightTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
    });

    lightTiles.addTo(map);
    tileLayerRef.current = lightTiles;
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const toggleMapStyle = () => {
    if (!mapRef.current || !tileLayerRef.current) return;

    const newStyle = mapStyle === 'light' ? 'dark' : 'light';
    
    // Remove current tile layer
    mapRef.current.removeLayer(tileLayerRef.current);

    // Add new tile layer
    const newTiles = newStyle === 'light'
      ? L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 })
      : L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 });

    newTiles.addTo(mapRef.current);
    tileLayerRef.current = newTiles;
    setMapStyle(newStyle);
  };

  useEffect(() => {
    if (!mapRef.current) return;

    // Clear existing territory layers
    mapRef.current.eachLayer((layer) => {
      if (layer instanceof L.Polygon) {
        mapRef.current?.removeLayer(layer);
      }
    });

    // Add territory polygons with improved styling
    territories.forEach((territory) => {
      if (!mapRef.current || !territory.geometry?.coordinates) return;

      const coordinates = territory.geometry.coordinates[0].map((coord: number[]) => 
        [coord[1], coord[0]] as [number, number]
      );

      const polygon = L.polygon(coordinates, {
        color: territory.user.color,
        fillColor: territory.user.color,
        fillOpacity: 0.4,
        weight: 3,
        opacity: 0.8,
        className: 'territory-polygon',
      });

      // Improved popup styling
      polygon.bindPopup(`
        <div class="p-3 min-w-[200px]">
          <div class="flex items-center gap-2 mb-2">
            <div class="w-4 h-4 rounded-full" style="background-color: ${territory.user.color}"></div>
            <strong class="text-base">${territory.user.name}</strong>
          </div>
          <div class="text-sm text-muted-foreground">
            <div class="flex items-center justify-between">
              <span>Área conquistada:</span>
              <span class="font-semibold text-foreground">${(territory.area / 1000000).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km²</span>
            </div>
          </div>
        </div>
      `, {
        className: 'custom-popup',
      });

      // Add hover effect
      polygon.on('mouseover', () => {
        polygon.setStyle({
          fillOpacity: 0.6,
          weight: 4,
        });
      });

      polygon.on('mouseout', () => {
        polygon.setStyle({
          fillOpacity: 0.4,
          weight: 3,
        });
      });

      polygon.addTo(mapRef.current);
    });
  }, [territories]);

  const handleZoomIn = () => {
    mapRef.current?.zoomIn();
  };

  const handleZoomOut = () => {
    mapRef.current?.zoomOut();
  };

  const handleLocate = async () => {
    setIsLocating(true);
    try {
      const position = await getCurrentPosition();
      mapRef.current?.setView([position.lat, position.lng], 16);
      
      // Add pulsing marker for current location
      const pulsingIcon = L.divIcon({
        className: 'current-location-marker',
        html: `
          <div class="relative">
            <div class="absolute w-8 h-8 bg-primary/30 rounded-full animate-ping"></div>
            <div class="relative w-4 h-4 bg-primary rounded-full border-2 border-white shadow-lg"></div>
          </div>
        `,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      });

      L.marker([position.lat, position.lng], {
        icon: pulsingIcon,
      }).addTo(mapRef.current!);

      onLocationFound?.(position);
    } catch (error) {
      console.error('Error getting location:', error);
    } finally {
      setIsLocating(false);
    }
  };

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="w-full h-full map-container" data-testid="map-container" />
      
      {/* Zoom Controls */}
      <div className="absolute right-4 top-1/2 -translate-y-1/2 flex flex-col gap-2 z-[1000]">
        <Button
          size="icon"
          variant="secondary"
          onClick={handleZoomIn}
          data-testid="button-zoom-in"
          className="shadow-lg bg-card/95 backdrop-blur-sm hover:bg-card border-border"
        >
          <ZoomIn className="h-5 w-5" />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          onClick={handleZoomOut}
          data-testid="button-zoom-out"
          className="shadow-lg bg-card/95 backdrop-blur-sm hover:bg-card border-border"
        >
          <ZoomOut className="h-5 w-5" />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          onClick={toggleMapStyle}
          data-testid="button-toggle-style"
          className="shadow-lg bg-card/95 backdrop-blur-sm hover:bg-card border-border"
        >
          <Layers className="h-5 w-5" />
        </Button>
      </div>

      {/* Locate Button */}
      <Button
        size="icon"
        variant="secondary"
        onClick={handleLocate}
        disabled={isLocating}
        data-testid="button-locate"
        className="absolute left-4 bottom-24 shadow-lg z-[1000] bg-card/95 backdrop-blur-sm hover:bg-card border-border"
      >
        <Locate className={`h-5 w-5 ${isLocating ? 'animate-pulse' : ''}`} />
      </Button>

      <style>{`
        .map-container {
          border-radius: 0;
        }
        
        .territory-polygon {
          transition: all 0.2s ease;
        }
        
        .leaflet-popup-content-wrapper {
          border-radius: 0.5rem;
          padding: 0;
          overflow: hidden;
        }
        
        .leaflet-popup-content {
          margin: 0;
        }
        
        .leaflet-popup-tip {
          background: hsl(var(--card));
        }
        
        @keyframes ping {
          75%, 100% {
            transform: scale(2);
            opacity: 0;
          }
        }
        
        .animate-ping {
          animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;
        }
      `}</style>
    </div>
  );
}
