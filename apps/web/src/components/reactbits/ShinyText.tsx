/*
 * ShinyText — ReactBits text animation component.
 * Original by ReactBits (https://reactbits.dev/text-animations/shiny-text),
 * MIT-licensed. Dependency-free CSS shine sweep; no animation library needed.
 */
import type { CSSProperties } from 'react';

export type ShinyTextProps = {
  text: string;
  className?: string;
  /** Seconds per shine sweep. */
  speed?: number;
  disabled?: boolean;
  tag?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p' | 'span' | 'div';
};

export function ShinyText({ text, className = '', speed = 3, disabled = false, tag = 'span' }: ShinyTextProps) {
  const Tag = (tag || 'span') as 'span';
  const style = { '--shiny-speed': speed + 's' } as CSSProperties;
  return (
    <Tag className={'shiny-text' + (disabled ? ' shiny-text-disabled' : '') + ' ' + className} style={style}>
      {text}
    </Tag>
  );
}

export default ShinyText;
