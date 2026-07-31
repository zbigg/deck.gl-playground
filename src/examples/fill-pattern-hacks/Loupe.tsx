import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type RefObject } from 'react';
import { Popup, ScaleButtons } from './Popup';

// Pixel-perfect magnifier: samples the rendered canvases under the cursor and blits them at
// 2x/4x/8x with nearest-neighbour scaling, so 1 rendered device pixel becomes N crisp pixels
// (native OS zoom interpolates and lies about what's actually on screen).

const SIZE = 200;
const ZOOMS = [2, 4, 8];
const ZOOM_KEY = 'deckgl-playground:loupe-zoom';

export function Loupe({
  containerRef,
  mouseRef,
  onClose,
  style
}: {
  containerRef: RefObject<HTMLDivElement>;
  mouseRef: MutableRefObject<{ x: number; y: number } | null>;
  onClose: () => void;
  style?: CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState<number>(() => {
    const v = Number(localStorage.getItem(ZOOM_KEY));
    return ZOOMS.includes(v) ? v : 4;
  });

  useEffect(() => {
    try {
      localStorage.setItem(ZOOM_KEY, String(zoom));
    } catch {
      // best-effort
    }
  }, [zoom]);

  useEffect(() => {
    let raf = 0;
    const loupe = canvasRef.current;
    const ctx = loupe?.getContext('2d') ?? null;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const container = containerRef.current;
      const m = mouseRef.current;
      if (!container || !loupe || !ctx || !m) return;

      // The rendered canvases (exclude our own overlay canvases). maplibre = background, deck = overlay.
      const canvases = Array.from(container.querySelectorAll<HTMLCanvasElement>('canvas')).filter(
        (c) => !c.dataset.overlay
      );
      const mapCanvas = canvases.find((c) => c.className.includes('maplibregl')) ?? null;
      const deckCanvas = canvases.find((c) => !c.className.includes('maplibregl')) ?? null;
      const ref = deckCanvas ?? mapCanvas;
      if (!ref) return;

      const rect = container.getBoundingClientRect();
      const dpr = ref.width / rect.width; // device px per CSS px
      const srcDev = SIZE / zoom; // device px sampled -> SIZE loupe px (magnification = zoom)
      const sx = m.x * dpr - srcDev / 2;
      const sy = m.y * dpr - srcDev / 2;

      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, SIZE, SIZE);
      if (mapCanvas) ctx.drawImage(mapCanvas, sx, sy, srcDev, srcDev, 0, 0, SIZE, SIZE);
      if (deckCanvas) ctx.drawImage(deckCanvas, sx, sy, srcDev, srcDev, 0, 0, SIZE, SIZE);

      // Crosshair on the pixel under the cursor.
      const c = SIZE / 2;
      ctx.strokeStyle = 'rgba(255,64,64,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(c + 0.5, c - 6);
      ctx.lineTo(c + 0.5, c + 6);
      ctx.moveTo(c - 6, c + 0.5);
      ctx.lineTo(c + 6, c + 0.5);
      ctx.stroke();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [zoom, containerRef, mouseRef]);

  return (
    <Popup title="loupe" onClose={onClose} controls={<ScaleButtons value={zoom} onChange={setZoom} options={ZOOMS} />} style={style}>
      <canvas
        ref={canvasRef}
        data-overlay="1"
        width={SIZE}
        height={SIZE}
        style={{ display: 'block', width: SIZE, height: SIZE, imageRendering: 'pixelated' }}
      />
    </Popup>
  );
}
