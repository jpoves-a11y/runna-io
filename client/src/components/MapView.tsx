import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Button } from '@/components/ui/button';
import { ZoomIn, ZoomOut, Layers, Navigation } from 'lucide-react';
import type { TerritoryWithUser, RouteWithTerritory } from '@shared/schema';
import { DEFAULT_CENTER, getCurrentPosition } from '@/lib/geolocation';
import { useTheme } from '@/hooks/use-theme';
import { useMapTilePrefetch } from '@/hooks/use-map-tile-prefetch';
import { useMapRotation } from '@/hooks/use-map-rotation';
import type { Treasure } from '@/hooks/use-competition';

export interface FortificationData {
  userId: string;
  layers: number;
  records: Array<{ geometry: any; area: number }>;
}

interface MapViewProps {
  territories: TerritoryWithUser[];
  routes?: RouteWithTerritory[];
  treasures?: Treasure[];
  fortifications?: FortificationData[];
  center?: { lat: number; lng: number };
  onLocationFound?: (coords: { lat: number; lng: number }) => void;
  onTerritoryClick?: (userId: string) => void;
  isLoadingTerritories?: boolean;
  visibleUserIds?: Set<string> | null; // null = show all
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

export function MapView({ territories, routes = [], treasures = [], fortifications = [], center = DEFAULT_CENTER, onLocationFound, onTerritoryClick, isLoadingTerritories = false, visibleUserIds = null }: MapViewProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  // Persistent layer groups for efficient add/remove without full redraw
  const territoryGroupRef = useRef<L.LayerGroup | null>(null);
  const routeGroupRef = useRef<L.LayerGroup | null>(null);
  const treasureGroupRef = useRef<L.LayerGroup | null>(null);
  const fortificationGroupRef = useRef<L.LayerGroup | null>(null);
  // Track which layers correspond to which data IDs for diffing
  const territoryLayersRef = useRef<Map<number, L.Polygon>>(new Map());
  const routeLayersRef = useRef<Map<number, L.Polyline>>(new Map());
  const treasureLayersRef = useRef<Map<string, L.Marker>>(new Map());
  // Canvas renderer for better polygon/polyline performance
  const canvasRendererRef = useRef<L.Canvas | null>(null);
  // SVG renderer for shared-run territories (allows SVG pattern fills)
  const svgRendererRef = useRef<L.SVG | null>(null);
  // User location marker (single instance, updated on each locate)
  const locationMarkerRef = useRef<L.Marker | null>(null);
  const headingRef = useRef<number | null>(null);
  const orientationHandlerRef = useRef<((e: Event) => void) | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const orientationGrantedRef = useRef(
    typeof sessionStorage !== 'undefined' && sessionStorage.getItem('orientation-granted') === '1'
  );
  const [isLocating, setIsLocating] = useState(false);
  const { resolvedTheme } = useTheme();
  const [mapStyle, setMapStyle] = useState<'light' | 'dark'>(resolvedTheme === 'dark' ? 'dark' : 'light');
  const [mapReady, setMapReady] = useState(0);

  // Prefetch adjacent tiles for smoother panning
  useMapTilePrefetch(mapRef, true);

  // Two-finger map rotation (custom lightweight, no plugin)
  const { bearing, bearingRef, resetBearing } = useMapRotation(mapRef, mapReady);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    // Create a shared canvas renderer for all vector layers - much faster than SVG
    // padding 1.5 pre-renders 1.5× viewport beyond each edge — covers all rotation angles
    const canvasRenderer = L.canvas({ padding: 1.5, tolerance: 10 });
    canvasRendererRef.current = canvasRenderer;

    // SVG renderer for shared-run territories (supports pattern fills)
    const svgRenderer = L.svg({ padding: 1.5 });
    svgRendererRef.current = svgRenderer;

    // Initialize map with optimized settings for smooth panning
    const map = L.map(mapContainer.current, {
      center: [center.lat, center.lng],
      zoom: 14,
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
      renderer: canvasRenderer,
      zoomAnimation: true,
      fadeAnimation: true,
      markerZoomAnimation: true,
      zoomSnap: 0.5,
      wheelDebounceTime: 40,
    });

    // Use tile layer matching current theme with aggressive caching
    const initialStyle = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    const initialTiles = L.tileLayer(TILE_URLS[initialStyle], TILE_OPTIONS);

    initialTiles.addTo(map);
    tileLayerRef.current = initialTiles;

    // Create persistent layer groups for territories and routes
    const territoryGroup = L.layerGroup().addTo(map);
    const routeGroup = L.layerGroup().addTo(map);
    const treasureGroup = L.layerGroup().addTo(map);
    const fortificationGroup = L.layerGroup().addTo(map);
    territoryGroupRef.current = territoryGroup;
    routeGroupRef.current = routeGroup;
    treasureGroupRef.current = treasureGroup;
    fortificationGroupRef.current = fortificationGroup;

    mapRef.current = map;
    setMapReady(r => r + 1);
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
      treasureGroupRef.current = null;
      fortificationGroupRef.current = null;
      territoryLayersRef.current.clear();
      routeLayersRef.current.clear();
      treasureLayersRef.current.clear();
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
        leafletCoords = parsedGeometry.coordinates.map((polygon: number[][][]) =>
          polygon.map((ring: number[][]) =>
            ring.map((coord: number[]) => [coord[1], coord[0]] as [number, number])
          )
        );
      } else {
        leafletCoords = parsedGeometry.coordinates.map((ring: number[][]) =>
          ring.map((coord: number[]) => [coord[1], coord[0]] as [number, number])
        );
      }

