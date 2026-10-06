import { useEffect, useState } from 'react';
import { RunningRat } from './RunningRat';

const MESSAGES = [
  'Running the wheel...',
  'Counting cheese crumbs...',
  'Observing the specimen...',
  'Calibrating the maze...',
  'Logging tail movements...',
  'Refilling the water bottle...',
  'Checking for escape routes...',
  'Untangling the bedding...',
  'Measuring whisker growth...',
  'Recording lap count...',
  'Analysing nibble patterns...',
  'Adjusting cage temperature...',
];

export function RatWheelLoader(props: { label?: string; compact?: boolean }) {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * MESSAGES.length));

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % MESSAGES.length);
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  const text = props.label ?? MESSAGES[index];

  return (
    <div className={`rat-wheel-container${props.compact ? ' compact' : ''}`} role="status" aria-label={props.label ?? 'Loading repository data'}>
      <div className="rat-wheel" aria-hidden="true">
        <div className="wheel-ring" />
        <div className="wheel-spokes" />
        <RunningRat />
      </div>
      <span className="rat-wheel-label" aria-hidden="true">{text}</span>
    </div>
  );
}
