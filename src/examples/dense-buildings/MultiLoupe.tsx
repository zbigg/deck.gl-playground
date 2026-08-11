import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { ScaleButtons } from '../fill-pattern-hacks/Popup';

// Magnifier for a side-by-side comparison: samples every pane at the *same* pane-local
// position, so one hover shows the same building rendered three ways, pixel for pixel.
// Nearest-neighbour blit — native OS zoom interpolates and lies about what is on screen.
//
// Docked under the panes rather than floating, one loupe cell per pane column: at these
// magnifications a floating window always covers the thing you are trying to compare.

const SIZE = 168;
const ZOOMS = [2, 4, 8, 16];
const ZOOM_KEY = 'deckgl-playground:multi-loupe-zoom';

export type LoupePane = { key: string; label: string; ref: RefObject<HTMLDivElement> };
export type LoupeCursor = { paneKey: string; x: number; y: number } | null;

export function MultiLoupe({
  panes,
  cursorRef
}: {
  panes: LoupePane[];
  cursorRef: MutableRefObject<LoupeCursor>;
}) {
  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const [zoom, setZoom] = useState<number>(() => {
    const v = Number(localStorage.getItem(ZOOM_KEY));
    return ZOOMS.includes(v) ? v : 8;
  });
  const [frozen, setFrozen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(ZOOM_KEY, String(zoom));
    } catch {
      // best-effort
    }
  }, [zoom]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const cursor = cursorRef.current;
      if (!cursor || frozen) return;

      for (const pane of panes) {
        const loupe = canvasRefs.current[pane.key];
        const container = pane.ref.current;
        const ctx = loupe?.getContext('2d');
        if (!loupe || !container || !ctx) continue;

        const canvases = Array.from(container.querySelectorAll<HTMLCanvasElement>('canvas')).filter(
          (c) => !c.dataset.overlay
        );
        const mapCanvas = canvases.find((c) => c.className.includes('maplibregl')) ?? null;
        const deckCanvas = canvases.find((c) => !c.className.includes('maplibregl')) ?? null;
        const source = deckCanvas ?? mapCanvas;
        if (!source) continue;

        const rect = container.getBoundingClientRect();
        const dpr = source.width / rect.width; // device px per CSS px
        const srcDev = SIZE / zoom; // device px sampled -> SIZE loupe px
        const sx = cursor.x * dpr - srcDev / 2;
        const sy = cursor.y * dpr - srcDev / 2;

        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, SIZE, SIZE);
        if (mapCanvas) ctx.drawImage(mapCanvas, sx, sy, srcDev, srcDev, 0, 0, SIZE, SIZE);
        if (deckCanvas) ctx.drawImage(deckCanvas, sx, sy, srcDev, srcDev, 0, 0, SIZE, SIZE);

        const c = SIZE / 2;
        ctx.strokeStyle = 'rgba(255,64,64,0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(c + 0.5, c - 7);
        ctx.lineTo(c + 0.5, c + 7);
        ctx.moveTo(c - 7, c + 0.5);
        ctx.lineTo(c + 7, c + 0.5);
        ctx.stroke();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [zoom, panes, cursorRef, frozen]);

  return (
    <div style={{ borderTop: '1px solid #334155', background: '#0b0f14' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          font: '11px ui-monospace, monospace',
          color: '#94a3b8'
        }}
      >
        <span>loupe — hover any pane</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setFrozen((v) => !v)}
          style={{
            cursor: 'pointer',
            padding: '1px 6px',
            borderRadius: 3,
            border: '1px solid #475569',
            background: frozen ? '#3b82f6' : 'transparent',
            color: frozen ? '#fff' : '#94a3b8',
            font: 'inherit'
          }}
        >
          {frozen ? 'frozen' : 'freeze'}
        </button>
        <ScaleButtons value={zoom} onChange={setZoom} options={ZOOMS} />
      </div>
      <div style={{ display: 'flex', gap: 1, background: '#334155' }}>
        {panes.map((pane) => (
          <div
            key={pane.key}
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              justifyContent: 'center',
              padding: '0 0 6px',
              background: '#0b0f14'
            }}
          >
            <canvas
              ref={(el) => {
                canvasRefs.current[pane.key] = el;
              }}
              data-overlay="1"
              width={SIZE}
              height={SIZE}
              style={{
                display: 'block',
                width: SIZE,
                height: SIZE,
                imageRendering: 'pixelated',
                border: '1px solid #23303d'
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
