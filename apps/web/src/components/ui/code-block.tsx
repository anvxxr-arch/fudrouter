import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';

/**
 * Code sample with a file bar and a copy button.
 *
 * The clipboard call is feature-detected: the public host is also reachable
 * over plain HTTP on the LAN (and from a non-secure context), where
 * `navigator.clipboard` is undefined. Falling back to a transient textarea +
 * execCommand keeps the button functional there instead of throwing.
 *
 * `tabs` / `activeTab` / `onTabChange` turn the name slot into a tab bar when
 * present — so a "tabbed code sample" is THIS atom with a prop, not a hand-
 * rolled row of buttons stitched above a second CodeBlock (which used to leave
 * the language name stated twice: once on the tab, once in the name bar).
 */
export function CodeBlock({
  code,
  name,
  tabs,
  activeTab,
  onTabChange,
}: {
  code: string;
  name: string;
  /** When set, renders these labels as a tab strip in place of the name. */
  tabs?: readonly string[];
  activeTab?: number;
  onTabChange?: (index: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(undefined);
  // Monospace samples never reflow, so on a phone they are wider than the card.
  // `pre` scrolls them, but a touchscreen shows no scrollbar, so the cropped
  // right edge historically read as a truncation bug. When there is more to the
  // right, the figure reports it and the edge fades.
  const preRef = useRef<HTMLPreElement>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    const update = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [code]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, [code]);

  return (
    <figure className="m-0 overflow-hidden rounded-lg border border-border bg-[var(--muted)]" data-more={more ? 'true' : 'false'}>
      <figcaption className="flex items-center justify-between gap-4 border-b border-border bg-[var(--card)] py-1.5 pl-2 pr-1.5">
        {tabs ? (
          <div className="flex min-w-0 flex-wrap gap-1" role="tablist" aria-label="Code sample language">
            {tabs.map((label, i) => (
              <button
                key={label}
                type="button"
                role="tab"
                aria-selected={i === activeTab}
                className={
                  i === activeTab
                    ? 'rounded-sm bg-[var(--muted)] px-2 py-1 font-mono text-xs font-semibold text-foreground'
                    : 'rounded-sm px-2 py-1 font-mono text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground'
                }
                onClick={() => onTabChange?.(i)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : (
          <span className="truncate font-mono text-xs text-muted-foreground">{name}</span>
        )}
        <button
          type="button"
          className="inline-flex min-h-7 flex-none items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground data-[copied='true']:border-[var(--primary)] data-[copied='true']:text-[var(--primary)]"
          data-copied={copied ? 'true' : 'false'}
          onClick={() => void copy()}
          aria-label="Copy code sample to clipboard"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <div className="pointer-events-none relative">
        <pre
          ref={preRef}
          className="m-0 max-w-full overflow-x-auto p-4 font-mono text-[var(--text-mono)] leading-relaxed text-foreground"
        >
          <code>{code}</code>
        </pre>
        {/* The "there is more to the right" cue: a painted fade that disappears
            once the sample is scrolled to its end, so "faded" always means "more
            is hidden", never "the code looks like this". */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-[var(--muted)]/95 via-[var(--muted)]/60 to-transparent data-[more='false']:opacity-0 data-[more='true']:opacity-100 transition-opacity"
          data-more={more ? 'true' : 'false'}
        />
      </div>
    </figure>
  );
}

export default CodeBlock;