import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Code sample with a file bar and a copy button.
 *
 * The clipboard call is feature-detected: the public host is also reachable
 * over plain HTTP on the LAN (and from a non-secure context), where
 * `navigator.clipboard` is undefined. Falling back to a transient textarea +
 * execCommand keeps the button functional there instead of throwing.
 */
export function CodeBlock({ code, name }: { code: string; name: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

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
    <figure className="code-block">
      <figcaption className="code-block-bar">
        <span className="code-block-name">{name}</span>
        <button
          type="button"
          className="code-block-copy"
          data-copied={copied ? 'true' : 'false'}
          onClick={() => void copy()}
          aria-label="Copy code sample to clipboard"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre><code>{code}</code></pre>
    </figure>
  );
}

export default CodeBlock;
