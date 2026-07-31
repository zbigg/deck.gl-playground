import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';

// Pixel-perfect magnifier: samples the rendered canvases under the cursor and blits them at
// 2x/4x/8x with nearest-neighbour scaling, so 1 rendered device pixel becomes N crisp pixels
// (native OS zoom interpolates and lies about what's actually on screen).

const SIZE = 200;
const ZOOMS = [2, 4, 8] as const;
const ZOOM_KEY = 'deckgl-playground:loupe-zoom';

export function Loupe({
  containerRef,
  mouseRef
}: {
  containerRef: RefObject<HTMLDivElement>;
  mouseRef: MutableRefObject<{ x: number; y: number } | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState<number>(() => {
    const v = Number(localStorage.getItem(ZOOM_KEY));
    return (ZOOMS as readonly number[]).includes(v) ? v : 4;
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

      // The rendered canvases (exclude the loupe's own). maplibre is the background, deck the overlay.
      const canvases = Array.from(container.querySelectorAll('canvas')).filter((c) => c !== loupe);
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
    <div
      style={{
        position: 'absolute',
        right: 12,
        bottom: 12,
        width: SIZE,
        pointerEvents: 'none', // let map interaction pass through; buttons re-enable below
        background: 'rgba(15,20,25,0.92)',
        border: '1px solid #334155',
        borderRadius: 6,
        overflow: 'hidden',
        font: '11px ui-monospace, monospace',
        color: '#cbd5e1'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px' }}>
        <span style={{ opacity: 0.7 }}>loupe</span>
        <span style={{ flex: 1 }} />
        {ZOOMS.map((z) => (
          <button
            key={z}
            onClick={() => setZoom(z)}
            style={{
              pointerEvents: 'auto',
              cursor: 'pointer',
              padding: '1px 6px',
              borderRadius: 3,
              border: '1px solid #475569',
              background: z === zoom ? '#3b82f6' : 'transparent',
              color: z === zoom ? '#fff' : '#94a3b8',
              font: 'inherit'
            }}
          >
            {z}×
          </button>
        ))}
      </div>
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        style={{ display: 'block', width: SIZE, height: SIZE, imageRendering: 'pixelated' }}
      />
    </div>
  );
}
