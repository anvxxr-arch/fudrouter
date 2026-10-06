import type { InputHTMLAttributes } from 'react';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        height: 'var(--control-h-md)',
        padding: '0 var(--space-md)',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--color-text)',
        fontSize: 'var(--text-sm)',
        fontFamily: 'var(--font-ui)',
        width: '100%',
        ...props.style,
      }}
    />
  );
}
