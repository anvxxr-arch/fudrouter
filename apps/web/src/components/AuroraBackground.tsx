import { useEffect, useRef } from 'react';
import anime from 'animejs';

/**
 * ReactBits-style animated aurora background: brand-hued blobs drifting on
 * the hero glow tokens, staggered entrance via anime.js. Pure CSS fallback
 * keeps the glow when JS motion is reduced or unavailable.
 */
export function AuroraBackground() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const anim = anime({
      targets: ref.current.querySelectorAll('.aurora-blob'),
      translateX: ['-6%', '6%', '-6%'],
      translateY: ['-4%', '5%', '-4%'],
      scale: [1, 1.12, 1],
      duration: 9000,
      delay: anime.stagger(1200),
      loop: true,
      easing: 'easeInOutSine',
    });
    return () => anim.pause();
  }, []);

  // Pointer parallax: the glow leans a few pixels towards the cursor. It is
  // written to CSS variables from a rAF-throttled listener (no React state, so
  // moving the mouse never re-renders), and skipped on coarse pointers where
  // there is no cursor to follow.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia('(pointer: fine)').matches) return;
    const field = el.querySelector<HTMLElement>('.aurora-field');
    if (!field) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const dx = (e.clientX / window.innerWidth - 0.5) * 2;
        const dy = (e.clientY / window.innerHeight - 0.5) * 2;
        field.style.setProperty('--px', dx.toFixed(3));
        field.style.setProperty('--py', dy.toFixed(3));
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={ref} className="aurora" aria-hidden="true">
      {/* The layer is full-bleed; the field is the content column the blobs are
          composed against, so the glow keeps its shape at every width. */}
      <div className="aurora-field">
        <div className="aurora-blob a" />
        <div className="aurora-blob b" />
        <div className="aurora-blob c" />
      </div>
    </div>
  );
}
