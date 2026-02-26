import { useEffect, useRef, memo } from 'react';

/**
 * Lightweight SVG route animation for feed posts.
 * No Leaflet, no tiles — just a minimalist polyline drawing animation.
 * Uses IntersectionObserver to pause when off-screen.
 */

interface FeedRouteAnimationProps {
  coordinates: [number, number][];
  userColor: string;
  height?: number;
}

// Project lat/lng to SVG pixel coordinates
function projectCoords(
  coords: [number, number][],
  width: number,
  height: number,
  padding: number
): { x: number; y: number }[] {
  if (coords.length === 0) return [];

  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;

  for (const [lat, lng] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  const latRange = maxLat - minLat || 0.001;
  const lngRange = maxLng - minLng || 0.001;
  const drawW = width - padding * 2;
  const drawH = height - padding * 2;

  // Maintain aspect ratio
  const scaleX = drawW / lngRange;
  const scaleY = drawH / latRange;
  const scale = Math.min(scaleX, scaleY);

  const offsetX = padding + (drawW - lngRange * scale) / 2;
  const offsetY = padding + (drawH - latRange * scale) / 2;

  return coords.map(([lat, lng]) => ({
    x: offsetX + (lng - minLng) * scale,
    y: offsetY + (maxLat - lat) * scale, // flip Y (lat grows up, SVG grows down)
  }));
}

function buildPathD(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)}`;
  }
  return d;
}

const FeedRouteAnimation = memo(function FeedRouteAnimation({
  coordinates,
  userColor,
  height = 160,
}: FeedRouteAnimationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const isVisibleRef = useRef(false);
  const startTimeRef = useRef<number>(0);
  const projectedRef = useRef<{ x: number; y: number }[]>([]);
  const widthRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas || coordinates.length < 2) return;

    const rect = container.getBoundingClientRect();
    const w = rect.width || 300;
    const h = height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    widthRef.current = w;
    projectedRef.current = projectCoords(coordinates, w, h, 20);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const points = projectedRef.current;
    const totalPoints = points.length;
    const ANIMATION_DURATION = 3000;
    const PAUSE_DURATION = 800;

    // Compute total path length for the faded trail
    const segmentLengths: number[] = [0];
    let totalLength = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      totalLength += Math.sqrt(dx * dx + dy * dy);
      segmentLengths.push(totalLength);
    }

    const drawFrame = (progress: number) => {
      ctx.clearRect(0, 0, w, h);

      // Draw faded full trail (ghost path)
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.12)';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 0; i < points.length; i++) {
        if (i === 0) ctx.moveTo(points[i].x, points[i].y);
        else ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();

      // Cubic ease-out
      const eased = 1 - Math.pow(1 - progress, 3);
      const pointCount = Math.max(1, Math.floor(eased * totalPoints));

      // Draw animated polyline
      if (pointCount > 1) {
        ctx.beginPath();
        ctx.strokeStyle = userColor;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let i = 0; i < pointCount; i++) {
          if (i === 0) ctx.moveTo(points[i].x, points[i].y);
          else ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.stroke();
      }

      // Start marker (green)
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#16a34a';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (progress >= 1) {
        // End marker (red)
        const last = points[points.length - 1];
        ctx.beginPath();
        ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#dc2626';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (pointCount > 0) {
        // Runner dot
        const current = points[pointCount - 1];
        ctx.beginPath();
        ctx.arc(current.x, current.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = userColor;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    };

    let cycleStart = 0;
    let isPaused = false;
    let pauseStart = 0;

    const animate = (time: number) => {
      if (!isVisibleRef.current) {
        animationRef.current = requestAnimationFrame(animate);
        return;
      }

      if (isPaused) {
        if (time - pauseStart >= PAUSE_DURATION) {
          isPaused = false;
          cycleStart = time;
        } else {
          animationRef.current = requestAnimationFrame(animate);
          return;
        }
      }

      if (cycleStart === 0) cycleStart = time;

      const elapsed = time - cycleStart;
      const progress = Math.min(elapsed / ANIMATION_DURATION, 1);

      drawFrame(progress);

      if (progress >= 1) {
        isPaused = true;
        pauseStart = time;
      }

      animationRef.current = requestAnimationFrame(animate);
    };

    // IntersectionObserver to pause/resume animation
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          isVisibleRef.current = entry.isIntersecting;
          if (entry.isIntersecting && animationRef.current === null) {
            cycleStart = 0;
            animationRef.current = requestAnimationFrame(animate);
          }
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(container);

    // Start if already visible
    isVisibleRef.current = true;
    animationRef.current = requestAnimationFrame(animate);

    return () => {
      observer.disconnect();
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [coordinates, userColor, height]);

  if (coordinates.length < 2) return null;

  return (
    <div
      ref={containerRef}
      className="w-full rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-900/80"
      style={{ height }}
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  );
});

export { FeedRouteAnimation };
