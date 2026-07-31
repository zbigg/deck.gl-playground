import type { CSSProperties, ReactNode } from 'react';

// A small closeable floating window: title bar with an optional controls slot + a close button,
// and an arbitrary body. Positioned by the caller via `style` (right/bottom/etc.).
export function Popup({
  title,
  onClose,
  controls,
  children,
  style
}: {
  title: string;
  onClose: () => void;
  controls?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        background: 'rgba(15,20,25,0.92)',
        border: '1px solid #334155',
        borderRadius: 6,
        overflow: 'hidden',
        font: '11px ui-monospace, monospace',
        color: '#cbd5e1',
        ...style
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderBottom: '1px solid #23303d' }}>
        <span style={{ opacity: 0.7 }}>{title}</span>
        <span style={{ flex: 1 }} />
        {controls}
        <button
          onClick={onClose}
          title="close"
          style={{
            cursor: 'pointer',
            width: 16,
            height: 16,
            lineHeight: '13px',
            padding: 0,
            borderRadius: 3,
            border: '1px solid #475569',
            background: 'transparent',
            color: '#94a3b8',
            font: 'inherit'
          }}
        >
          ×
        </button>
      </div>
      {children}
    </div>
  );
}

// Reusable N× scale switch used in popup title bars.
export function ScaleButtons({
  value,
  onChange,
  options
}: {
  value: number;
  onChange: (v: number) => void;
  options: number[];
}) {
  return (
    <>
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          style={{
            cursor: 'pointer',
            padding: '1px 6px',
            borderRadius: 3,
            border: '1px solid #475569',
            background: o === value ? '#3b82f6' : 'transparent',
            color: o === value ? '#fff' : '#94a3b8',
            font: 'inherit'
          }}
        >
          {o}×
        </button>
      ))}
    </>
  );
}
