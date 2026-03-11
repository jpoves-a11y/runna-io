/**
 * useMapRotation — lightweight custom two-finger map rotation for Leaflet.
 *
 * Instead of the heavy leaflet-rotate plugin (UMD incompatible with Vite, huge
 * canvas padding, disabled animations), this hook:
 *  1. Patches only the map INSTANCE methods (not global L prototype)
 *  2. Uses CSS transform on the map pane with correct transformOrigin
 *  3. Detects two-finger rotation gesture natively
 *  4. Expands pixel bounds so tiles load correctly for rotated viewport
 *  5. Keeps ALL Leaflet animations enabled
 *  6. Canvas padding stays at 0.8 (≈5.8× area vs 49× with padding 3.0)
 *
 * Usage:
 *   const { bearing, resetBearing } = useMapRotation(mapRef);
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import L from 'leaflet';

/* ── helpers ─────────────────────────────────────────────────────────── */

/** Angle (degrees) of the line between two touch points — increases CW in screen-coords */
function touchAngle(t1: Touch, t2: Touch): number {
  return Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX) * 180 / Math.PI;
}

/** Rotate a Leaflet Point around a centre by `deg` degrees (CW in screen-coords) */
function rotatePoint(p: L.Point, center: L.Point, deg: number): L.Point {
  const rad = deg * Math.PI / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return L.point(dx * c - dy * s + center.x, dx * s + dy * c + center.y);
}

/* ── hook ────────────────────────────────────────────────────────────── */

