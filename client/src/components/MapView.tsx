import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Button } from '@/components/ui/button';
import { ZoomIn, ZoomOut, Layers, Navigation } from 'lucide-react';
import type { TerritoryWithUser, RouteWithTerritory } from '@shared/schema';
import { DEFAULT_CENTER, getCurrentPosition } from '@/lib/geolocation';
import { useTheme } from '@/hooks/use-theme';
import { useMapTilePrefetch } from '@/hooks/use-map-tile-prefetch';

interface MapViewProps {
  territories: TerritoryWithUser[];
  routes?: RouteWithTerritory[];
  center?: { lat: number; lng: number };
  onLocationFound?: (coords: { lat: number; lng: number }) => void;
  onTerritoryClick?: (userId: string) => void;
  isLoadingTerritories?: boolean;
  visibleUserIds?: Set<string> | null; // null = show all
}

// Compute the centroid of a GeoJSON geometry (Polygon or MultiPolygon)
function getGeometryCentroid(geometry: any): [number, number] | null {
  try {
    const parsed = typeof geometry === 'string' ? JSON.parse(geometry) : geometry;
    if (!parsed?.coordinates) return null;

    let sumLat = 0, sumLng = 0, count = 0;

    const addRing = (ring: number[][]) => {
      // Skip the closing coordinate (same as first)
      for (let i = 0; i < ring.length - 1; i++) {
        sumLng += ring[i][0];
        sumLat += ring[i][1];
        count++;
      }
    };

    if (parsed.type === 'MultiPolygon') {
      for (const polygon of parsed.coordinates) {
        addRing(polygon[0]); // outer ring only
      }
    } else {
      addRing(parsed.coordinates[0]); // outer ring only
    }

    if (count === 0) return null;
    return [sumLat / count, sumLng / count];
  } catch {
    return null;
  }
}

// Shared tile layer options - extracted to avoid re-creation
const TILE_OPTIONS: L.TileLayerOptions = {
  maxZoom: 19,
  minZoom: 3,
  keepBuffer: 12, // Large buffer = more pre-loaded tiles around viewport
  updateWhenIdle: false, // Load tiles DURING panning, not after
  updateWhenZooming: true, // Load tiles during zoom animation
  updateInterval: 50, // Very fast tile update rate (50ms)
  crossOrigin: true,
  subdomains: ['a', 'b', 'c', 'd'], // 4 CDN subdomains for max parallelism
  className: 'map-tiles',
};

const TILE_URLS = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};

