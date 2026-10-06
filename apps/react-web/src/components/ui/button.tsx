import type { ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
};

export function Button({ variant = 'primary', size = 'md', style, ...rest }: Props) {
  return (
    <button
      {...rest}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-sm)',
        height: size === 'sm' ? 'var(--control-h-sm)' : size === 'lg' ? 'var(--control-h-lg)' : 'var(--control-h-md)',
        padding: '0 var(--space-md)',
        borderRadius: 'var(--radius-md)',
        border: variant === 'ghost' ? '1px solid var(--color-border)' : '1px solid transparent',
        background: variant === 'primary' ? 'var(--primary)' : variant === 'secondary' ? 'var(--color-surface-raised)' : 'transparent',
        color: variant === 'primary' ? 'var(--on-primary)' : 'var(--color-text)',
        fontSize: 'var(--text-sm)',
        fontWeight: 600,
        cursor: 'pointer',
        transition: `background var(--duration-fast) var(--ease)`,
        ...style,
      }}
    />
  );
}
