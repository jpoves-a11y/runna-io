import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Button } from '@/components/ui/button';
import { ZoomIn, ZoomOut, Layers, Navigation } from 'lucide-react';
import type { TerritoryWithUser, RouteWithTerritory } from '@shared/schema';
import { DEFAULT_CENTER, getCurrentPosition } from '@/lib/geolocation';

interface MapViewProps {
  territories: TerritoryWithUser[];
  routes?: RouteWithTerritory[];
  center?: { lat: number; lng: number };
  onLocationFound?: (coords: { lat: number; lng: number }) => void;
  onTerritoryClick?: (userId: string) => void;
}

export function MapView({ territories, routes = [], center = DEFAULT_CENTER, onLocationFound, onTerritoryClick }: MapViewProps) {
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

    // Ensure the map renders correctly after layout/gesture changes
    const invalidate = () => {
      requestAnimationFrame(() => {
        if (mapRef.current && mapContainer.current) {
          map.invalidateSize();
        }
      });
    };

    invalidate();

    const handleResize = () => invalidate();

    // Track container resize (swipe animations change layout size briefly)
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && mapContainer.current) {
      resizeObserver = new ResizeObserver(() => invalidate());
      resizeObserver.observe(mapContainer.current);
    }

    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
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

    // Small delay to ensure DOM is properly updated
    const timer = setTimeout(() => {
      if (mapRef.current && mapContainer.current) {
        mapRef.current.invalidateSize();
      }
    }, 0);

    // Clear existing territory layers
    mapRef.current.eachLayer((layer) => {
      if (layer instanceof L.Polygon) {
        mapRef.current?.removeLayer(layer);
      }
    });

    // Clear existing polyline layers
    mapRef.current.eachLayer((layer) => {
      if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
        mapRef.current?.removeLayer(layer);
      }
    });

    // Add route polylines with reduced opacity (user's territories)
    routes.forEach((route) => {
      if (!mapRef.current || !route.territory || !route.territory.user || !route.coordinates) return;

      // Convert coordinates from [lat, lng] to [lat, lng] for Leaflet
      const routeCoordinates = (route.coordinates as any).map((coord: any) => {
        if (Array.isArray(coord)) {
          return [coord[0], coord[1]] as [number, number];
        }
        return [coord.lat || 0, coord.lng || 0] as [number, number];
      });

      if (routeCoordinates.length < 2) return;

      const polyline = L.polyline(routeCoordinates, {
        color: route.territory.user.color,
        weight: 2,
        opacity: 0.4,
        smoothFactor: 1.0,
        className: 'route-polyline',
      });

      polyline.addTo(mapRef.current);
    });

    // Add territory polygons with improved styling
    territories.forEach((territory) => {
      if (!mapRef.current || !territory.user) return;

      // Parse geometry from JSON string if needed (SQLite stores as text)
      const parsedGeometry = typeof territory.geometry === 'string' 
        ? JSON.parse(territory.geometry) 
        : territory.geometry;

      if (!parsedGeometry?.coordinates) return;

      // Handle both Polygon and MultiPolygon geometries
      let leafletCoords: Array<Array<[number, number]>> | Array<Array<Array<[number, number]>>>;
      
      if (parsedGeometry.type === 'MultiPolygon') {
        // MultiPolygon: coordinates is array of polygons, each polygon is array of rings
        // Each ring is array of [lng, lat] coordinates
        leafletCoords = parsedGeometry.coordinates.map((polygon: number[][][]) =>
          polygon.map((ring: number[][]) =>
            ring.map((coord: number[]) => [coord[1], coord[0]] as [number, number])
          )
        );
      } else {
        // Polygon: coordinates is array of rings, each ring is array of [lng, lat]
        leafletCoords = parsedGeometry.coordinates.map((ring: number[][]) =>
          ring.map((coord: number[]) => [coord[1], coord[0]] as [number, number])
        );
      }

      const polygon = L.polygon(leafletCoords as any, {
        color: territory.user.color,
        fillColor: territory.user.color,
        fillOpacity: 0.35,
        weight: 3,
        opacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round',
        className: 'territory-polygon',
      });

      // Beautiful popup styling
      polygon.bindPopup(`
        <div class="territory-popup" style="min-width: 240px; font-family: system-ui, -apple-system, sans-serif;">
          <div style="
            background: linear-gradient(135deg, ${territory.user.color}15 0%, ${territory.user.color}05 100%);
            border-left: 4px solid ${territory.user.color};
            padding: 16px;
            border-radius: 12px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
          ">
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
              <div style="
                width: 40px;
                height: 40px;
                border-radius: 50%;
                background: ${territory.user.color};
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 2px 8px ${territory.user.color}40;
                font-weight: bold;
                color: white;
                font-size: 16px;
              ">
                ${territory.user.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
              </div>
              <div style="flex: 1;">
                <div style="font-weight: 600; font-size: 16px; color: #1a1a1a; margin-bottom: 2px; cursor: pointer; hover: text-decoration: underline;" class="territory-user-name" data-user-id="${territory.user.id}">
                  ${territory.user.name}
                </div>
                <div style="font-size: 13px; color: #666; display: flex; align-items: center; gap: 4px;">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                    <circle cx="12" cy="10" r="3"></circle>
                  </svg>
                  Territorio conquistado
                </div>
              </div>
            </div>
            <div style="
              background: white;
              padding: 12px;
              border-radius: 8px;
              display: flex;
              justify-content: space-between;
              align-items: center;
              box-shadow: 0 1px 3px rgba(0,0,0,0.05);
              margin-bottom: 12px;
            ">
              <span style="color: #666; font-size: 14px; font-weight: 500;">Área total</span>
              <div style="display: flex; align-items: baseline; gap: 4px;">
                <span style="font-size: 20px; font-weight: 700; color: ${territory.user.color};">
                  ${(territory.area / 1000000).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span style="font-size: 14px; font-weight: 600; color: #666;">km²</span>
              </div>
            </div>
            <button class="view-profile-btn" data-user-id="${territory.user.id}" style="
              width: 100%;
              padding: 10px;
              background: ${territory.user.color};
              color: white;
              border: none;
              border-radius: 6px;
              font-weight: 600;
              font-size: 14px;
              cursor: pointer;
              transition: opacity 0.2s;
            ">
              Ver perfil completo
            </button>
          </div>
        </div>
      `, {
        className: 'custom-popup',
        maxWidth: 280,
      });

      // Add hover effect
      polygon.on('mouseover', () => {
        polygon.setStyle({
          fillOpacity: 0.5,
          weight: 4,
        });
        polygon.bringToFront();
      });

      polygon.on('mouseout', () => {
        polygon.setStyle({
          fillOpacity: 0.35,
          weight: 3,
        });
      });

      polygon.addTo(mapRef.current);
    });

    // Add event listener for popup buttons
    const handlePopupButtonClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('view-profile-btn') || target.classList.contains('territory-user-name')) {
        const userId = target.getAttribute('data-user-id');
        if (userId && onTerritoryClick) {
          onTerritoryClick(userId);
          mapRef.current?.closePopup();
        }
      }
    };

    // Attach event listener to document for popup interactions
    const popupContainer = document.querySelector('.leaflet-popup-pane');
    if (popupContainer) {
      popupContainer.addEventListener('click', handlePopupButtonClick);
    }

    return () => {
      clearTimeout(timer);
      if (popupContainer) {
        popupContainer.removeEventListener('click', handlePopupButtonClick);
      }
    };
  }, [territories, routes, onTerritoryClick]);

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
      
      {/* Map Controls - positioned above the bottom nav */}
      <div className="absolute right-3 bottom-4 flex flex-col gap-2 z-[1000]">
        <Button
          size="icon"
          variant="secondary"
          onClick={handleLocate}
          disabled={isLocating}
          data-testid="button-locate"
          className="shadow-md bg-primary text-primary-foreground border-0"
        >
          <Navigation className={`h-4 w-4 ${isLocating ? 'animate-spin' : ''}`} />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          onClick={handleZoomIn}
          data-testid="button-zoom-in"
          className="shadow-md bg-card/95 backdrop-blur-md border border-border"
        >
          <ZoomIn className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          onClick={handleZoomOut}
          data-testid="button-zoom-out"
          className="shadow-md bg-card/95 backdrop-blur-md border border-border"
        >
          <ZoomOut className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          onClick={toggleMapStyle}
          data-testid="button-toggle-style"
          className="shadow-md bg-card/95 backdrop-blur-md border border-border"
        >
          <Layers className="h-4 w-4" />
        </Button>
      </div>

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
