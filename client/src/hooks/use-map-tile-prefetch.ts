import { useEffect } from 'react';
import type L from 'leaflet';

/**
 * Hook to prefetch adjacent map tiles for smoother panning
 * Preloads tiles around the current viewport
 */
export function useMapTilePrefetch(
  mapRef: React.RefObject<L.Map | null>,
  enabled: boolean = true
) {
  useEffect(() => {
    if (!enabled || !mapRef.current) return;

    const map = mapRef.current;
    let prefetchTimeout: NodeJS.Timeout;

    const prefetchAdjacentTiles = () => {
      // Clear any pending prefetch
      clearTimeout(prefetchTimeout);

      // Wait for map to settle before prefetching (avoid prefetching during pan/zoom)
      prefetchTimeout = setTimeout(() => {
        const bounds = map.getBounds();
        const zoom = map.getZoom();
        
        // Expand bounds to prefetch tiles around current view
        const expandedBounds = bounds.pad(0.5); // 50% padding = 1.5x viewport
        
        // Get current tile layer
        const tileLayers: L.TileLayer[] = [];
        map.eachLayer((layer) => {
          if (layer instanceof (window as any).L.TileLayer) {
            tileLayers.push(layer as L.TileLayer);
          }
        });

        // Prefetch tiles for expanded bounds
        tileLayers.forEach((tileLayer) => {
          const tileSize = (tileLayer as any).options.tileSize || 256;
          const nwPoint = map.project(expandedBounds.getNorthWest(), zoom);
          const sePoint = map.project(expandedBounds.getSouthEast(), zoom);

          const nwTile = {
            x: Math.floor(nwPoint.x / tileSize),
            y: Math.floor(nwPoint.y / tileSize),
          };
          const seTile = {
            x: Math.floor(sePoint.x / tileSize),
            y: Math.floor(sePoint.y / tileSize),
          };

          // Limit prefetch to reasonable area (max 100 tiles)
          const tilesX = Math.min(seTile.x - nwTile.x + 1, 10);
          const tilesY = Math.min(seTile.y - nwTile.y + 1, 10);

          // Create Image elements to trigger prefetch through service worker
          const urlTemplate = (tileLayer as any)._url;
          const subdomains = (tileLayer as any).options.subdomains || ['a', 'b', 'c'];
          
          for (let x = nwTile.x; x < nwTile.x + tilesX; x++) {
            for (let y = nwTile.y; y < nwTile.y + tilesY; y++) {
              // Only prefetch tiles not in viewport (viewport tiles load automatically)
              const subdomain = subdomains[Math.abs(x + y) % subdomains.length];
              const url = urlTemplate
                .replace('{s}', subdomain)
                .replace('{z}', String(zoom))
                .replace('{x}', String(x))
                .replace('{y}', String(y))
                .replace('{r}', '');

              // Create image to trigger fetch + cache
              const img = new Image();
              img.src = url;
            }
          }
        });
      }, 500); // Wait 500ms after map movement stops
    };

    // Listen to map events
    map.on('moveend', prefetchAdjacentTiles);
    map.on('zoomend', prefetchAdjacentTiles);

    // Initial prefetch
    prefetchAdjacentTiles();

    return () => {
      clearTimeout(prefetchTimeout);
      map.off('moveend', prefetchAdjacentTiles);
      map.off('zoomend', prefetchAdjacentTiles);
    };
  }, [mapRef, enabled]);
}
