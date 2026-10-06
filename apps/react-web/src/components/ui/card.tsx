import type { ReactNode } from 'react';

export function Card({ title, desc, children }: { title?: string; desc?: string; children?: ReactNode }) {
  return (
    <section
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-card)',
      }}
    >
      {title ? <h3 style={{ margin: '0 0 var(--space-sm)' }}>{title}</h3> : null}
      {desc ? <p className="muted" style={{ margin: 0 }}>{desc}</p> : null}
      {children}
    </section>
  );
}
