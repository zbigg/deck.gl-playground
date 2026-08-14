import { useEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { Map, useControl } from 'react-map-gl/maplibre';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { MapView, WebMercatorViewport, type Layer, type MapViewState, type PickingInfo } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { useControls } from 'leva';
import 'maplibre-gl/dist/maplibre-gl.css';

// Repro: deck.gl picking across the anti-meridian. Synthetic mid-Pacific points straddle the
// 180° meridian; the far-side group renders but produces no picks in some deck ⇄ basemap
// wirings.
//
// How to read it: click every dot. Every click logs exactly one line — the picked point id,
// or "miss" when deck picked nothing. A dot that only ever logs "miss" is unpickable in the
// selected wiring — that's the bug.

const POINTS = [
  { id: 1, position: [179.52, -0.32] as [number, number] },
  { id: 2, position: [179.68, -0.12] as [number, number] },
  { id: 3, position: [179.61, -0.4] as [number, number] },
  { id: 4, position: [-179.88, 0.18] as [number, number] },
  { id: 5, position: [-179.79, 0.05] as [number, number] },
  { id: 6, position: [-179.65, 0.33] as [number, number] }
];

const MODES = ['overlay-interleaved', 'overlay-overlaid', 'deckgl-default', 'deckgl-repeat'] as const;
type Mode = (typeof MODES)[number];

const INITIAL_VIEW_STATE: MapViewState = {
  // Both groups in one view, seam down the middle.
  longitude: 179.9,
  latitude: 0,
  zoom: 8,
  pitch: 0,
  bearing: 0
};

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

type LogLine = string;

declare global {
  interface Window {
    __pickLog: LogLine[];
    __screenPos: (pointId: number) => { x: number; y: number } | null;
    __ready: boolean;
  }
}

function OverlayControl({
  interleaved,
  layers,
  onClick
}: {
  interleaved: boolean;
  layers: Layer[];
  onClick: (info: PickingInfo) => void;
}) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay({ interleaved, layers, onClick }));
  overlay.setProps({ layers, onClick });
  return null;
}

// Deck's implicit default view is MapView({repeat: false}); this is the candidate fix.
const REPEAT_VIEW = new MapView({ id: 'default-view', repeat: true });

const MODE_LABELS: Record<string, Mode> = {
  'MapboxOverlay interleaved': 'overlay-interleaved',
  'MapboxOverlay overlaid': 'overlay-overlaid',
  'DeckGL default view (repeat: false)': 'deckgl-default',
  'DeckGL MapView({repeat: true})': 'deckgl-repeat'
};

export function AntimeridianPicking() {
  const initialMode = useMemo<Mode>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('mode') as Mode | null;
    return fromUrl && MODES.includes(fromUrl) ? fromUrl : 'overlay-interleaved';
  }, []);
  const { mode } = useControls({
    mode: { value: initialMode, options: MODE_LABELS }
  });

  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);
  // Append-only: every click adds a line, nothing is ever removed.
  const [log, setLog] = useState<LogLine[]>([`--- mode: ${initialMode} ---`]);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;

  const appendLine = (line: LogLine) => {
    window.__pickLog = window.__pickLog || [];
    window.__pickLog.push(line);
    setLog((prev) => [...prev, line]);
  };

  const isFirstMode = useRef(true);
  useEffect(() => {
    if (isFirstMode.current) {
      isFirstMode.current = false;
      return;
    }
    appendLine(`--- mode: ${mode} ---`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Deck-level click handler: fires on EVERY click, picked or not, so each user action
  // produces exactly one log line.
  const handleClick = (info: PickingInfo) => {
    const target = info.object ? `picked #${(info.object as { id: number }).id}` : 'miss (nothing picked)';
    const lng = info.coordinate?.[0];
    appendLine(`click → ${target}${lng !== undefined ? ` @lng ${lng.toFixed(3)}` : ''}`);
  };

  const layers = useMemo(
    () => [
      new ScatterplotLayer({
        id: 'antimeridian-points',
        data: POINTS,
        getPosition: (d: (typeof POINTS)[number]) => d.position,
        getFillColor: (d: (typeof POINTS)[number]) => (d.position[0] > 0 ? [230, 120, 20] : [20, 110, 230]),
        radiusMinPixels: 12,
        pickable: true
      })
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode]
  );

  // Test hooks: screen position of a point on the world copy nearest the viewport center,
  // relative to the page (for synthetic mouse events).
  useEffect(() => {
    window.__screenPos = (pointId: number) => {
      const point = POINTS.find((p) => p.id === pointId);
      const rect = containerRef.current?.getBoundingClientRect();
      if (!point || !rect) return null;
      const vs = viewStateRef.current;
      const viewport = new WebMercatorViewport({ ...vs, width: rect.width, height: rect.height });
      const [lng, lat] = point.position;
      const wrappedLng = lng + 360 * Math.round((vs.longitude - lng) / 360);
      const [x, y] = viewport.project([wrappedLng, lat]);
      return { x: rect.left + x, y: rect.top + y };
    };
    window.__ready = true;
  }, []);

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Keep the newest line visible.
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
      {mode.startsWith('overlay') ? (
        <Map
          key={mode}
          longitude={viewState.longitude}
          latitude={viewState.latitude}
          zoom={viewState.zoom}
          pitch={viewState.pitch}
          bearing={viewState.bearing}
          onMove={(e) => setViewState(e.viewState as unknown as MapViewState)}
          mapStyle={MAP_STYLE}
        >
          <OverlayControl interleaved={mode === 'overlay-interleaved'} layers={layers} onClick={handleClick} />
        </Map>
      ) : (
        <DeckGL
          key={mode}
          viewState={viewState}
          onViewStateChange={({ viewState: vs }) => setViewState(vs as MapViewState)}
          controller
          layers={layers}
          views={mode === 'deckgl-repeat' ? REPEAT_VIEW : undefined}
          onClick={handleClick}
        >
          <Map mapStyle={MAP_STYLE} />
        </DeckGL>
      )}
      <div
        style={{
          position: 'absolute',
          left: 12,
          bottom: 12,
          width: 340,
          maxHeight: '50%',
          display: 'flex',
          flexDirection: 'column',
          padding: '8px 10px',
          borderRadius: 6,
          background: 'rgba(15,20,25,0.85)',
          color: '#e2e8f0',
          font: '11px ui-monospace, monospace'
        }}
      >
        <div style={{ marginBottom: 4 }}>click the dots — every click logs one line below</div>
        <div ref={logRef} style={{ overflowY: 'auto' }}>
          {log.map((line, i) => (
            <div key={i} style={{ color: line.includes('picked') ? '#4ade80' : line.includes('miss') ? '#f87171' : '#94a3b8' }}>
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
