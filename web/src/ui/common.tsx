import type { ComponentChildren } from "preact";
import type { Computed } from "./hooks";

export function ErrorBox({ error }: { error: string }) {
  return <div class="error">Error: {error}</div>;
}

/** Render loading / error / content for a Computed value. */
export function Async<T>({ c, children }: { c: Computed<T>; children: (d: T) => ComponentChildren }) {
  if (c.error) return <ErrorBox error={c.error} />;
  if (c.data === undefined) return <div class="muted">Loading…</div>;
  return <>{children(c.data)}</>;
}

export function Section({ title, children, right }: { title: string; children: ComponentChildren; right?: ComponentChildren }) {
  return (
    <section class="section">
      <h3>
        <span>{title}</span>
        {right && <span class="section-right">{right}</span>}
      </h3>
      {children}
    </section>
  );
}

export function KV({ rows }: { rows: [string, ComponentChildren][] }) {
  return (
    <dl class="kv">
      {rows.map(([k, v]) => (
        <>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </>
      ))}
    </dl>
  );
}