      // Check if this is a shared run territory (ran together with others)
      const isSharedRun = territory.ranTogetherWithColors && territory.ranTogetherWithColors.length > 0;
      let polygon: L.Polygon;

      if (isSharedRun && svgRendererRef.current) {
        // Shared run: use SVG renderer with diagonal stripe pattern
        const coColors = territory.ranTogetherWithColors!;
        const allColors = [territory.user.color, ...coColors.map(c => c.color)];
        const patternId = `stripe_${territory.id.replace(/[^a-zA-Z0-9]/g, '')}`;

        polygon = L.polygon(leafletCoords as any, {
          color: territory.user.color,
          fillColor: `url(#${patternId})` as any,
          fillOpacity: 0.45,
          weight: 3,
          opacity: 0.9,
          lineCap: 'round',
          lineJoin: 'round',
          renderer: svgRendererRef.current,
        });

        // Create SVG <pattern> defs when polygon is rendered
        polygon.on('add', () => {
          const rendererEl = (svgRendererRef.current as any)?._container as SVGSVGElement | undefined;
          if (!rendererEl) return;

          let defs = rendererEl.querySelector('defs');
          if (!defs) {
            defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            rendererEl.insertBefore(defs, rendererEl.firstChild);
          }

          if (!defs.querySelector(`#${patternId}`)) {
            const stripeW = 7;
            const totalW = stripeW * allColors.length;

            const pat = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
            pat.setAttribute('id', patternId);
            pat.setAttribute('patternUnits', 'userSpaceOnUse');
            pat.setAttribute('width', String(totalW));
            pat.setAttribute('height', String(totalW));
            pat.setAttribute('patternTransform', 'rotate(45)');

            allColors.forEach((c, i) => {
              const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
              rect.setAttribute('x', String(i * stripeW));
              rect.setAttribute('y', '0');
              rect.setAttribute('width', String(stripeW));
              rect.setAttribute('height', String(totalW));
              rect.setAttribute('fill', c);
              pat.appendChild(rect);
            });

            defs.appendChild(pat);
          }
        });
      } else {
        // Normal territory: solid fill with canvas renderer
        polygon = L.polygon(leafletCoords as any, {
          color: territory.user.color,
          fillColor: territory.user.color,
          fillOpacity: 0.35,
          weight: 3,
          opacity: 0.9,
          lineCap: 'round',
          lineJoin: 'round',
          renderer: canvasRendererRef.current || undefined,
        });
      }

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
          fillOpacity: isSharedRun ? 0.65 : 0.5,
          weight: 4,
        });
        polygon.bringToFront();
      });

      polygon.on('mouseout', () => {
        polygon.setStyle({
          fillOpacity: isSharedRun ? 0.45 : 0.35,
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

  // === TREASURE MARKER DIFFING ===
  useEffect(() => {
    if (!mapRef.current || !treasureGroupRef.current) return;

    const treasureGroup = treasureGroupRef.current;
    const existingLayers = treasureLayersRef.current;

    const newTreasureIds = new Set(treasures.map(t => t.id));
    const existingIds = new Set(existingLayers.keys());

    // Remove treasures that no longer exist
    for (const [id, layer] of existingLayers) {
      if (!newTreasureIds.has(id)) {
        treasureGroup.removeLayer(layer);
        existingLayers.delete(id);
      }
    }

    // Rarity colors
    const rarityColors: Record<string, { bg: string; border: string; glow: string; pulse: string }> = {
      common: { bg: '#6b7280', border: '#9ca3af', glow: 'rgba(107,114,128,0.4)', pulse: 'rgba(107,114,128,0.2)' },
      rare: { bg: '#3b82f6', border: '#60a5fa', glow: 'rgba(59,130,246,0.5)', pulse: 'rgba(59,130,246,0.2)' },
      epic: { bg: '#a855f7', border: '#c084fc', glow: 'rgba(168,85,247,0.5)', pulse: 'rgba(168,85,247,0.2)' },
      legendary: { bg: '#f59e0b', border: '#fbbf24', glow: 'rgba(245,158,11,0.6)', pulse: 'rgba(245,158,11,0.3)' },
    };

    // Chest images by rarity
    const chestImages: Record<string, string> = {
      common: '/cofre_common.png',
      rare: '/cofre_rare.png',
      epic: '/cofre_epic.png',
      legendary: '/cofre_legendary.png',
    };

    // Add new treasures
    treasures.forEach((treasure) => {
      if (existingIds.has(treasure.id)) return;

      const colors = rarityColors[treasure.rarity] || rarityColors.common;
      const chestSrc = chestImages[treasure.rarity] || chestImages.common;

      const icon = L.divIcon({
        className: 'treasure-marker',
        html: `
          <div style="position: relative; width: 48px; height: 48px;">
            <div style="
              position: absolute;
              inset: -6px;
              border-radius: 50%;
              background: ${colors.pulse};
              animation: treasure-pulse 2s ease-in-out infinite;
            "></div>
            <div style="
              position: absolute;
              inset: -3px;
              border-radius: 50%;
              box-shadow: 0 0 16px ${colors.glow};
            "></div>
            <img src="${chestSrc}" alt="Cofre" style="
              position: relative;
              width: 48px;
              height: 48px;
              object-fit: contain;
              filter: drop-shadow(0 2px 6px rgba(0,0,0,0.4));
              cursor: pointer;
            " />
          </div>
        `,
        iconSize: [48, 48],
        iconAnchor: [24, 24],
      });

      const marker = L.marker([treasure.lat, treasure.lng], { icon });
      
      const isDark = document.documentElement.classList.contains('dark');
      const popupBg = isDark ? '#1e1e1e' : 'white';
      const popupText = isDark ? '#e5e5e5' : '#1a1a1a';
      const powerEmojis: Record<string, string> = {
        shield: '🛡️', double_area: '⚡', nickname: '🎭', steal_boost: '🏴‍☠️',
        invisibility: '👻', time_bomb: '💀', magnet: '🧲', reveal: '🔮',
        bulldozer: '🚜', battering_ram: '🪓', wall: '🧱', sentinel: '🔔',
      };
      const treasureEmoji = treasure.power?.emoji || powerEmojis[treasure.powerType] || '💎';
      
      const popupId = `treasure-cd-${treasure.id.slice(0, 8)}`;
      marker.bindPopup(`
        <div style="padding: 12px; min-width: 180px; font-family: system-ui, sans-serif;">
          <div style="text-align: center; margin-bottom: 8px;">
            <span style="font-size: 28px;">${treasureEmoji}</span>
          </div>
          <div style="text-align: center;">
            <div style="font-weight: 700; font-size: 14px; color: ${popupText}; margin-bottom: 4px;">
              ${treasure.name}
            </div>
            <div style="
              display: inline-block;
              padding: 2px 8px;
              border-radius: 9999px;
              background: ${colors.bg}20;
              color: ${colors.bg};
              font-size: 10px;
              font-weight: 700;
              text-transform: uppercase;
              letter-spacing: 0.05em;
              margin-bottom: 6px;
            ">${treasure.rarity}</div>
            <div style="font-size: 11px; color: ${isDark ? '#999' : '#666'}; line-height: 1.4;">
              ${treasure.power?.description || ''}
            </div>
            <div style="display: flex; align-items: center; justify-content: center; gap: 4px; margin-top: 8px; font-size: 11px; color: ${isDark ? '#ccc' : '#444'};">
              <span style="font-size: 13px;">⏳</span>
              <span id="${popupId}" data-expires="${treasure.expiresAt}" style="font-weight: 600; font-variant-numeric: tabular-nums;"></span>
            </div>
            <div style="font-size: 10px; color: ${isDark ? '#666' : '#999'}; margin-top: 6px;">
              ¡Corre a menos de 100m para recogerlo!
            </div>
          </div>
        </div>
      `, {
        className: 'custom-popup treasure-popup',
        maxWidth: 220,
      });

      // Start countdown timer when popup opens
      marker.on('popupopen', () => {
        const updateCountdown = () => {
          const el = document.getElementById(popupId);
          if (!el) return;
          const expires = new Date(el.dataset.expires || '').getTime();
          const diff = expires - Date.now();
          if (diff <= 0) { el.textContent = 'Expirado'; return; }
          const h = Math.floor(diff / 3600000);
          const m = Math.floor((diff % 3600000) / 60000);
          const s = Math.floor((diff % 60000) / 1000);
          el.textContent = `${h}h ${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`;
        };
        updateCountdown();
        const interval = setInterval(updateCountdown, 1000);
        marker.once('popupclose', () => clearInterval(interval));
      });

      treasureGroup.addLayer(marker);
      existingLayers.set(treasure.id, marker);
    });
  }, [treasures]);

  // === FORTIFICATION OVERLAY ===
  useEffect(() => {
    if (!mapRef.current || !fortificationGroupRef.current) return;
    const fortGroup = fortificationGroupRef.current;
    fortGroup.clearLayers();

    if (!fortifications || fortifications.length === 0) return;

    // Build a user-color map from territories
    const userColorMap = new Map<string, string>();
    for (const t of territories) {
      if (t.user) userColorMap.set(t.user.id, t.user.color);
    }

    for (const userFort of fortifications) {
      const userColor = userColorMap.get(userFort.userId) || '#6b7280';
      const level = userFort.layers * 0.5;
      if (level < 0.5) continue; // Don't show until at least 0.5

      // Render each fortification record as a semi-transparent overlay
      for (const record of userFort.records) {
        try {
          const geom = record.geometry;
          if (!geom?.coordinates) continue;

          let leafletCoords: any;
          if (geom.type === 'MultiPolygon') {
            leafletCoords = geom.coordinates.map((polygon: number[][][]) =>
              polygon.map((ring: number[][]) =>
                ring.map((coord: number[]) => [coord[1], coord[0]] as [number, number])
              )
            );
          } else {
            leafletCoords = geom.coordinates.map((ring: number[][]) =>
              ring.map((coord: number[]) => [coord[1], coord[0]] as [number, number])
            );
          }

          const opacityBoost = Math.min(level * 0.08, 0.4);
          const overlay = L.polygon(leafletCoords as any, {
            color: userColor,
            fillColor: userColor,
            fillOpacity: 0.15 + opacityBoost,
            weight: 1,
            opacity: 0.3,
            interactive: false,
            renderer: canvasRendererRef.current || undefined,
          });
          fortGroup.addLayer(overlay);
        } catch (_) {}
      }

      // Add a castle marker at the centroid of the first record (representative)
      if (level >= 1.0 && userFort.records.length > 0) {
        try {
          const firstGeom = userFort.records[0].geometry;
          if (firstGeom?.coordinates) {
            // Compute rough centroid from first ring of first record
            const coords = firstGeom.type === 'MultiPolygon'
              ? firstGeom.coordinates[0][0]
              : firstGeom.coordinates[0];
            if (coords && coords.length > 0) {
              let latSum = 0, lngSum = 0;
              for (const c of coords) {
                lngSum += c[0];
                latSum += c[1];
              }
              const centLat = latSum / coords.length;
              const centLng = lngSum / coords.length;

              const levelDisplay = Math.floor(level);
              const castleIcon = L.divIcon({
                className: 'fortification-castle-icon',
                html: `<div style="
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  width: 32px;
                  height: 32px;
                  background: ${userColor};
                  border: 2px solid white;
                  border-radius: 50%;
                  box-shadow: 0 2px 6px rgba(0,0,0,0.3);
                  font-size: 14px;
                  color: white;
                  font-weight: bold;
                ">🏰<span style="font-size:10px;position:absolute;bottom:-2px;right:-2px;background:${userColor};border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;border:1px solid white;">${levelDisplay}</span></div>`,
                iconSize: [32, 32],
                iconAnchor: [16, 16],
              });

              const marker = L.marker([centLat, centLng], { icon: castleIcon, interactive: false });
              fortGroup.addLayer(marker);
            }
          }
        } catch (_) {}
      }
    }
  }, [fortifications, territories]);

  const handleZoomIn = () => {
    mapRef.current?.zoomIn();
  };

  const handleZoomOut = () => {
    mapRef.current?.zoomOut();
  };

  const createLocationIcon = (heading: number | null) => {
    const hasHeading = heading !== null;
    const rotation = hasHeading ? heading : 0;
    return L.divIcon({
      className: 'current-location-marker',
      html: `
        <div style="width:48px;height:48px;position:relative;display:flex;align-items:center;justify-content:center;">
          <div style="position:absolute;width:40px;height:40px;left:4px;top:4px;border-radius:50%;background:rgba(66,133,244,0.15);animation:location-pulse 2s ease-out infinite;"></div>
          ${hasHeading ? `
            <svg class="location-arrow" width="28" height="28" viewBox="0 0 32 32" style="transform:rotate(${rotation}deg);position:relative;z-index:2;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.4));">
              <path d="M16 2L6 28L16 20L26 28L16 2Z" fill="#4285F4" stroke="white" stroke-width="2" stroke-linejoin="round"/>
            </svg>
          ` : `
            <div style="width:16px;height:16px;border-radius:50%;background:#4285F4;border:3px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);position:relative;z-index:2;"></div>
          `}
        </div>
      `,
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    });
  };

  const setupHeadingWatch = () => {
    // Clean up any existing handler
    if (orientationHandlerRef.current) {
      window.removeEventListener('deviceorientation', orientationHandlerRef.current, true);
      window.removeEventListener('deviceorientationabsolute', orientationHandlerRef.current, true);
    }

    const handler = (event: Event) => {
      const e = event as DeviceOrientationEvent;
      let heading: number | null = null;
      // iOS Safari provides webkitCompassHeading
      if ((e as any).webkitCompassHeading !== undefined) {
        heading = (e as any).webkitCompassHeading as number;
      } else if (e.alpha !== null && e.alpha !== undefined) {
        // Android/standard: alpha is counterclockwise from north
        heading = (360 - e.alpha) % 360;
      }
      if (heading !== null && locationMarkerRef.current) {
        headingRef.current = heading;
        // Update arrow rotation via DOM without recreating the entire icon
        const arrowEl = locationMarkerRef.current.getElement()?.querySelector('.location-arrow') as HTMLElement;
        if (arrowEl) {
          // The arrow is inside mapPane which is CSS-rotated by -bearing,
          // so just use the raw heading — parent rotation handles compensation.
          arrowEl.style.transform = `rotate(${heading}deg)`;
        } else {
          // First heading received — switch from dot to arrow
          locationMarkerRef.current.setIcon(createLocationIcon(heading));
        }
      }
    };

    orientationHandlerRef.current = handler;

    // Prefer deviceorientationabsolute (Android Chrome) for true compass heading
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', handler, true);
    } else {
      window.addEventListener('deviceorientation', handler, true);
    }
  };

  // Cleanup heading watch + position watch on unmount
  useEffect(() => {
    return () => {
      if (orientationHandlerRef.current) {
        window.removeEventListener('deviceorientation', orientationHandlerRef.current, true);
        window.removeEventListener('deviceorientationabsolute', orientationHandlerRef.current, true);
      }
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      if (locationMarkerRef.current) {
        locationMarkerRef.current.remove();
        locationMarkerRef.current = null;
      }
    };
  }, []);

  const handleLocate = async () => {
    setIsLocating(true);
    try {
      // 1. Request iOS orientation permission only ONCE (cached in ref + sessionStorage)
      if (!orientationGrantedRef.current) {
        try {
          if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
            const perm = await (DeviceOrientationEvent as any).requestPermission();
            orientationGrantedRef.current = perm === 'granted';
            if (perm === 'granted') sessionStorage.setItem('orientation-granted', '1');
          } else {
            orientationGrantedRef.current = true; // Android/desktop — no permission needed
          }
        } catch {
          orientationGrantedRef.current = false;
        }
      }

      // 2. Get current position
      const position = await getCurrentPosition();
      mapRef.current?.setView([position.lat, position.lng], Math.max(mapRef.current.getZoom(), 16));

      const icon = createLocationIcon(headingRef.current);

      if (locationMarkerRef.current) {
        locationMarkerRef.current.setLatLng([position.lat, position.lng]);
        locationMarkerRef.current.setIcon(icon);
      } else {
        locationMarkerRef.current = L.marker([position.lat, position.lng], {
          icon,
          zIndexOffset: 9999,
          interactive: false,
        }).addTo(mapRef.current!);
      }

      // 3. Start watching heading (only once)
      if (orientationGrantedRef.current && !orientationHandlerRef.current) {
        setupHeadingWatch();
      }

      // 4. Start continuous position watch if not already watching
      if (watchIdRef.current === null && navigator.geolocation) {
        watchIdRef.current = navigator.geolocation.watchPosition(
          (pos) => {
            const latlng: L.LatLngExpression = [pos.coords.latitude, pos.coords.longitude];
            if (locationMarkerRef.current) {
              locationMarkerRef.current.setLatLng(latlng);
            }
          },
          () => {},
          { enableHighAccuracy: true }
        );
      }

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
        {/* Compass / Reset North — only visible when map is rotated */}
        {bearing > 0.5 && (
          <Button
            size="icon"
            variant="secondary"
            onClick={resetBearing}
            className="shadow-md bg-card/95 backdrop-blur-md border border-border"
            title="Restablecer norte"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" style={{ transform: `rotate(${-bearing}deg)`, transition: 'transform 0.2s ease' }}>
              <polygon points="12,2 8,14 12,11 16,14" fill="#ef4444" />
              <polygon points="12,22 8,14 12,17 16,14" fill="#9ca3af" />
            </svg>
          </Button>
        )}
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
        
        .leaflet-container {
          background: ${mapStyle === 'dark' ? '#000000' : '#e8e8e6'} !important;
        }
        
        .leaflet-tile {
          will-change: transform;
        }
        .leaflet-tile-container {
          will-change: transform;
          backface-visibility: hidden;
        }
        .leaflet-tile-loaded {
          opacity: 1 !important;
        }
        
        .leaflet-overlay-pane canvas,
        .leaflet-canvas-container {
          overflow: visible;
        }

        /* When map is rotated, disable Leaflet's zoom CSS transition on the
           mapPane to prevent visible pulse/flash during zoom+rotate. */
        ${bearing > 0.5 ? `
        .leaflet-zoom-anim .leaflet-zoom-animated {
          transition: none !important;
        }
        /* Counter-rotate marker & popup CONTENT so they stay upright.
           We target > div (inner content) rather than the wrapper itself
           because the wrapper carries Leaflet's translate3d positioning. */
        .treasure-marker > div,
        .fortification-castle-icon > div,
        .leaflet-popup {
          transform: rotate(${bearing}deg) !important;
        }
        ` : ''}
        
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

        @keyframes location-pulse {
          0% { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(2.2); opacity: 0; }
        }

        .current-location-marker {
          background: none !important;
          border: none !important;
        }
        
        @keyframes treasure-pulse {
          0%, 100% { transform: scale(1); opacity: 0.6; }
          50% { transform: scale(1.6); opacity: 0; }
        }
        
        .treasure-marker {
          background: none !important;
          border: none !important;
        }
      `}</style>
    </div>
  );
}
