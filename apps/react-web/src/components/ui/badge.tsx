import type { ReactNode } from 'react';

const tones = {
  default: 'var(--color-text-muted)',
  ok: 'var(--color-success)',
  warn: 'var(--warning)',
  info: 'var(--color-info)',
  danger: 'var(--color-danger)',
} as const;

export function Badge({ tone = 'default', children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 22,
        padding: '0 var(--space-sm)',
        borderRadius: 'var(--radius-pill)',
        border: `1px solid ${tones[tone]}`,
        color: tones[tone],
        fontSize: 'var(--text-caption)',
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </span>
  );
}
