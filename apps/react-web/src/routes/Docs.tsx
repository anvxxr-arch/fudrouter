import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Reveal } from '../components/Reveal';
import { api, type DocEntry } from '../lib/api';

export function DocsPage() {
  const { '*': splat } = useParams();
  const path = (splat ?? '').replace(/^\/+|\/+$/g, '');
  const [cats, setCats] = useState<{ slug: string; title: string; pages: DocEntry[] }[]>([]);
  const [entry, setEntry] = useState<DocEntry | null>(null);
  const [prev, setPrev] = useState<DocEntry | null>(null);
  const [next, setNext] = useState<DocEntry | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    void api.docs().then((d) => {
      if (d) setCats(d.categories);
    });
  }, []);
  useEffect(() => {
    if (path === '') {
      setEntry(null);
      setMissing(false);
      return;
    }
    void api.doc(path).then((d) => {
      if (d?.entry) {
        setEntry(d.entry);
        setPrev(d.prev);
        setNext(d.next);
        setMissing(false);
      } else setMissing(true);
    });
  }, [path]);
  const sidebar = (
    <nav className="doc-sidebar" aria-label="Documentation">
      {cats.map((c) => (
        <section key={c.slug}>
          <h2 className="fr-label">{c.title}</h2>
          <ul>
            {c.pages.map((p) => (
              <li key={p.path}><Link to={`/docs/${p.path}`} className={p.path === entry?.path ? 'current' : undefined}>{p.title}</Link></li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
  if (missing) return <div className="stack"><h1>Page not found</h1><p className="muted">No documentation page lives at /docs/{path}.</p><Link to="/docs">Pick a page from the docs index.</Link></div>;
  if (path !== '' && !entry) return <div className="stack"><h1>Documentation</h1><p className="muted">Loading…</p></div>;
  return (
    <Reveal>
      <div className="stack">
        <h1>{entry ? entry.title : 'Documentation'}</h1>
        <p className="lede muted">{entry ? entry.categoryTitle : 'How this platform works, one page per topic.'}</p>
        <div className="doc-layout">
          {sidebar}
          <main className="doc-body">
            {entry ? (
              <>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{entry.markdown}</pre>
                <nav className="doc-pager">
                  {prev ? <Link to={`/docs/${prev.path}`}>← {prev.title}</Link> : <span />}
                  <Link to="/docs">Docs index</Link>
                  {next ? <Link to={`/docs/${next.path}`}>{next.title} →</Link> : <span />}
                </nav>
              </>
            ) : (
              cats.map((c) => (
                <section key={c.slug}>
                  <h2>{c.title}</h2>
                  <div className="cat-grid">
                    {c.pages.map((p) => (
                      <Link key={p.path} className="cat-card" to={`/docs/${p.path}`}>
                        <strong>{p.title}</strong>
                        <span className="muted">{p.markdown.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? ''}</span>
                      </Link>
                    ))}
                  </div>
                </section>
              ))
            )}
          </main>
        </div>
        <style>{`.doc-layout { display: grid; grid-template-columns: 14rem minmax(0,1fr); gap: var(--space-xl); } .doc-sidebar { position: sticky; top: var(--space-lg); align-self: start; display: grid; gap: var(--space-md); } .doc-sidebar ul { list-style: none; margin: var(--space-xs) 0 0; padding: 0; display: grid; gap: var(--space-xs); } .doc-sidebar a.current { color: var(--color-text); font-weight: 600; } .cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: var(--space-md); } .cat-card { display: grid; gap: var(--space-xs); padding: var(--space-md); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); color: var(--color-text); } .doc-pager { display: flex; justify-content: space-between; margin-top: var(--space-xl); border-top: 1px solid var(--color-border); padding-top: var(--space-md); } @media (max-width: 720px) { .doc-layout { grid-template-columns: 1fr; } }`}</style>
      </div>
    </Reveal>
  );
}