export function MapView({ territories, routes = [], center = DEFAULT_CENTER, onLocationFound, onTerritoryClick, isLoadingTerritories = false, visibleUserIds = null }: MapViewProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  // Persistent layer groups for efficient add/remove without full redraw
  const territoryGroupRef = useRef<L.LayerGroup | null>(null);
  const routeGroupRef = useRef<L.LayerGroup | null>(null);
  const labelGroupRef = useRef<L.LayerGroup | null>(null);
  // Track which layers correspond to which data IDs for diffing
  const territoryLayersRef = useRef<Map<number, L.Polygon>>(new Map());
  const routeLayersRef = useRef<Map<number, L.Polyline>>(new Map());
  const labelLayersRef = useRef<Map<string, L.Marker>>(new Map());
  // Canvas renderer for better polygon/polyline performance
  const canvasRendererRef = useRef<L.Canvas | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const { resolvedTheme } = useTheme();
  const [mapStyle, setMapStyle] = useState<'light' | 'dark'>(resolvedTheme === 'dark' ? 'dark' : 'light');

  // Prefetch adjacent tiles for smoother panning
  useMapTilePrefetch(mapRef, true);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    // Create a shared canvas renderer for all vector layers - much faster than SVG
    const canvasRenderer = L.canvas({ padding: 0.5, tolerance: 10 });
    canvasRendererRef.current = canvasRenderer;

    // Initialize map with optimized settings for smooth panning
    const map = L.map(mapContainer.current, {
      center: [center.lat, center.lng],
      zoom: 14,
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true, // Global canvas preference
      renderer: canvasRenderer, // Shared canvas renderer
      zoomAnimation: true,
      fadeAnimation: true,
      markerZoomAnimation: true,
      zoomSnap: 0.5, // Smoother zoom steps
      wheelDebounceTime: 40, // Responsive scroll zoom
    });

    // Use tile layer matching current theme with aggressive caching
    const initialStyle = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    const initialTiles = L.tileLayer(TILE_URLS[initialStyle], TILE_OPTIONS);

    initialTiles.addTo(map);
    tileLayerRef.current = initialTiles;

    // Create persistent layer groups for territories and routes
    const territoryGroup = L.layerGroup().addTo(map);
    const routeGroup = L.layerGroup().addTo(map);
    const labelGroup = L.layerGroup().addTo(map);
    territoryGroupRef.current = territoryGroup;
    routeGroupRef.current = routeGroup;
    labelGroupRef.current = labelGroup;

    mapRef.current = map;
    setMapStyle(initialStyle);

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
      territoryGroupRef.current = null;
      routeGroupRef.current = null;
      labelGroupRef.current = null;
      territoryLayersRef.current.clear();
      routeLayersRef.current.clear();
      labelLayersRef.current.clear();
    };
  }, []);

  // Sync map tiles when app theme changes
  useEffect(() => {
    if (!mapRef.current || !tileLayerRef.current) return;
    const desired = resolvedTheme === 'dark' ? 'dark' : 'light';
    if (desired === mapStyle) return;

    mapRef.current.removeLayer(tileLayerRef.current);
    const newTiles = L.tileLayer(TILE_URLS[desired], TILE_OPTIONS);
    newTiles.addTo(mapRef.current);
    tileLayerRef.current = newTiles;
    setMapStyle(desired);
  }, [resolvedTheme]);

  const toggleMapStyle = () => {
    if (!mapRef.current || !tileLayerRef.current) return;

    const newStyle = mapStyle === 'light' ? 'dark' : 'light';
    
    // Remove current tile layer
    mapRef.current.removeLayer(tileLayerRef.current);

    // Add new tile layer with shared optimization settings
    const newTiles = L.tileLayer(TILE_URLS[newStyle], TILE_OPTIONS);

    newTiles.addTo(mapRef.current);
    tileLayerRef.current = newTiles;
    setMapStyle(newStyle);
  };

  // Stable callback to avoid re-renders
  const onTerritoryClickRef = useRef(onTerritoryClick);
  onTerritoryClickRef.current = onTerritoryClick;

  // === ROUTE LAYER DIFFING ===
  // Only add/remove changed routes instead of clearing everything
  useEffect(() => {
    if (!mapRef.current || !routeGroupRef.current) return;

    const routeGroup = routeGroupRef.current;
    const existingLayers = routeLayersRef.current;

    // Filter routes by visible users
    const visibleRoutes = visibleUserIds
      ? routes.filter(r => {
          const routeUserId = (r as any).userId || r.territory?.user?.id;
          return routeUserId && visibleUserIds.has(routeUserId);
        })
      : routes;

    const newRouteIds = new Set(visibleRoutes.map(r => r.id));
    const existingIds = new Set(existingLayers.keys());

    // Remove routes that no longer exist
    for (const [id, layer] of existingLayers) {
      if (!newRouteIds.has(id)) {
        routeGroup.removeLayer(layer);
        existingLayers.delete(id);
      }
    }

    // Add new routes that don't exist yet
    visibleRoutes.forEach((route) => {
      if (!route.coordinates || existingIds.has(route.id)) return;

      const routeColor = route.territory?.user?.color || '#D4213D';

      const routeCoordinates = (route.coordinates as any).map((coord: any) => {
        if (Array.isArray(coord)) {
          return [coord[0], coord[1]] as [number, number];
        }
        return [coord.lat || 0, coord.lng || 0] as [number, number];
      });

      if (routeCoordinates.length < 2) return;

      const polyline = L.polyline(routeCoordinates, {
        color: routeColor,
        weight: 2,
        opacity: 0.4,
        smoothFactor: 1.5, // Simplify polyline for better performance
        renderer: canvasRendererRef.current || undefined,
      });

      routeGroup.addLayer(polyline);
      existingLayers.set(route.id, polyline);
    });
  }, [routes, visibleUserIds]);

  // === TERRITORY LAYER DIFFING ===
  // Only add/remove changed territories instead of clearing everything
  useEffect(() => {
    if (!mapRef.current || !territoryGroupRef.current) return;

    const territoryGroup = territoryGroupRef.current;
    const existingLayers = territoryLayersRef.current;

    // Filter territories by visible users
    const visibleTerritories = visibleUserIds
      ? territories.filter(t => t.user && visibleUserIds.has(t.user.id))
      : territories;

    const newTerritoryIds = new Set(visibleTerritories.map(t => t.id));
    const existingIds = new Set(existingLayers.keys());

    // Remove territories that no longer exist or are now hidden
    for (const [id, layer] of existingLayers) {
      if (!newTerritoryIds.has(id)) {
        territoryGroup.removeLayer(layer);
        existingLayers.delete(id);
      }
    }

    // Add new territories that don't exist yet
    visibleTerritories.forEach((territory) => {
      if (!territory.user || existingIds.has(territory.id)) return;

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
        renderer: canvasRendererRef.current || undefined, // Canvas renderer for better perf
      });

      // Determine popup colors based on current theme
      const isDark = document.documentElement.classList.contains('dark');
      const popupBg = isDark ? '#1e1e1e' : 'white';
      const popupText = isDark ? '#e5e5e5' : '#1a1a1a';
      const popupMuted = isDark ? '#999' : '#666';
      const popupCardBg = isDark ? '#2a2a2a' : 'white';
      const popupShadow = isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.1)';

      // Beautiful popup styling
      polygon.bindPopup(`
        <div class="territory-popup" style="min-width: 240px; font-family: system-ui, -apple-system, sans-serif;">
          <div style="
            background: linear-gradient(135deg, ${territory.user.color}15 0%, ${territory.user.color}05 100%);
            border-left: 4px solid ${territory.user.color};
            padding: 16px;
            border-radius: 12px;
            box-shadow: 0 4px 12px ${popupShadow};
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
                <div style="font-weight: 600; font-size: 16px; color: ${popupText}; margin-bottom: 2px; cursor: pointer;" class="territory-user-name" data-user-id="${territory.user.id}">
                  ${territory.user.name}
                </div>
                <div style="font-size: 13px; color: ${popupMuted}; display: flex; align-items: center; gap: 4px;">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                    <circle cx="12" cy="10" r="3"></circle>
                  </svg>
                  Territorio conquistado
                </div>
              </div>
            </div>
            <div style="
              background: ${popupCardBg};
              padding: 12px;
              border-radius: 8px;
              display: flex;
              justify-content: space-between;
              align-items: center;
              box-shadow: 0 1px 3px rgba(0,0,0,0.05);
              margin-bottom: 12px;
            ">
              <span style="color: ${popupMuted}; font-size: 14px; font-weight: 500;">Área total</span>
              <div style="display: flex; align-items: baseline; gap: 4px;">
                <span style="font-size: 20px; font-weight: 700; color: ${territory.user.color};">
                  ${(territory.area / 1000000).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span style="font-size: 14px; font-weight: 600; color: ${popupMuted};">km²</span>
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

      territoryGroup.addLayer(polygon);
      existingLayers.set(territory.id, polygon);
    });

    // Add event listener for popup buttons
    const handlePopupButtonClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('view-profile-btn') || target.classList.contains('territory-user-name')) {
        const userId = target.getAttribute('data-user-id');
        if (userId && onTerritoryClickRef.current) {
          onTerritoryClickRef.current(userId);
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
      if (popupContainer) {
        popupContainer.removeEventListener('click', handlePopupButtonClick);
      }
    };
  }, [territories, visibleUserIds]);

  // === TERRITORY NAME LABELS ===
  // Show user names at territory centroids, responsive to zoom level
  useEffect(() => {
    if (!mapRef.current || !labelGroupRef.current) return;

    const map = mapRef.current;
    const labelGroup = labelGroupRef.current;
    const existingLabels = labelLayersRef.current;

    // Filter territories by visible users
    const visibleTerritories = visibleUserIds
      ? territories.filter(t => t.user && visibleUserIds.has(t.user.id))
      : territories;

    // Group territories by user to show one label per user (at their largest territory)
    const userTerritories = new Map<string, TerritoryWithUser>();
    visibleTerritories.forEach(t => {
      if (!t.user) return;
      const existing = userTerritories.get(t.user.id);
      if (!existing || t.area > existing.area) {
        userTerritories.set(t.user.id, t);
      }
    });

    const currentUserIds = new Set(userTerritories.keys());

    // Remove labels for users no longer visible
    for (const [userId, marker] of existingLabels) {
      if (!currentUserIds.has(userId)) {
        labelGroup.removeLayer(marker);
        existingLabels.delete(userId);
      }
    }

    // Create/update labels
    for (const [userId, territory] of userTerritories) {
      // Remove existing to recreate (centroid may have changed)
      if (existingLabels.has(userId)) {
        labelGroup.removeLayer(existingLabels.get(userId)!);
        existingLabels.delete(userId);
      }

      const centroid = getGeometryCentroid(territory.geometry);
      if (!centroid) continue;

      const handle = territory.user.username || territory.user.name.split(' ')[0];

      const marker = L.marker(centroid, {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: 'territory-label',
          html: `<span class="territory-label-text" data-color="${territory.user.color}">@${handle}</span>`,
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        }),
      });

      labelGroup.addLayer(marker);
      existingLabels.set(userId, marker);
    }

    // Zoom-responsive label sizing
    const updateLabelSizes = () => {
      const zoom = map.getZoom();
      const labels = document.querySelectorAll('.territory-label-text') as NodeListOf<HTMLSpanElement>;
      
      if (zoom < 11) {
        // Hide labels at low zoom
        labels.forEach(l => l.style.opacity = '0');
      } else {
        // Scale from 9px at zoom 11 to 18px at zoom 18
        const fontSize = Math.min(18, Math.max(9, 9 + (zoom - 11) * 1.3));
        // Opacity from 0.25 at zoom 11 to 0.55 at zoom 18 — subtle, semi-transparent
        const opacity = Math.min(0.55, Math.max(0.25, (zoom - 11) * 0.043 + 0.25));
        labels.forEach(l => {
          l.style.fontSize = `${fontSize}px`;
          l.style.opacity = `${opacity}`;
          l.style.color = l.dataset.color || '';
        });
      }
    };

    updateLabelSizes();
    map.on('zoomend', updateLabelSizes);

    return () => {
      map.off('zoomend', updateLabelSizes);
    };
  }, [territories, visibleUserIds]);

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
      
      {/* Loading indicator for territories */}
      {isLoadingTerritories && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-2 px-3 py-2 rounded-full bg-card/95 backdrop-blur-md border border-border shadow-md">
          <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/20 border-t-primary animate-spin" />
          <span className="text-xs font-medium text-muted-foreground">Cargando territorios...</span>
        </div>
      )}
      
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
        
        /* Match map background to tile theme - eliminates white zones */
        .leaflet-container {
          background: ${mapStyle === 'dark' ? '#000000' : '#e8e8e6'} !important;
        }
        
        /* Smooth tile appearance */
        .leaflet-tile {
          will-change: transform;
        }
        
        /* Ensure tiles load without delay */
        .leaflet-tile-container {
          will-change: transform;
          backface-visibility: hidden;
        }
        
        /* Make tile loading invisible - tiles appear from matching background */
        .leaflet-tile-loaded {
          opacity: 1 !important;
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
        
        /* Territory name labels */
        .territory-label {
          background: none !important;
          border: none !important;
          box-shadow: none !important;
        }
        
        .territory-label-text {
          font-weight: 700;
          font-size: 11px;
          white-space: nowrap;
          pointer-events: none;
          user-select: none;
          letter-spacing: 0.04em;
          transition: font-size 0.2s ease, opacity 0.2s ease;
          transform: translate(-50%, -50%);
          display: inline-block;
          opacity: 0.35;
          text-transform: lowercase;
        }
      `}</style>
    </div>
  );
}
