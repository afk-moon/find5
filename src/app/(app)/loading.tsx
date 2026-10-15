/** Shown the moment you switch tabs, while the server prepares the page. */
export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <div className="h-7 w-72 max-w-full animate-pulse rounded-md bg-panel-2" />
      <div className="h-4 w-full max-w-xl animate-pulse rounded bg-panel-2/60" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card h-40 animate-pulse bg-panel/70" />
          ))}
        </div>
        <div className="card hidden h-72 animate-pulse bg-panel/70 lg:block" />
      </div>
    </div>
  );
}
