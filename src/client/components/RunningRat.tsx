import { useId, useMemo } from 'react';
import ratRunSheet from '../assets/rat-run-sheet.svg?raw';

export function RunningRat() {
  const id = useId();
  // Each inline sprite needs its own body reference when multiple rats are visible.
  const sprite = useMemo(() => ratRunSheet.replaceAll('rat-body', `rat-body-${id.replaceAll(':', '')}`), [id]);

  return <div className="running-rat" aria-hidden="true" dangerouslySetInnerHTML={{ __html: sprite }} />;
}
