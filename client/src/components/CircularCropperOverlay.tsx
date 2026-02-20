import React, { useRef, useEffect, useState } from 'react';

type Props = {
  imageUrl: string;
  exportSize?: number; // final avatar size in px
  onSave: (file: File) => void;
  onCancel: () => void;
};

export function CircularCropperOverlay({ imageUrl, exportSize = 512, onSave, onCancel }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [scale, setScale] = useState(1);
  const [baseFitScale, setBaseFitScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, origX: 0, origY: 0 });
  const lastTouchDist = useRef<number | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const container = containerRef.current;
      const vp = Math.min(600, (container?.clientWidth ?? 600));
      const fit = Math.max(vp / img.naturalWidth, vp / img.naturalHeight);
      setBaseFitScale(fit);
      setScale(1);
      const displayedW = img.naturalWidth * fit;
      const displayedH = img.naturalHeight * fit;
      setPos({ x: (vp - displayedW) / 2, y: (vp - displayedH) / 2 });
      draw();
    };
    img.src = imageUrl;
    return () => {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  const draw = () => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    const container = containerRef.current;
    if (!canvas || !img || !container) return;
    const vp = Math.min(600, container.clientWidth);
    canvas.width = vp;
    canvas.height = vp;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, vp, vp);
    const s = baseFitScale * scale;
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    ctx.save();
    ctx.drawImage(img, pos.x, pos.y, w, h);
    ctx.restore();

    // darken outside circle
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, vp, vp);
    ctx.arc(vp / 2, vp / 2, vp / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();

    // draw circular border and clear inside (we already drew image inside)
    ctx.save();
    ctx.beginPath();
    ctx.arc(vp / 2, vp / 2, vp / 2 - 2, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'white';
    ctx.stroke();
    ctx.restore();
  };

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, scale, baseFitScale]);

  const pointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, origX: pos.x, origY: pos.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const pointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPos({ x: dragStart.current.origX + dx, y: dragStart.current.origY + dy });
  };
  const pointerUp = () => { dragging.current = false; };

  const touchDistance = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      dragging.current = true;
      dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, origX: pos.x, origY: pos.y };
    } else if (e.touches.length === 2) {
      lastTouchDist.current = touchDistance(e.touches[0], e.touches[1]);
    }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 1 && dragging.current) {
      const dx = e.touches[0].clientX - dragStart.current.x;
      const dy = e.touches[0].clientY - dragStart.current.y;
      setPos({ x: dragStart.current.origX + dx, y: dragStart.current.origY + dy });
    } else if (e.touches.length === 2) {
      const dist = touchDistance(e.touches[0], e.touches[1]);
      const last = lastTouchDist.current ?? dist;
      const delta = dist - last;
      if (Math.abs(delta) > 2) {
        const newScale = Math.max(0.5, Math.min(4, scale * (1 + delta / 200)));
        const rect = (containerRef.current as HTMLElement).getBoundingClientRect();
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
        const s = baseFitScale * scale;
        const s2 = baseFitScale * newScale;
        setPos((p) => {
          const nx = p.x + (1 - s2 / s) * (midX - p.x);
          const ny = p.y + (1 - s2 / s) * (midY - p.y);
          return { x: nx, y: ny };
        });
        setScale(newScale);
      }
      lastTouchDist.current = dist;
    }
    e.preventDefault?.();
  };
  const onTouchEnd = () => { dragging.current = false; lastTouchDist.current = null; };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = -e.deltaY;
    const newScale = Math.max(0.5, Math.min(4, scale * (1 + delta / 1000)));
    setScale(newScale);
  };

  const exportFile = async () => {
    const img = imgRef.current;
    const container = containerRef.current;
    if (!img || !container) return;
    const vp = Math.min(600, container.clientWidth);
    const s = baseFitScale * scale;
    const naturalW = img.naturalWidth;
    const naturalH = img.naturalHeight;
    const srcX = Math.max(0, (-pos.x) / s);
    const srcY = Math.max(0, (-pos.y) / s);
    const srcW = Math.min(naturalW - srcX, vp / s);
    const srcH = Math.min(naturalH - srcY, vp / s);
    const outSize = exportSize;
    const canvas = document.createElement('canvas');
    canvas.width = outSize;
    canvas.height = outSize;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, outSize, outSize);
    ctx.beginPath();
    ctx.arc(outSize / 2, outSize / 2, outSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, outSize, outSize);
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) return;
    const file = new File([blob], 'avatar.png', { type: 'image/png' });
    // revoke url later in parent
    onSave(file);
  };

  return (
    <div className="w-full flex flex-col items-center gap-4">
      <div
        ref={containerRef}
        className="w-full max-w-3xl"
        style={{ touchAction: 'none' }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onWheel={handleWheel}
      >
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: 'auto', display: 'block', background: '#222', borderRadius: 8 }}
        />
      </div>
      <div className="w-full max-w-3xl flex items-center gap-3">
        <input
          aria-label="Zoom"
          type="range"
          min={0.5}
          max={4}
          step={0.01}
          value={scale}
          onChange={(e) => setScale(Number(e.target.value))}
          className="flex-1"
        />
        <button className="btn" onClick={() => { setScale(1); setPos({ x: 0, y: 0 }); }}>Reset</button>
        <button className="btn" onClick={onCancel}>Cancelar</button>
        <button className="btn btn-primary" onClick={exportFile}>Guardar</button>
      </div>
    </div>
  );
}

export default CircularCropperOverlay;
