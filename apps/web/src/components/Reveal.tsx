import { useLayoutEffect, useRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';

/**
 * Scroll entrance for a block.
 *
 * Why IntersectionObserver rather than the mount animation this replaced: a
 * mount fade only ever played for the first screenful. Everything below the fold
 * — which on the landing page is most of it — arrived already settled, so the
 * page read as a static document with one animated header. Observing the element
 * means each block animates when it is actually looked at.
 *
 * Correctness rules this keeps:
 *  - The hidden state is applied in useLayoutEffect, before paint, so a block
 *    never flashes at full opacity and then jumps to hidden.
 *  - A 1.2 s fallback reveals unconditionally. A browser without
 *    IntersectionObserver, or an element that never intersects, must show
 *    content, never hide it.
 *  - Reduced motion skips the whole thing: no hidden state, no observer.
 *  - Only opacity/transform animate, so nothing here can cause layout shift.
 */
export function Reveal({
  children,
  delay = 0,
  className,
  as: Tag = 'div',
  ...rest
}: {
  children: ReactNode;
  /** Stagger offset in ms; a list passes index * step. */
  delay?: number;
  /** Extra classes (e.g. a card surface) so the reveal element IS the grid item. */
  className?: string;
  /** Render as the semantic element the content needs (section, li, article). */
  as?: 'div' | 'section' | 'article' | 'li';
} & Omit<HTMLAttributes<HTMLElement>, 'className' | 'children'>) {
  const ref = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (typeof IntersectionObserver === 'undefined') return;

    el.dataset.reveal = 'hidden';
    let done = false;
    const show = () => {
      if (done) return;
      done = true;
      el.dataset.reveal = 'shown';
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            show();
            io.disconnect();
          }
        }
      },
      // Fire a little before the block is fully in view so the motion finishes
      // as it settles, rather than starting when it is already being read.
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );
    io.observe(el);
    const fallback = window.setTimeout(show, 1200);
    return () => {
      io.disconnect();
      window.clearTimeout(fallback);
    };
  }, []);

  return (
    <Tag
      ref={ref as never}
      className={className ? `reveal ${className}` : 'reveal'}
      style={{ '--reveal-delay': `${delay}ms` } as CSSProperties}
      {...rest}
    >
      {children}
    </Tag>
  );
}
