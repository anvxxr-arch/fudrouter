import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Search } from 'lucide-react';
import { Reveal } from '../components/Reveal';
import { api, type DocEntry } from '../lib/api';

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
    if (m[1] !== undefined) out.push(<code key={key} className="rounded-sm border border-border bg-[var(--muted)] px-1 py-px font-mono text-[var(--text-mono)]">{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={key} className="font-semibold text-foreground">{m[2]}</strong>);
    else if (m[3] !== undefined && m[4] !== undefined) {
      // Link text can itself carry inline code, so it renders recursively.
      // A nested link inside link text is impossible ([^\]]+ excludes `]`),
      // so the recursion always terminates.
      const body = inline(m[3], key, plain);
      // plain is for text nested inside another anchor (the index card
      // description): an <a> inside an <a> would split the outer link.
      const cls = 'link';
      out.push(plain ? <span key={key}>{body}</span> : m[4].startsWith('/')
        ? <Link key={key} className={cls} to={m[4]}>{body}</Link>
        : <a key={key} className={cls} href={m[4]} target="_blank" rel="noreferrer">{body}</a>);
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

// `renderBlocks` output has no class hooks (the markdown DSL is minimal), so the
// prose elements are styled by one scoped stylesheet — the same pattern the
// changelog entry bodies use for the server-rendered HTML. Nothing here leaks
// onto other pages.
const PROSE_STYLES = `
.doc-prose { display: grid; gap: 1rem; max-width: 34rem; align-content: start; }
.doc-prose > * { min-width: 0; }
.doc-prose p { margin: 0; color: #e2e8f0; }
.doc-prose ul, .doc-prose ol { margin: 0; padding-left: 1.5rem; color: #cbd5e1; }
.doc-prose ul { list-style: disc; }
.doc-prose ol { list-style: decimal; }
.doc-prose li + li { margin-top: 0.25rem; }
.doc-prose li::marker { color: #64748b; }
.doc-prose h2 { font-size: 1.25rem; font-weight: 600; color: var(--foreground); margin: 0; }
.doc-prose h3 { font-size: 1.125rem; font-weight: 600; color: var(--foreground); margin: 0; }
.doc-prose h4 { font-size: 1rem; font-weight: 600; color: var(--foreground); margin: 0; }
.doc-prose pre { margin: 0; overflow-x: auto; border-radius: 0.5rem; border: 1px solid var(--border); background: var(--card); padding: 0.75rem; color: #e2e8f0; }
.doc-prose code { font-family: var(--font-mono); font-size: 0.8125rem; }
.doc-prose a { color: var(--primary); text-decoration: underline; }
`;

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
    <nav className="sticky top-6 grid content-start gap-4 self-start" aria-label="Documentation">
      {cats.map((c) => (
        <section key={c.slug} className="grid gap-1">
          <h2 className="eyebrow">{c.title}</h2>
          <ul className="m-0 grid gap-1 p-0">
            {c.pages.map((p) => (
              <li key={p.path}>
                <Link
                  to={`/docs/${p.path}`}
                  className={
                    p.path === entry?.path
                      ? 'inline-flex min-h-6 items-center rounded-md px-2 py-1 text-sm font-semibold text-foreground'
                      : 'inline-flex min-h-6 items-center rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground'
                  }
                >
                  {p.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
  if (missing) return (
    <Reveal>
      <div className="grid gap-6">
        <h1>Page not found</h1>
        <p className="text-muted-foreground">No documentation page lives at /docs/{path}.</p>
        <Link className="link" to="/docs">Pick a page from the docs index.</Link>
      </div>
    </Reveal>
  );
  if (path !== '' && !entry) return (
    <Reveal>
      <div className="grid gap-6">
        <h1>Documentation</h1>
        <p className="text-muted-foreground">Loading…</p>
      </div>
    </Reveal>
  );
  return (
    <Reveal>
      <style dangerouslySetInnerHTML={{ __html: PROSE_STYLES }} />
      <div className="grid gap-6">
        <h1>{entry ? entry.title : 'Documentation'}</h1>
        <p className="measure text-lg text-muted-foreground">{entry ? entry.categoryTitle : 'How this platform works, one page per topic.'}</p>
        {loadError ? <p className="error-text" role="alert">The documentation index could not be loaded — reload in a moment.</p> : null}
        <div className="grid items-start gap-8 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <div className="hidden lg:block">{sidebar}</div>
          <div className="min-w-0">
            {entry ? (
              <>
                <div className="doc-prose">{renderBlocks(parseBlocks(entry.markdown))}</div>
                <nav className="mt-6 flex justify-between border-t border-border pt-4" aria-label="Documentation pages">
                  {prev ? <Link className="link inline-flex items-center gap-1" to={`/docs/${prev.path}`}><ArrowLeft className="size-4" aria-hidden="true" /> {prev.title}</Link> : <span />}
                  <Link className="link" to="/docs">Docs index</Link>
                  {next ? <Link className="link inline-flex items-center gap-1" to={`/docs/${next.path}`}>{next.title} <ArrowRight className="size-4" aria-hidden="true" /></Link> : <span />}
                </nav>
              </>
            ) : (
              <>
                <div className="mb-6 flex items-center gap-4">
                  <div className="relative max-w-[26rem] flex-1">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search the docs"
                      aria-label="Search documentation"
                      className="form-control w-full pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground"
                    />
                  </div>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">{q === '' ? `${total} pages` : `${hits.length} of ${total} pages`}</span>
                </div>
                {q === '' ? (
                  cats.map((c) => (
                    <section key={c.slug} className="grid gap-2">
                      <h2>{c.title}</h2>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {c.pages.map((p) => (
                          <Link key={p.path} className="group grid content-start gap-1 rounded-md border border-border bg-[var(--card)] p-4 text-foreground hover:border-border-strong hover:no-underline" to={`/docs/${p.path}`}>
                            <strong className="inline-flex min-h-6 items-center">{p.title}</strong>
                            <span className="text-sm text-muted-foreground">{inline(p.markdown.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '', p.path, true)}</span>
                            <span className="mt-auto pt-1 text-xs text-muted-foreground">{readMinutes(p.markdown)} min read</span>
                          </Link>
                        ))}
                      </div>
                    </section>
                  ))
                ) : hits.length === 0 ? (
                  <p className="text-muted-foreground">No pages match “{query.trim()}”.</p>
                ) : (
                  <ul className="m-0 grid gap-2 p-0">
                    {hits.map(({ page, category }) => (
                      <li key={page.path}>
                        <Link className="flex items-baseline gap-4 rounded-md border border-border bg-[var(--card)] px-4 py-2 text-foreground hover:border-border-strong hover:no-underline" to={`/docs/${page.path}`}>
                          <strong>{page.title}</strong>
                          <span className="ml-auto text-xs text-muted-foreground">{category}</span>
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
