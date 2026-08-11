import { useState } from 'react';
import { FillPatternHacks } from './examples/fill-pattern-hacks/FillPatternHacks';
import { DenseBuildings } from './examples/dense-buildings/DenseBuildings';

// Registry of examples. Add more here as the playground grows.
const examples = {
  'fill-pattern-hacks': FillPatternHacks,
  'dense-buildings': DenseBuildings
} as const;

type ExampleKey = keyof typeof examples;
const EXAMPLE_KEY = 'deckgl-playground:example';

export function App() {
  const [key, setKey] = useState<ExampleKey>(() => {
    const saved = localStorage.getItem(EXAMPLE_KEY);
    return saved && saved in examples ? (saved as ExampleKey) : 'fill-pattern-hacks';
  });
  const Example = examples[key];

  const select = (next: ExampleKey) => {
    setKey(next);
    try {
      localStorage.setItem(EXAMPLE_KEY, next);
    } catch {
      // best-effort
    }
  };

  return (
    <>
      <Example key={key} />
      <div
        style={{
          position: 'absolute',
          left: 12,
          top: 12,
          display: 'flex',
          gap: 4,
          zIndex: 10,
          font: '11px ui-monospace, monospace'
        }}
      >
        {(Object.keys(examples) as ExampleKey[]).map((k) => (
          <button
            key={k}
            onClick={() => select(k)}
            style={{
              cursor: 'pointer',
              padding: '3px 8px',
              borderRadius: 4,
              border: '1px solid #475569',
              background: k === key ? '#3b82f6' : 'rgba(15,20,25,0.85)',
              color: k === key ? '#fff' : '#94a3b8',
              font: 'inherit'
            }}
          >
            {k}
          </button>
        ))}
      </div>
    </>
  );
}
