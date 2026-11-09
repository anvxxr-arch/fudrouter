import { motion, useReducedMotion, type HTMLMotionProps } from 'motion/react';
import type { ComponentType, ReactNode } from 'react';

/**
 * Scroll entrance for a block.
 *
 * Why whileInView rather than a mount animation: a mount fade only ever played
 * for the first screenful. Everything below the fold — which on the landing page
 * is most of it — arrived already settled, so the page read as a static document
 * with one animated header. An element animates when it is actually looked at.
 *
 * Correctness rules this keeps (from the IntersectionObserver version it
 * replaced):
 *  - Reduced motion skips the whole thing: `useReducedMotion` renders the final
 *    state immediately — no hidden state, no observer.
 *  - Only opacity/transform animate, so nothing here can cause layout shift.
 *  - A block below the fold simply waits for its viewport threshold; the
 *    initial state is applied on mount, and a block that never intersects is
 *    still animated in by the viewport observer, so content is never hidden.
 */
export type RevealTag = 'div' | 'section' | 'article' | 'li';

const MOTION_EASE = [0.16, 1, 0.3, 1] as const;
const MOTION_MED_MS = 320;

const TAG_MAP = {
  div: motion.div,
  section: motion.section,
  article: motion.article,
  li: motion.li,
} as const;

export function Reveal({
  children,
  delay = 0,
  className,
  as = 'div',
  ...rest
}: {
  children: ReactNode;
  /** Stagger offset in ms; a list passes index * step. */
  delay?: number;
  /** Extra classes (e.g. a card surface) so the reveal element IS the grid item. */
  className?: string;
  /** Render as the semantic element the content needs (section, li, article). */
  as?: RevealTag;
} & Omit<HTMLMotionProps<RevealTag>, 'className' | 'children'>) {
  const reduced = useReducedMotion();
  const MotionTag = TAG_MAP[as] as ComponentType<HTMLMotionProps<RevealTag>>;
  return (
    <MotionTag
      initial={reduced ? false : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -8% 0px' }}
      transition={{ duration: MOTION_MED_MS / 1000, delay: delay / 1000, ease: MOTION_EASE }}
      className={className}
      {...rest}
    >
      {children}
    </MotionTag>
  );
}
