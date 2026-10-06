export function RatWheelLoader(props: { label?: string }) {
  return (
    <div className="rat-wheel-container">
      <div className="rat-wheel">
        <div className="wheel-ring" />
        <div className="wheel-spokes" />
        <div className="wheel-rat">🐀</div>
      </div>
      <span className="rat-wheel-label">{props.label ?? 'Crunching numbers…'}</span>
    </div>
  );
}
