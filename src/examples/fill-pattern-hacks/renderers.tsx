import { useEffect, useRef, type RefObject } from 'react';
import DeckGL from '@deck.gl/react';
import { Map, useControl, type MapRef } from 'react-map-gl/maplibre';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Layer, MapViewState } from '@deck.gl/core';
import 'maplibre-gl/dist/maplibre-gl.css';

// Both renderers share this interface: they own the deck ⇄ basemap wiring and the camera, and
// just receive the view state, the layer list and the basemap style from the parent.
export type MapRendererProps = {
  viewState: MapViewState;
  onViewStateChange: (viewState: MapViewState) => void;
  layers: Layer[];
  mapStyle: string;
  // Rendering DPR override; undefined = native devicePixelRatio.
  pixelRatio?: number;
};

// maplibre reads pixelRatio only at construction (covered by the Map prop); this applies
// later changes at runtime without remounting the map.
function useMaplibrePixelRatio(mapRef: RefObject<MapRef>, pixelRatio?: number) {
  useEffect(() => {
    mapRef.current?.getMap().setPixelRatio(pixelRatio ?? window.devicePixelRatio);
  }, [mapRef, pixelRatio]);
}

// Classic: deck.gl owns the camera and renders its own canvas over a maplibre base map (two
// canvases; deck composites on top).
export function DeckGLRenderer({ viewState, onViewStateChange, layers, mapStyle, pixelRatio }: MapRendererProps) {
  const mapRef = useRef<MapRef>(null);
  useMaplibrePixelRatio(mapRef, pixelRatio);
  return (
    <DeckGL
      viewState={viewState}
      onViewStateChange={({ viewState: vs }) => onViewStateChange(vs as MapViewState)}
      controller={true}
      layers={layers}
      useDevicePixels={pixelRatio ?? true}
    >
      <Map ref={mapRef} mapStyle={mapStyle} pixelRatio={pixelRatio} preserveDrawingBuffer />
    </DeckGL>
  );
}

// Interleaved control that renders the deck layers into maplibre's own WebGL context.
function DeckControl({ layers }: { layers: Layer[] }) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay({ interleaved: true, layers }));
  overlay.setProps({ layers });
  return null;
}

// MapboxOverlay: maplibre owns the camera; deck is added as an interleaved control, sharing
// maplibre's context and projection (single canvas — maplibre's pixelRatio is the only DPR knob).
export function MapboxOverlayRenderer({ viewState, onViewStateChange, layers, mapStyle, pixelRatio }: MapRendererProps) {
  const mapRef = useRef<MapRef>(null);
  useMaplibrePixelRatio(mapRef, pixelRatio);
  return (
    <Map
      ref={mapRef}
      pixelRatio={pixelRatio}
      longitude={viewState.longitude}
      latitude={viewState.latitude}
      zoom={viewState.zoom}
      pitch={viewState.pitch}
      bearing={viewState.bearing}
      onMove={(e) => onViewStateChange(e.viewState as unknown as MapViewState)}
      mapStyle={mapStyle}
      preserveDrawingBuffer
    >
      <DeckControl layers={layers} />
    </Map>
  );
}
