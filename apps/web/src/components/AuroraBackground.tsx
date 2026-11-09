import { useEffect, useRef } from 'react';
import anime from 'animejs';

// The blobs are deliberately bigger than the column they light (negative
// offsets, 42vmax wide, blur(90px)), so the layer reads as light rather than a
// bounding box. They used to sit in a hero-sized box with overflow:hidden,
// which sliced the layer at the hero edge — red channel jumped 36 points across
// a single pixel. Full-bleed + vertical fade: the only cut is at the viewport
// edge, where it is invisible.
const AURORA_STYLES = `
.aurora {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  /* Fade every edge so the full-bleed layer never ends on a hard line;
     a CSS mask is the only way to soften a 90px blur's bounding box
     without shrinking the blobs. */
  mask-image: radial-gradient(120% 90% at 50% 0%, black 50%, transparent 95%);
  -webkit-mask-image: radial-gradient(120% 90% at 50% 0%, black 50%, transparent 95%);
}
.aurora-field {
  position: absolute;
  inset: 0;
  margin: 0 auto;
  max-width: var(--shell-max);
  /* Pointer parallax: lean a few px towards the cursor. --px/--py are set by
     the rAF listener in AuroraBackground (0 until a fine pointer moves), so the
     default keeps the resting composition. */
  transform: translate3d(calc(var(--px, 0) * 8px), calc(var(--py, 0) * 8px), 0);
}
.aurora-blob {
  position: absolute;
  width: 42vmax;
  height: 42vmax;
  border-radius: 50%;
  filter: blur(90px);
  opacity: 0.5;
}
.aurora-blob.a { left: -10vmax; top: -14vmax; background: color-mix(in srgb, var(--primary) 26%, transparent); }
.aurora-blob.b { right: -12vmax; top: -10vmax; background: color-mix(in srgb, var(--chart-3) 22%, transparent); }
.aurora-blob.c { left: 22%; bottom: -20vmax; background: color-mix(in srgb, var(--chart-2) 12%, transparent); }
`;

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
    <>
      <style dangerouslySetInnerHTML={{ __html: AURORA_STYLES }} />
      <div ref={ref} className="aurora" aria-hidden="true">
        {/* The layer is full-bleed; the field is the content column the blobs are
            composed against, so the glow keeps its shape at every width. */}
        <div className="aurora-field">
          <div className="aurora-blob a" />
          <div className="aurora-blob b" />
          <div className="aurora-blob c" />
        </div>
      </div>
    </>
  );
}