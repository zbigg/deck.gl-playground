import { FillPatternHacks } from './examples/fill-pattern-hacks/FillPatternHacks';

// Registry of examples. Add more here as the playground grows; for now there is one.
const examples = {
  'fill-pattern-hacks': FillPatternHacks
} as const;

export function App() {
  const Example = examples['fill-pattern-hacks'];
  return <Example />;
}
