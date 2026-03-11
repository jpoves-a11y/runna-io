/**
 * useMapRotation — lightweight two-finger map rotation for Leaflet.
 *
 * IMPORTANT: Only patches L.DomUtil.setTransform (for CSS rotation during pan)
 * and map.mouseEventToContainerPoint (for correct click detection).
 *
 * We intentionally do NOT patch containerPointToLayerPoint or getPixelBounds
 * because those methods are used internally by the Canvas renderer to calculate
 * its own _bounds. Patching them with rotated coordinates causes the canvas to
 * be positioned incorrectly, making polygons/areas invisible after rotation.
 *
 * Instead we rely on:
 *  - Canvas renderer padding (1.5) to pre-render beyond the viewport
 *  - CSS overflow:visible on canvas panes
 *  - Force layer redraws after rotation settles
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

  /* ── Fast DOM-only setter (for gesture frames, no React state) ───── */
  const setBearingFast = useCallback(
    (deg: number) => {
      deg = ((deg % 360) + 360) % 360;
      bearingRef.current = deg;
      applyRotation(deg);
    },
    [applyRotation],
  );

  /* ── Commit to React state (called once on touchEnd) ─────────────── */
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

    // ─── 1. Intercept setTransform so panning preserves rotation ─────
    // During zoom animation (scale != 1), skip rotation to avoid
    // decentering — the rotation reapplies on zoomend.
    const origSetTransform = L.DomUtil.setTransform;

    const patchedFn = function (
      this: typeof L.DomUtil,
      el: HTMLElement,
      offset?: L.Point,
      scale?: number,
    ) {
      if (el === mapPane && bearingRef.current !== 0) {
        if (scale !== undefined && scale !== 1) {
          // Zoom animation in progress — let Leaflet handle it normally
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

    // ─── 2. Fix click/tap detection on rotated maps ──────────────────
    // We patch mouseEventToContainerPoint (used by Canvas._onClick and
    // all Leaflet event processing) to rotate the input coordinates.
    // This does NOT affect canvas renderer bounds calculation (which
    // uses containerPointToLayerPoint internally — left unpatched).
    const origMouseToContainer = map.mouseEventToContainerPoint.bind(map);
    (map as any).mouseEventToContainerPoint = function (e: MouseEvent) {
      const pt: L.Point = origMouseToContainer(e);
      if (bearingRef.current === 0) return pt;
      const center = map.getSize().divideBy(2);
      return rotatePoint(pt, center, bearingRef.current);
    };

    // ─── 3. Track zoom to avoid conflicts ────────────────────────────
    const onZoomAnim = () => { isZoomingRef.current = true; };
    const onZoomEnd = () => {
      isZoomingRef.current = false;
      if (bearingRef.current !== 0) {
        applyRotation(bearingRef.current);
        forceLayerRedraw(map);
      }
    };
    map.on('zoomanim', onZoomAnim);
    map.on('zoomend', onZoomEnd);

    // ─── 4. Re-apply rotation after pan/resize ──────────────────────
    const reapply = () => {
      if (bearingRef.current !== 0 && !isZoomingRef.current) {
        applyRotation(bearingRef.current);
      }
    };
    map.on('moveend resize', reapply);

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
        if (Math.abs(rawDelta) < 5) return; // dead-zone
        isRotatingRef.current = true;
        startAngleRef.current = angle;
        startBearingRef.current = bearingRef.current;
        return;
      }

      const delta = angle - startAngleRef.current;
      // CW fingers → positive delta → subtract → decreasing bearing →
      // CSS rotate(-(negative)) = rotate(+) = CW visual ✓
      setBearingFast(startBearingRef.current - delta);
    }

    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) {
        if (isRotatingRef.current) {
          const b = bearingRef.current;
          // Snap to north if within 10°
          if (b < 10 || b > 350) {
            commitBearing(0);
          } else {
            commitBearing(b);
          }
          // Force full redraw at final bearing
          cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(() => {
            const m = mapRef.current;
            if (m) {
              m.fire('moveend');
              forceLayerRedraw(m);
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
    return () => {
      if (L.DomUtil.setTransform === (patchedFn as any)) {
        L.DomUtil.setTransform = origSetTransform;
      }
      (map as any).mouseEventToContainerPoint = origMouseToContainer;

      map.off('zoomanim', onZoomAnim);
      map.off('zoomend', onZoomEnd);
      map.off('moveend resize', reapply);

      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);

      const pos = L.DomUtil.getPosition(mapPane);
      mapPane.style.transformOrigin = '';
      mapPane.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;

      patchedRef.current = false;
    };
  }, [mapRef, mapReady, setBearingFast, commitBearing, applyRotation]);

  return { bearing, bearingRef, setBearing: commitBearing, resetBearing };
}
