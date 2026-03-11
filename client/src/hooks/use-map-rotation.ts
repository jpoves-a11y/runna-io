/**
 * useMapRotation — lightweight two-finger map rotation for Leaflet.
 *
 * Patches:
 *  1. L.DomUtil.setTransform — CSS rotation during pan
 *  2. map.mouseEventToContainerPoint — correct click detection on rotated map
 *  3. map.getPixelBounds — expand tile/canvas loading to cover rotated viewport
 *
 * We intentionally do NOT patch containerPointToLayerPoint because it's used
 * by the Canvas renderer to calculate internal _bounds. Patching it causes the
 * canvas to be positioned incorrectly, making polygons/areas invisible.
 *
 * Also relies on:
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
    // Only call redraw() on non-tile layers (canvas/SVG overlays).
    // TileLayer.redraw() removes ALL tiles then re-fetches → visible flash.
    if (layer.redraw && !(layer instanceof L.TileLayer)) layer.redraw();
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

    // ─── 3. Expand pixel bounds so tiles + canvas cover rotated viewport
    // This tells Leaflet's TileLayer and Canvas renderer to load/render
    // a larger area that covers the corners exposed by CSS rotation.
    const origGetPixelBounds = (map.getPixelBounds as any).bind(map);

    (map as any).getPixelBounds = function (c?: L.LatLng, z?: number) {
      const bounds: L.Bounds = origGetPixelBounds(c, z);
      if (bearingRef.current === 0) return bounds;

      const size = map.getSize();
      const rad = Math.abs(bearingRef.current) * Math.PI / 180;
      const cosV = Math.abs(Math.cos(rad));
      const sinV = Math.abs(Math.sin(rad));
      const rotW = size.x * cosV + size.y * sinV;
      const rotH = size.x * sinV + size.y * cosV;
      const expandX = Math.ceil(Math.max(0, rotW - size.x) / 2) + 128;
      const expandY = Math.ceil(Math.max(0, rotH - size.y) / 2) + 128;

      return L.bounds(
        L.point(bounds.min!.x - expandX, bounds.min!.y - expandY),
        L.point(bounds.max!.x + expandX, bounds.max!.y + expandY),
      );
    };

    // ─── 4. Correct drag direction on rotated map ────────────────────
    // Leaflet's drag computes screen-space offsets but our CSS applies
    // translate THEN rotate, so the visual movement gets rotated by -θ.
    // Rotating the drag offset by +θ in predrag cancels this out.
    const draggable = (map.dragging as any)?._draggable;
    const onPreDrag = () => {
      if (!draggable || bearingRef.current === 0) return;
      const offset = draggable._newPos.subtract(draggable._startPos);
      const rad = bearingRef.current * Math.PI / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      draggable._newPos = draggable._startPos.add(
        L.point(offset.x * c - offset.y * s, offset.x * s + offset.y * c),
      );
    };
    if (draggable) draggable.on('predrag', onPreDrag);

    // ─── 5. Expand tile loading bounds for rotated viewport ──────────
    // GridLayer._getTiledPixelBounds uses map.getSize(), not
    // getPixelBounds(), so patch 3 doesn't help tile loading.
    // We expand the tiled pixel bounds directly on the prototype.
    const origGetTiledPxBounds = (L.GridLayer.prototype as any)._getTiledPixelBounds;
    (L.GridLayer.prototype as any)._getTiledPixelBounds = function (center: L.LatLng) {
      const b: L.Bounds = origGetTiledPxBounds.call(this, center);
      if (!bearingRef.current) return b;
      const m = this._map;
      if (!m) return b;
      const sz = m.getSize();
      const rad = Math.abs(bearingRef.current) * Math.PI / 180;
      const cosV = Math.abs(Math.cos(rad));
      const sinV = Math.abs(Math.sin(rad));
      const bSize = b.getSize();
      const ratioX = (sz.x * cosV + sz.y * sinV) / sz.x;
      const ratioY = (sz.x * sinV + sz.y * cosV) / sz.y;
      const extraX = Math.ceil(bSize.x * (ratioX - 1) / 2) + 256;
      const extraY = Math.ceil(bSize.y * (ratioY - 1) / 2) + 256;
      return L.bounds(
        L.point(b.min!.x - extraX, b.min!.y - extraY),
        L.point(b.max!.x + extraX, b.max!.y + extraY),
      );
    };

    // ─── 6. Track zoom to avoid conflicts ────────────────────────────
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

    // ─── 7. Re-apply rotation after pan/resize ──────────────────────
    const reapply = () => {
      if (bearingRef.current !== 0 && !isZoomingRef.current) {
        applyRotation(bearingRef.current);
      }
    };
    map.on('move moveend resize', reapply);

    // ─── 8. Two-finger rotation gesture ──────────────────────────────
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
      (map as any).getPixelBounds = origGetPixelBounds;
      if (draggable) draggable.off('predrag', onPreDrag);
      (L.GridLayer.prototype as any)._getTiledPixelBounds = origGetTiledPxBounds;

      map.off('zoomanim', onZoomAnim);
      map.off('zoomend', onZoomEnd);
      map.off('move moveend resize', reapply);

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
