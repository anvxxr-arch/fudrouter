import { useEffect, useRef, type ReactNode } from 'react';
import anime from 'animejs';

/** Fade-and-rise entrance on mount; static when reduced motion is preferred. */
export function Reveal({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const anim = anime({
      targets: ref.current,
      opacity: [0, 1],
      translateY: [14, 0],
      duration: 320,
      easing: 'easeOutExpo',
    });
    return () => anim.pause();
  }, []);
  return <div ref={ref}>{children}</div>;
}
