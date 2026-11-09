import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { Reveal } from '../components/Reveal';
import { api, type ChangelogEntry } from '../lib/api';

// The date is the filename's first 10 chars (server/public.mjs:637), so it is
// already `YYYY-MM-DD`. Rendering it as-is keeps the index sortable and avoids
// the timezone shift `new Date(...)` introduces by parsing it as UTC midnight.
type Load =
  | { kind: 'loading' }
  | { kind: 'entry'; entry: ChangelogEntry }
  | { kind: 'missing' }
  | { kind: 'error' };

// Server-injected markdown HTML (see renderMarkdown in server/public.mjs) has
// no class hooks, so the prose elements are styled by a scoped stylesheet. This
// is the one legitimate inline-CSS block in the tree: the HTML is trusted (see
// the dangerouslySetInnerHTML note below) and cannot carry Tailwind classes.
const PROSE_STYLES = `
.changelog-prose { display: grid; gap: 1rem; max-width: 34rem; align-content: start; }
.changelog-prose > * { min-width: 0; }
.changelog-prose p { margin: 0; color: #e2e8f0; }
.changelog-prose ul { margin: 0; padding-left: 1.5rem; list-style: disc; color: #cbd5e1; }
.changelog-prose ol { margin: 0; padding-left: 1.5rem; list-style: decimal; color: #cbd5e1; }
.changelog-prose li + li { margin-top: 0.25rem; }
.changelog-prose li::marker { color: #64748b; }
.changelog-prose h2 { font-size: 1.25rem; font-weight: 600; color: var(--foreground); margin: 0; }
.changelog-prose h3 { font-size: 1.125rem; font-weight: 600; color: var(--foreground); margin: 0; }
.changelog-prose pre { margin: 0; overflow-x: auto; border-radius: 0.5rem; border: 1px solid var(--border); background: var(--card); padding: 0.75rem; }
.changelog-prose code { font-family: var(--font-mono); font-size: 0.8125rem; }
.changelog-prose :not(pre) > code { padding: 1px 5px; border: 1px solid var(--border); border-radius: 4px; background: var(--muted); }
.changelog-prose a { color: var(--primary); text-decoration: underline; }
.changelog-prose blockquote { margin: 0; border-left: 2px solid var(--border); padding-left: 1rem; color: var(--muted-foreground); }
.changelog-prose hr { border: 0; border-top: 1px solid var(--border); }
`;

function ChangelogIndex() {
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void api.changelog().then((d) => {
      if (d) setEntries(d.entries);
      else setFailed(true);
    });
  }, []);
  return (
    <Reveal>
      <div className="grid gap-6">
        <h1>Changelog</h1>
        <p className="measure text-lg text-muted-foreground">What shipped, and when: router, console and platform changes, newest first.</p>
        {failed ? (
          <p className="error-text" role="alert">The changelog could not be loaded — reload in a moment.</p>
        ) : entries === null ? (
          <p className="text-muted-foreground" role="status">Loading…</p>
        ) : (
          <section aria-labelledby="changelog-entries">
            <h2 id="changelog-entries" className="eyebrow">Entries</h2>
            <ul className="m-0 grid gap-2 p-0">
              {entries.map((e) => (
                <li key={e.slug}>
                  <Link
                    to={`/changelog/${e.slug}`}
                    className="flex items-baseline gap-4 rounded-md border border-border bg-[var(--card)] px-4 py-2 text-foreground hover:border-border-strong hover:no-underline"
                  >
                    <time className="flex-none font-mono text-sm text-muted-foreground" dateTime={e.date}>{e.date}</time>
                    <span>{e.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Reveal>
  );
}

function ChangelogEntryView({ slug }: { slug: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  useEffect(() => {
    void api.changelogEntry(slug).then(({ data, status }) => {
      if (data?.entry) setLoad({ kind: 'entry', entry: data.entry });
      else setLoad(status === 404 ? { kind: 'missing' } : { kind: 'error' });
    });
  }, [slug]);
  if (load.kind === 'loading') {
    return (
      <Reveal>
        <div className="grid gap-6">
          <h1>Changelog</h1>
          <p className="text-muted-foreground" role="status">Loading…</p>
        </div>
      </Reveal>
    );
  }
  if (load.kind !== 'entry') {
    return (
      <Reveal>
        <div className="grid gap-6">
          <h1>Entry not found</h1>
          {load.kind === 'missing' ? (
            <p className="text-muted-foreground">No changelog entry at /changelog/{slug}.</p>
          ) : (
            <p className="error-text" role="alert">That entry could not be loaded — the changelog index is still available.</p>
          )}
          <Link className="link" to="/changelog">Back to the changelog</Link>
        </div>
      </Reveal>
    );
  }
  const { entry } = load;
  return (
    <Reveal>
      <div className="grid gap-6">
        <Link className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" to="/changelog">
          <ChevronLeft className="size-4" /> All entries
        </Link>
        <h1>{entry.title}</h1>
        <p className="text-muted-foreground">
          <time dateTime={entry.date}>{entry.date}</time>
        </p>
        {/* The one sanctioned dangerouslySetInnerHTML in this codebase: `html`
            is rendered server-side by renderMarkdown (server/public.mjs:558),
            whose escapeHtml (public.mjs:545) escapes & < > " before any markup
            is built, and the source is repo-controlled
            docs/changelog/*.md. */}
        <style dangerouslySetInnerHTML={{ __html: PROSE_STYLES }} />
        <div className="changelog-prose" dangerouslySetInnerHTML={{ __html: entry.html }} />
      </div>
    </Reveal>
  );
}

export function ChangelogPage() {
  const { slug } = useParams();
  if (slug) return <ChangelogEntryView slug={slug} />;
  return <ChangelogIndex />;
}