export function useMapRotation(mapRef: React.MutableRefObject<L.Map | null>, mapReady?: number) {
  const [bearing, setBearingState] = useState(0);
  const bearingRef = useRef(0);

  // Touch-gesture state
  const startAngleRef = useRef<number | null>(null);
  const startBearingRef = useRef(0);
  const isRotatingRef = useRef(false);

  // Guards
  const patchedRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const rafRef = useRef(0);

  /* ── Apply CSS rotation to the map pane ──────────────────────────── */
  const applyRotation = useCallback(
    (deg: number) => {
      const map = mapRef.current;
      if (!map) return;
      const pane = map.getPane('mapPane');
      if (!pane) return;

      const pos = L.DomUtil.getPosition(pane);
      const center = map.getSize().divideBy(2);

      // Origin = viewport centre, expressed relative to the pane element
      pane.style.transformOrigin = `${center.x - pos.x}px ${center.y - pos.y}px`;

      if (deg === 0) {
        pane.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
      } else {
        pane.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0) rotate(${-deg}deg)`;
      }
    },
    [mapRef],
  );

  /* ── Public setter ───────────────────────────────────────────────── */
  const setBearing = useCallback(
    (deg: number) => {
      deg = ((deg % 360) + 360) % 360;
      bearingRef.current = deg;
      applyRotation(deg);

      // Coalesce React state + Leaflet event to 1/frame
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        setBearingState(deg);
        mapRef.current?.fire('rotate', { bearing: deg });
      });
    },
    [applyRotation, mapRef],
  );

  const resetBearing = useCallback(() => {
    setBearing(0);
    // Also force a tile refresh after resetting
    mapRef.current?.invalidateSize();
  }, [setBearing, mapRef]);

  /* ── Patch Leaflet + attach gesture listeners ────────────────────── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || patchedRef.current) return;
    patchedRef.current = true;

    const mapPane = map.getPane('mapPane')!;

    // ─── 1. Intercept setTransform so Leaflet's own panning always
    //        includes our rotation (setTransform is called by setPosition
    //        on every pan frame). ───────────────────────────────────────
    const origSetTransform = L.DomUtil.setTransform;

    const patchedFn = function (
      this: typeof L.DomUtil,
      el: HTMLElement,
      offset?: L.Point,
      scale?: number,
    ) {
      if (el === mapPane && bearingRef.current !== 0) {
        const pos = offset || L.point(0, 0);
        const deg = bearingRef.current;
        const center = map.getSize().divideBy(2);

        el.style.transformOrigin = `${center.x - pos.x}px ${center.y - pos.y}px`;

        const translate = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
        const rotate = `rotate(${-deg}deg)`;
        const sc = scale !== undefined && scale !== 1 ? ` scale(${scale})` : '';
        el.style.transform = `${translate} ${rotate}${sc}`;
        return;
      }
      origSetTransform.call(L.DomUtil, el, offset as L.Point, scale);
    };
    L.DomUtil.setTransform = patchedFn as typeof L.DomUtil.setTransform;

    // ─── 2. Coordinate transforms ─────────────────────────────────────
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

    // ─── 3. Expand pixel bounds so tiles cover the rotated viewport ──
    const origGetPixelBounds = (map.getPixelBounds as any).bind(map);

    (map as any).getPixelBounds = function (c?: L.LatLng, z?: number) {
      const bounds: L.Bounds = origGetPixelBounds(c, z);
      if (bearingRef.current === 0) return bounds;

      const size = map.getSize();
      const rad = bearingRef.current * Math.PI / 180;
      const cosV = Math.abs(Math.cos(rad));
      const sinV = Math.abs(Math.sin(rad));
      const rotW = size.x * cosV + size.y * sinV;
      const rotH = size.x * sinV + size.y * cosV;
      const expandX = Math.ceil(Math.max(0, rotW - size.x) / 2);
      const expandY = Math.ceil(Math.max(0, rotH - size.y) / 2);

      return L.bounds(
        L.point(bounds.min!.x - expandX, bounds.min!.y - expandY),
        L.point(bounds.max!.x + expandX, bounds.max!.y + expandY),
      );
    };

    // ─── 4. Re-apply rotation after every Leaflet view update ────────
    const reapply = () => {
      if (bearingRef.current !== 0) applyRotation(bearingRef.current);
    };
    map.on('moveend zoomend resize', reapply);

    // ─── 5. Two-finger rotation gesture ──────────────────────────────
    const container = map.getContainer();

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        startAngleRef.current = touchAngle(e.touches[0], e.touches[1]);
        startBearingRef.current = bearingRef.current;
        isRotatingRef.current = false;
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (e.touches.length !== 2 || startAngleRef.current === null) return;

      const angle = touchAngle(e.touches[0], e.touches[1]);
      const rawDelta = angle - startAngleRef.current;

      if (!isRotatingRef.current) {
        // Dead-zone of 3° prevents accidental rotation during pinch-zoom
        if (Math.abs(rawDelta) < 3) return;
        isRotatingRef.current = true;
        // Reset reference so the rotation starts smoothly from here
        startAngleRef.current = angle;
        startBearingRef.current = bearingRef.current;
        return;
      }

      const delta = angle - startAngleRef.current;
      setBearing(startBearingRef.current + delta);
    }

    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) {
        if (isRotatingRef.current) {
          // Snap to north if within 7°
          const b = bearingRef.current;
          if (b < 7 || b > 353) setBearing(0);
          // Force tile reload for final rotation
          map!.fire('moveend');
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
      // Restore global setTransform only if we are still the active patcher
      if (L.DomUtil.setTransform === (patchedFn as any)) {
        L.DomUtil.setTransform = origSetTransform;
      }
      // Restore coordinate methods
      (map as any).containerPointToLayerPoint = origC2L;
      (map as any).layerPointToContainerPoint = origL2C;
      (map as any).getPixelBounds = origGetPixelBounds;

      map.off('moveend zoomend resize', reapply);

      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);

      // Remove rotation from pane
      const pos = L.DomUtil.getPosition(mapPane);
      mapPane.style.transformOrigin = '';
      mapPane.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;

      patchedRef.current = false;
    };

    cleanupRef.current = cleanup;
    return cleanup;
  }, [mapRef, mapReady, setBearing, applyRotation]);

  return { bearing, bearingRef, setBearing, resetBearing };
}
