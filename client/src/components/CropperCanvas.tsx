import React, { useRef, useEffect } from 'react';

type CropperCanvasProps = {
  imageUrl: string;
  pos: { x: number; y: number };
  setPos: (p: { x: number; y: number }) => void;
  cropScale: number;
  setCropScale: (s: number) => void;
  baseFitScale: number;
  cropImgRef: React.MutableRefObject<HTMLImageElement | null>;
  cropViewportPx: number;
};

export function CropperCanvas({ imageUrl, pos, setPos, cropScale, setCropScale, baseFitScale, cropImgRef, cropViewportPx }: CropperCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, origX: 0, origY: 0 });
  const lastTouchDist = useRef<number | null>(null);

  // Redibuja el canvas con la imagen y la máscara circular
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = cropImgRef.current;
    if (!img) return;
    // Limpia
    ctx.clearRect(0, 0, cropViewportPx, cropViewportPx);
    // Dibuja imagen
    const s = baseFitScale * cropScale;
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    ctx.save();
    ctx.drawImage(img, pos.x, pos.y, w, h);
    ctx.restore();
    // Máscara circular: oscurece fuera del círculo
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    ctx.arc(cropViewportPx / 2, cropViewportPx / 2, cropViewportPx / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // Sombra exterior
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.arc(cropViewportPx / 2, cropViewportPx / 2, cropViewportPx / 2, 0, Math.PI * 2);
    ctx.rect(0, 0, cropViewportPx, cropViewportPx);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();
    // Borde blanco
    ctx.save();
    ctx.beginPath();
    ctx.arc(cropViewportPx / 2, cropViewportPx / 2, cropViewportPx / 2 - 2, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'white';
    ctx.stroke();
    ctx.restore();
  }, [imageUrl, pos, cropScale, baseFitScale, cropImgRef.current]);

  // Carga la imagen si no está cargada
  useEffect(() => {
    if (cropImgRef.current) return;
    const img = new window.Image();
    img.onload = () => {
      cropImgRef.current = img;
    };
    img.src = imageUrl;
  }, [imageUrl, cropImgRef]);

  // Pointer/touch handlers para pan/zoom
  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, origX: pos.x, origY: pos.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPos({ x: dragStart.current.origX + dx, y: dragStart.current.origY + dy });
  };
  const onPointerUp = () => { dragging.current = false; };

  // Pinch zoom táctil
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
        const newScale = Math.max(0.5, Math.min(4, cropScale * (1 + delta / 200)));
        setCropScale(newScale);
      }
      lastTouchDist.current = dist;
    }
    e.preventDefault?.();
  };
  const onTouchEnd = () => {
    dragging.current = false;
    lastTouchDist.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      width={cropViewportPx}
      height={cropViewportPx}
      style={{ width: cropViewportPx, height: cropViewportPx, borderRadius: '50%', touchAction: 'none', background: '#222' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    />
  );
}
