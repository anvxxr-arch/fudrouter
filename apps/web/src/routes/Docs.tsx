import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Reveal } from '../components/Reveal';
import { api, type DocEntry } from '../lib/api';

export function DocsPage() {
  const { '*': splat } = useParams();
  const path = (splat ?? '').replace(/^\/+|\/+$/g, '');
  const [cats, setCats] = useState<{ slug: string; title: string; pages: DocEntry[] }[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [entry, setEntry] = useState<DocEntry | null>(null);
  const [prev, setPrev] = useState<DocEntry | null>(null);
  const [next, setNext] = useState<DocEntry | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    void api.docs().then((d) => {
      if (d) setCats(d.categories);
      else setLoadError(true);
    });
  }, []);
  useEffect(() => {
    if (path === '') {
      setEntry(null);
      setMissing(false);
      return;
    }
    void api.doc(path).then(({ data, status }) => {
      if (data?.entry) {
        setEntry(data.entry);
        setPrev(data.prev);
        setNext(data.next);
        setMissing(false);
      } else setMissing(status === 404);
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
        {loadError ? <p className="error" role="alert">The documentation index could not be loaded — reload in a moment.</p> : null}
        <div className="doc-layout">
          {sidebar}
          <div className="doc-body">
            {entry ? (
              <>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{entry.markdown}</pre>
                <nav className="doc-pager" aria-label="Documentation pages">
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
          </div>
        </div>
      </div>
    </Reveal>
  );
}
