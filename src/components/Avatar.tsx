export function Avatar({
  name,
  color,
  image,
  size = 28,
  dim = false,
}: {
  name: string;
  color: string;
  image?: string | null;
  size?: number;
  dim?: boolean;
}) {
  const style = { width: size, height: size, opacity: dim ? 0.45 : 1 };
  if (image) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={image} alt={name} title={name} className="shrink-0 rounded-full" style={style} />;
  }
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      title={name}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-ink"
      style={{ ...style, background: color, fontSize: Math.round(size * 0.4) }}
    >
      {initials}
    </span>
  );
}
