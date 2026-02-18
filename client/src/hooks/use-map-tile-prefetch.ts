import { useEffect, useRef } from 'react';
import type L from 'leaflet';

/**
 * Hook to prefetch adjacent map tiles for smoother panning
 * Preloads tiles around the current viewport DURING movement
 * Also prefetches adjacent zoom levels for smooth zoom transitions
 */
export function useMapTilePrefetch(
  mapRef: React.RefObject<L.Map | null>,
  enabled: boolean = true
) {
  const prefetchedUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled || !mapRef.current) return;

    const map = mapRef.current;
    let prefetchTimeout: NodeJS.Timeout;
    let isMoving = false;
    // Cap the cache of tracked urls to prevent memory bloat
    const MAX_TRACKED_URLS = 2000;

    const prefetchTilesForBounds = (
      bounds: L.LatLngBounds,
      zoom: number,
      urlTemplate: string,
      subdomains: string[]
    ) => {
      const tileSize = 256;
      const nwPoint = map.project(bounds.getNorthWest(), zoom);
      const sePoint = map.project(bounds.getSouthEast(), zoom);

      const nwTile = {
        x: Math.floor(nwPoint.x / tileSize),
        y: Math.floor(nwPoint.y / tileSize),
      };
      const seTile = {
        x: Math.floor(sePoint.x / tileSize),
        y: Math.floor(sePoint.y / tileSize),
      };

      // Limit prefetch to reasonable area (max 144 tiles per zoom level)
      const tilesX = Math.min(seTile.x - nwTile.x + 1, 12);
      const tilesY = Math.min(seTile.y - nwTile.y + 1, 12);

      for (let x = nwTile.x; x < nwTile.x + tilesX; x++) {
        for (let y = nwTile.y; y < nwTile.y + tilesY; y++) {
          const subdomain = subdomains[Math.abs(x + y) % subdomains.length];
          const url = urlTemplate
            .replace('{s}', subdomain)
            .replace('{z}', String(zoom))
            .replace('{x}', String(x))
            .replace('{y}', String(y))
            .replace('{r}', '');

          // Skip already-prefetched URLs
          if (prefetchedUrlsRef.current.has(url)) continue;
          prefetchedUrlsRef.current.add(url);

          // Trim tracked set if too large
          if (prefetchedUrlsRef.current.size > MAX_TRACKED_URLS) {
            const iter = prefetchedUrlsRef.current.values();
            for (let i = 0; i < 500; i++) iter.next();
            // Reset - let it rebuild naturally
            prefetchedUrlsRef.current = new Set();
          }

          // Use Image() to trigger the fetch through the service worker cache
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.src = url;
        }
      }
    };

    const prefetchAdjacentTiles = (immediate: boolean = false) => {
      clearTimeout(prefetchTimeout);

      const delay = immediate ? 30 : 150; // 30ms during movement, 150ms after stopping
      
      prefetchTimeout = setTimeout(() => {
        const bounds = map.getBounds();
        const zoom = Math.round(map.getZoom());
        
        // Expand bounds generously - 75% padding = 1.75x viewport coverage
        const expandedBounds = bounds.pad(0.75);
        
        // Get tile layer info
        const tileLayers: L.TileLayer[] = [];
        map.eachLayer((layer) => {
          if (layer instanceof (window as any).L.TileLayer) {
            tileLayers.push(layer as L.TileLayer);
          }
        });

        tileLayers.forEach((tileLayer) => {
          const urlTemplate = (tileLayer as any)._url;
          const subdomains = (tileLayer as any).options.subdomains || ['a', 'b', 'c', 'd'];
          
          // Prefetch current zoom level with expanded bounds
          prefetchTilesForBounds(expandedBounds, zoom, urlTemplate, subdomains);
          
          // Also prefetch zoom-1 (zoomed out a bit) for smooth zoom out
          if (zoom > 3) {
            prefetchTilesForBounds(bounds.pad(0.3), zoom - 1, urlTemplate, subdomains);
          }
          
          // Also prefetch zoom+1 (zoomed in a bit) for smooth zoom in
          if (zoom < 19) {
            prefetchTilesForBounds(bounds, zoom + 1, urlTemplate, subdomains);
          }
        });
      }, delay);
    };

    const handleMoveStart = () => {
      isMoving = true;
    };

    const handleMoveEnd = () => {
      isMoving = false;
      prefetchAdjacentTiles(false);
    };

    const handleMove = () => {
      if (isMoving) {
        prefetchAdjacentTiles(true);
      }
    };

    // Listen to map events
    map.on('movestart', handleMoveStart);
    map.on('zoomstart', handleMoveStart);
    map.on('move', handleMove);
    map.on('zoom', handleMove);
    map.on('moveend', handleMoveEnd);
    map.on('zoomend', handleMoveEnd);

    // Initial prefetch with adjacent zoom levels
    prefetchAdjacentTiles(false);

    return () => {
      clearTimeout(prefetchTimeout);
      map.off('movestart', handleMoveStart);
      map.off('zoomstart', handleMoveStart);
      map.off('move', handleMove);
      map.off('zoom', handleMove);
      map.off('moveend', handleMoveEnd);
      map.off('zoomend', handleMoveEnd);
    };
  }, [mapRef, enabled]);
}
