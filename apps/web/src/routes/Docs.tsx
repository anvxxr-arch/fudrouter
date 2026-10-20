import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Reveal } from '../components/Reveal';
import { api, type DocEntry } from '../lib/api';
import './Docs.css';

// Minimal markdown for the docs constants: headings, bullets, numbered lists,
// fenced code, inline code, bold, links. Everything else is a paragraph.
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(text: string, keyPrefix: string, plain = false): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyPrefix}-${n++}`;
    if (m[1] !== undefined) out.push(<code key={key}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={key}>{m[2]}</strong>);
    else if (m[3] !== undefined && m[4] !== undefined) {
      // Link text can itself carry inline code, so it renders recursively.
      // A nested link inside link text is impossible ([^\]]+ excludes `]`),
      // so the recursion always terminates.
      const body = inline(m[3], key, plain);
      // plain is for text nested inside another anchor (the index card
      // description): an <a> inside an <a> would split the outer link.
      out.push(plain ? <span key={key}>{body}</span> : m[4].startsWith('/')
        ? <Link key={key} to={m[4]}>{body}</Link>
        : <a key={key} href={m[4]} target="_blank" rel="noreferrer">{body}</a>);
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string };

const HEADING_TAGS = ['h2', 'h3', 'h4', 'h5', 'h6'] as const;

function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;
  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: 'para', text: para.join(' ') });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
      list = null;
    }
  };
  for (const line of md.split('\n')) {
    if (code !== null) {
      if (line.trimStart().startsWith('```')) {
        blocks.push({ kind: 'code', text: code.join('\n') });
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.trimStart().startsWith('```')) {
      flushPara();
      flushList();
      code = [];
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      // The page title owns the h1, so markdown headings start at h2.
      blocks.push({ kind: 'heading', level: Math.min(heading[1].length, 5), text: heading[2].trim() });
      continue;
    }
    const item = /^-\s+(.*)$/.exec(line) ?? /^\d+\.\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const ordered = line[0] !== '-';
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item[1].trim());
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    // An indented line after a list item is its continuation, not a new block.
    if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  if (code !== null) blocks.push({ kind: 'code', text: code.join('\n') });
  flushPara();
  flushList();
  return blocks;
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.kind) {
      case 'heading': {
        const Tag = HEADING_TAGS[b.level - 1];
        return <Tag key={i}>{inline(b.text, `h${i}`)}</Tag>;
      }
      case 'code':
        return <pre key={i}><code>{b.text}</code></pre>;
      case 'list': {
        const items = b.items.map((it, j) => <li key={j}>{inline(it, `li${i}-${j}`)}</li>);
        return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
      }
      case 'para':
        return <p key={i}>{inline(b.text, `p${i}`)}</p>;
    }
  });
}

// Roughly 200 words per minute, minimum one minute.
function readMinutes(markdown: string): number {
  return Math.max(1, Math.round(markdown.trim().split(/\s+/).length / 200));
}

export function DocsPage() {
  const { '*': splat } = useParams();
  const path = (splat ?? '').replace(/^\/+|\/+$/g, '');
  const [cats, setCats] = useState<{ slug: string; title: string; pages: DocEntry[] }[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [entry, setEntry] = useState<DocEntry | null>(null);
  const [prev, setPrev] = useState<DocEntry | null>(null);
  const [next, setNext] = useState<DocEntry | null>(null);
  const [missing, setMissing] = useState(false);
  const [query, setQuery] = useState('');
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
  const q = query.trim().toLowerCase();
  const total = useMemo(() => cats.reduce((n, c) => n + c.pages.length, 0), [cats]);
  const hits = useMemo(() => (q === '' ? [] : cats.flatMap((c) => c.pages
    .filter((p) => p.title.toLowerCase().includes(q)
      || c.title.toLowerCase().includes(q)
      || p.markdown.toLowerCase().includes(q))
    .map((p) => ({ page: p, category: c.title })))), [cats, q]);
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
                <div className="doc-prose">{renderBlocks(parseBlocks(entry.markdown))}</div>
                <nav className="doc-pager" aria-label="Documentation pages">
                  {prev ? <Link to={`/docs/${prev.path}`}>← {prev.title}</Link> : <span />}
                  <Link to="/docs">Docs index</Link>
                  {next ? <Link to={`/docs/${next.path}`}>{next.title} →</Link> : <span />}
                </nav>
              </>
            ) : (
              <>
                <div className="doc-search">
                  <input
                    className="input"
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search the docs"
                    aria-label="Search documentation"
                  />
                  <span className="meta">{q === '' ? `${total} pages` : `${hits.length} of ${total} pages`}</span>
                </div>
                {q === '' ? (
                  cats.map((c) => (
                    <section key={c.slug}>
                      <h2>{c.title}</h2>
                      <div className="cat-grid">
                        {c.pages.map((p) => (
                          <Link key={p.path} className="cat-card" to={`/docs/${p.path}`}>
                            <strong>{p.title}</strong>
                            <span className="muted">{inline(p.markdown.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '', p.path, true)}</span>
                            <span className="meta">{readMinutes(p.markdown)} min read</span>
                          </Link>
                        ))}
                      </div>
                    </section>
                  ))
                ) : hits.length === 0 ? (
                  <p className="muted">No pages match “{query.trim()}”.</p>
                ) : (
                  <ul className="doc-results">
                    {hits.map(({ page, category }) => (
                      <li key={page.path}>
                        <Link className="doc-result" to={`/docs/${page.path}`}>
                          <strong>{page.title}</strong>
                          <span className="meta">{category}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </Reveal>
  );
}
