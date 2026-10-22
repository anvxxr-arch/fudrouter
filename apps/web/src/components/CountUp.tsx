import { useEffect, useRef, useState } from 'react';

/**
 * Counts a figure up when it is first looked at.
 *
 * The landing page's only real data is four numbers, and they used to appear
 * fully formed — a spec sheet rather than a measurement. Counting them makes
 * the strip read as live telemetry, which is what those figures are.
 *
 * Rules:
 *  - The final value is rendered on the server/first paint and whenever motion
 *    is reduced, so the number is never wrong for a reader who does not get the
 *    animation. The count only starts once the element intersects.
 *  - If IntersectionObserver is missing or never fires, a timeout commits the
 *    final value — a figure that stays at 0 is worse than no animation.
 *  - The formatter is the caller's, so "2,256 ms" and "1,234" animate through
 *    the same path.
 */
export function CountUp({
  value,
  format,
  duration = 900,
}: {
  value: number;
  format: (n: number) => string;
  duration?: number;
}) {
  const [shown, setShown] = useState(value);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') return;

    let raf = 0;
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      const t0 = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / duration);
        // easeOutQuart: fast out of the gate, settles on the real figure.
        const eased = 1 - Math.pow(1 - p, 4);
        setShown(Math.round(value * eased));
        if (p < 1) raf = requestAnimationFrame(step);
      };
      setShown(0);
      raf = requestAnimationFrame(step);
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          start();
          io.disconnect();
        }
      },
      { threshold: 0.5 }
    );
    io.observe(el);
    const fallback = window.setTimeout(start, 1500);
    return () => {
      io.disconnect();
      window.clearTimeout(fallback);
      cancelAnimationFrame(raf);
    };
  }, [value, duration]);

  return (
    <span ref={ref} className="countup">
      {format(shown)}
    </span>
  );
}
