import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Reveal } from '../components/Reveal';
import { api, type ChangelogEntry } from '../lib/api';
import './Changelog.css';

// The date is the filename's first 10 chars (server/public.mjs:637), so it is
// already `YYYY-MM-DD`. Rendering it as-is keeps the index sortable and avoids
// the timezone shift `new Date(...)` introduces by parsing it as UTC midnight.
type Load =
  | { kind: 'loading' }
  | { kind: 'entry'; entry: ChangelogEntry }
  | { kind: 'missing' }
  | { kind: 'error' };

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
      <div className="stack">
        <h1>Changelog</h1>
        <p className="lede muted">What shipped, and when: router, console and platform changes, newest first.</p>
        {failed ? <p className="error" role="alert">The changelog could not be loaded — reload in a moment.</p> : null}
        {entries === null ? (
          <p className="muted" role="status">Loading…</p>
        ) : (
          <section aria-labelledby="changelog-entries">
            <h2 id="changelog-entries" className="fr-label">Entries</h2>
            <ul className="changelog-list">
              {entries.map((e) => (
                <li key={e.slug} className="changelog-item">
                  <Link to={`/changelog/${e.slug}`}>
                    <time className="changelog-date" dateTime={e.date}>{e.date}</time>
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
        <div className="stack">
          <h1>Changelog</h1>
          <p className="muted" role="status">Loading…</p>
        </div>
      </Reveal>
    );
  }
  if (load.kind !== 'entry') {
    return (
      <Reveal>
        <div className="stack">
          <h1>Entry not found</h1>
          {load.kind === 'missing' ? (
            <p className="muted">No changelog entry at /changelog/{slug}.</p>
          ) : (
            <p className="error" role="alert">That entry could not be loaded — the changelog index is still available.</p>
          )}
          <Link to="/changelog">Back to the changelog</Link>
        </div>
      </Reveal>
    );
  }
  const { entry } = load;
  return (
    <Reveal>
      <div className="stack">
        <Link to="/changelog">← All entries</Link>
        <h1>{entry.title}</h1>
        <p className="lede muted">
          <time dateTime={entry.date}>{entry.date}</time>
        </p>
        {/* The one sanctioned dangerouslySetInnerHTML in this codebase: `html`
            is rendered server-side by renderMarkdown (server/public.mjs:558),
            whose escapeHtml (public.mjs:545) escapes & < > " before any
            markup is built, and the source is repo-controlled
            docs/changelog/*.md. */}
        <div className="changelog-body" dangerouslySetInnerHTML={{ __html: entry.html }} />
      </div>
    </Reveal>
  );
}

export function ChangelogPage() {
  const { slug } = useParams();
  if (slug) return <ChangelogEntryView slug={slug} />;
  return <ChangelogIndex />;
}
