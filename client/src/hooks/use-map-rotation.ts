/**
 * useMapRotation — lightweight custom two-finger map rotation for Leaflet.
 *
 * Design:
 *  - Patches ONLY the map instance (not global L prototype)
 *  - CSS transform rotate() on mapPane
 *  - During gesture: DOM-only, zero React re-renders
 *  - During zoom animation: skip rotation transform to avoid decentering
 *  - Forces canvas redraw when rotation starts so vector layers cover corners
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import L from 'leaflet';

/* ── helpers ─────────────────────────────────────────────────────────── */

function touchAngle(t1: Touch, t2: Touch): number {
  return Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX) * 180 / Math.PI;
}

function rotatePoint(p: L.Point, center: L.Point, deg: number): L.Point {
  const rad = deg * Math.PI / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return L.point(dx * c - dy * s + center.x, dx * s + dy * c + center.y);
}

/** Force all canvas/vector layers in the map to redraw */
function forceLayerRedraw(map: L.Map) {
  map.eachLayer((layer: any) => {
    if (layer._reset) layer._reset();
    if (layer._update) layer._update();
    if (layer.redraw) layer.redraw();
  });
}

/* ── hook ────────────────────────────────────────────────────────────── */

export function useMapRotation(mapRef: React.MutableRefObject<L.Map | null>, mapReady?: number) {
  const [bearing, setBearingState] = useState(0);
  const bearingRef = useRef(0);

  const startAngleRef = useRef<number | null>(null);
  const startBearingRef = useRef(0);
  const isRotatingRef = useRef(false);
  const didRedrawRef = useRef(false); // tracks if we've redrawn at new bearing
  const isZoomingRef = useRef(false);

  const patchedRef = useRef(false);
  const rafRef = useRef(0);

  /* ── Apply CSS rotation to mapPane ───────────────────────────────── */
  const applyRotation = useCallback(
    (deg: number) => {
      const map = mapRef.current;
      if (!map) return;
      const pane = map.getPane('mapPane');
      if (!pane) return;

      const pos = L.DomUtil.getPosition(pane);
      const center = map.getSize().divideBy(2);
      pane.style.transformOrigin = `${center.x - pos.x}px ${center.y - pos.y}px`;

      if (deg === 0) {
        pane.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
      } else {
        pane.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0) rotate(${-deg}deg)`;
      }
    },
    [mapRef],
  );

  /* ── Fast DOM-only setter (for gesture frames) ───────────────────── */
  const setBearingFast = useCallback(
    (deg: number) => {
      deg = ((deg % 360) + 360) % 360;
      bearingRef.current = deg;
      applyRotation(deg);
    },
    [applyRotation],
  );

  /* ── Commit to React state (called once on gesture end) ──────────── */
  const commitBearing = useCallback(
    (deg: number) => {
      deg = ((deg % 360) + 360) % 360;
      bearingRef.current = deg;
      applyRotation(deg);
      setBearingState(deg);
      mapRef.current?.fire('rotate', { bearing: deg });
    },
    [applyRotation, mapRef],
  );

  const resetBearing = useCallback(() => {
    commitBearing(0);
    const map = mapRef.current;
    if (map) {
      map.invalidateSize();
      map.fire('moveend');
      forceLayerRedraw(map);
    }
  }, [commitBearing, mapRef]);

  /* ── Patch Leaflet + gesture listeners ───────────────────────────── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || patchedRef.current) return;
    patchedRef.current = true;

    const mapPane = map.getPane('mapPane')!;

    // ─── 1. Intercept setTransform ───────────────────────────────────
    // During zoom animation Leaflet calls setTransform with scale != 1.
    // If we inject rotation during that, the transformOrigin conflicts
    // with zoom animation's own origin, causing decentering.
    // FIX: skip rotation when scale != 1 (zoom animation in progress).
    // The rotation re-applies on zoomend via our event listener.
    const origSetTransform = L.DomUtil.setTransform;

    const patchedFn = function (
      this: typeof L.DomUtil,
      el: HTMLElement,
      offset?: L.Point,
      scale?: number,
    ) {
      if (el === mapPane && bearingRef.current !== 0) {
        // During zoom animation (scale != 1), let Leaflet do its
        // standard transform without rotation to avoid decentering
        if (scale !== undefined && scale !== 1) {
          origSetTransform.call(L.DomUtil, el, offset as L.Point, scale);
          return;
        }

        const pos = offset || L.point(0, 0);
        const deg = bearingRef.current;
        const center = map.getSize().divideBy(2);

        el.style.transformOrigin = `${center.x - pos.x}px ${center.y - pos.y}px`;
        el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0) rotate(${-deg}deg)`;
        return;
      }
      origSetTransform.call(L.DomUtil, el, offset as L.Point, scale);
    };
    L.DomUtil.setTransform = patchedFn as typeof L.DomUtil.setTransform;

    // ─── 2. Coordinate transforms for correct click/tap ─────────────
    const origC2L = map.containerPointToLayerPoint.bind(map);
    const origL2C = map.layerPointToContainerPoint.bind(map);

    (map as any).containerPointToLayerPoint = function (pt: L.PointExpression) {
      const p = L.point(pt);
      if (bearingRef.current === 0) return origC2L(p);
      const center = map.getSize().divideBy(2);
      return origC2L(rotatePoint(p, center, bearingRef.current));
    };

    (map as any).layerPointToContainerPoint = function (pt: L.PointExpression) {
      const p: L.Point = origL2C(L.point(pt));
      if (bearingRef.current === 0) return p;
      const center = map.getSize().divideBy(2);
      return rotatePoint(p, center, -bearingRef.current);
    };

    // ─── 3. Expand pixel bounds for rotated viewport ─────────────────
    // Always expand by a generous margin so tiles AND canvas layers
    // are pre-rendered large enough to cover any rotation angle.
    const origGetPixelBounds = (map.getPixelBounds as any).bind(map);

    (map as any).getPixelBounds = function (c?: L.LatLng, z?: number) {
      const bounds: L.Bounds = origGetPixelBounds(c, z);
      if (bearingRef.current === 0) return bounds;

      // Calculate rotated bounding box of the viewport
      const size = map.getSize();
      const rad = Math.abs(bearingRef.current) * Math.PI / 180;
      const cosV = Math.abs(Math.cos(rad));
      const sinV = Math.abs(Math.sin(rad));
      const rotW = size.x * cosV + size.y * sinV;
      const rotH = size.x * sinV + size.y * cosV;
      // Add generous margin (128px) for tile loading boundaries
      const expandX = Math.ceil(Math.max(0, rotW - size.x) / 2) + 128;
      const expandY = Math.ceil(Math.max(0, rotH - size.y) / 2) + 128;

      return L.bounds(
        L.point(bounds.min!.x - expandX, bounds.min!.y - expandY),
        L.point(bounds.max!.x + expandX, bounds.max!.y + expandY),
      );
    };

    // ─── 4. Track zoom animation to avoid conflicts ──────────────────
    map.on('zoomanim', () => { isZoomingRef.current = true; });
    map.on('zoomend', () => {
      isZoomingRef.current = false;
      // Reapply rotation after zoom completes
      if (bearingRef.current !== 0) {
        applyRotation(bearingRef.current);
        forceLayerRedraw(map);
      }
    });

    // ─── 5. Re-apply rotation after view changes ────────────────────
    const reapply = () => {
      if (bearingRef.current !== 0 && !isZoomingRef.current) {
        applyRotation(bearingRef.current);
      }
    };
    map.on('moveend resize', reapply);

    // ─── 6. Two-finger rotation gesture ──────────────────────────────
    const container = map.getContainer();

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        startAngleRef.current = touchAngle(e.touches[0], e.touches[1]);
        startBearingRef.current = bearingRef.current;
        isRotatingRef.current = false;
        didRedrawRef.current = false;
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (e.touches.length !== 2 || startAngleRef.current === null) return;

      const angle = touchAngle(e.touches[0], e.touches[1]);
      const rawDelta = angle - startAngleRef.current;

      if (!isRotatingRef.current) {
        if (Math.abs(rawDelta) < 5) return;
        isRotatingRef.current = true;
        startAngleRef.current = angle;
        startBearingRef.current = bearingRef.current;

        // When rotation starts, immediately force canvas layers to
        // redraw with expanded bounds based on current bearing.
        // This ensures vector layers cover the corners.
        if (!didRedrawRef.current && mapRef.current) {
          didRedrawRef.current = true;
          mapRef.current.fire('moveend');
          forceLayerRedraw(mapRef.current);
        }
        return;
      }

      const delta = angle - startAngleRef.current;
      setBearingFast(startBearingRef.current - delta);
    }

    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) {
        if (isRotatingRef.current) {
          const b = bearingRef.current;
          if (b < 10 || b > 350) {
            commitBearing(0);
          } else {
            commitBearing(b);
          }
          // Final redraw at settled bearing
          cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(() => {
            if (map) {
              map.fire('moveend');
              forceLayerRedraw(map);
            }
          });
        }
        isRotatingRef.current = false;
        startAngleRef.current = null;
      }
    }

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    container.addEventListener('touchend', onTouchEnd, { passive: true });

    // ─── Cleanup ─────────────────────────────────────────────────────
    const cleanup = () => {
      if (L.DomUtil.setTransform === (patchedFn as any)) {
        L.DomUtil.setTransform = origSetTransform;
      }
      (map as any).containerPointToLayerPoint = origC2L;
      (map as any).layerPointToContainerPoint = origL2C;
      (map as any).getPixelBounds = origGetPixelBounds;
      map.off('moveend resize', reapply);
      map.off('zoomanim');
      map.off('zoomend');

      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);

      const pos = L.DomUtil.getPosition(mapPane);
      mapPane.style.transformOrigin = '';
      mapPane.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;

      patchedRef.current = false;
    };

    return cleanup;
  }, [mapRef, mapReady, setBearingFast, commitBearing, applyRotation]);

  return { bearing, bearingRef, setBearing: commitBearing, resetBearing };
}
