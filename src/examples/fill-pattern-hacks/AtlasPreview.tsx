import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Popup, ScaleButtons } from './Popup';

// Scrollable, pixel-perfect view of the assembled pattern atlas (nearest-neighbour, 1/2/4/8×)
// so you can inspect the tiles, margins and cell layout the sampler actually reads from.

const SCALES = [1, 2, 4, 8];
const SCALE_KEY = 'deckgl-playground:atlas-scale';
const VIEWPORT = 220;

export function AtlasPreview({
  image,
  onClose,
  style
}: {
  image: CanvasImageSource | null;
  onClose: () => void;
  style?: CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState<number>(() => {
    const v = Number(localStorage.getItem(SCALE_KEY));
    return SCALES.includes(v) ? v : 2;
  });

  useEffect(() => {
    try {
      localStorage.setItem(SCALE_KEY, String(scale));
    } catch {
      // best-effort
    }
  }, [scale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = (image as { width?: number } | null)?.width ?? 0;
    const h = (image as { height?: number } | null)?.height ?? 0;
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (image && w && h) ctx.drawImage(image, 0, 0, w, h, 0, 0, w * scale, h * scale);
  }, [image, scale]);

  return (
    <Popup title="atlas" onClose={onClose} controls={<ScaleButtons value={scale} onChange={setScale} options={SCALES} />} style={style}>
      <div
        style={{
          width: VIEWPORT,
          height: VIEWPORT,
          overflow: 'auto',
          // checker so the black mask tiles and the transparent margins are both visible
          background:
            'repeating-conic-gradient(#8a949e 0% 25%, #aeb8c2 0% 50%) 0 0 / 16px 16px'
        }}
      >
        <canvas ref={canvasRef} data-overlay="1" style={{ display: 'block', imageRendering: 'pixelated' }} />
      </div>
    </Popup>
  );
}
