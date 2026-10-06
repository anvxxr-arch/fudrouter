import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Reveal } from '../components/Reveal';
import { api, type ChangelogEntry } from '../lib/api';

export function ChangelogPage() {
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  useEffect(() => {
    void api.changelog().then((d) => {
      if (d) setEntries(d.entries);
    });
  }, []);
  return (
    <Reveal>
      <div className="stack">
        <h1>Changelog</h1>
        <p className="lede muted">One entry per shipped release, newest first.</p>
        {entries.map((e) => (
          <section key={e.slug}>
            <p className="muted num">{e.date}</p>
            <h2><Link to={`/changelog/${e.slug}`}>{e.title}</Link></h2>
          </section>
        ))}
      </div>
    </Reveal>
  );
}

export function ChangelogEntryPage() {
  const { slug } = useParams();
  const [entry, setEntry] = useState<ChangelogEntry | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (slug) void api.changelogEntry(slug).then((d) => {
      if (d?.entry) setEntry(d.entry);
      else setMissing(true);
    });
  }, [slug]);
  if (missing) return <div className="stack"><h1>Entry not found</h1><Link to="/changelog">Back to changelog.</Link></div>;
  if (!entry) return <div className="stack"><h1>Changelog</h1><p className="muted">Loading…</p></div>;
  return (
    <div className="stack">
      <p className="muted num">{entry.date}</p>
      <h1>{entry.title}</h1>
      <div dangerouslySetInnerHTML={{ __html: entry.html }} />
      <Link to="/changelog">Back to changelog.</Link>
    </div>
  );
}

export function TermsPage() {
  return (
    <div className="stack">
      <h1>Terms of Service</h1>
      <p className="muted">The terms governing use of fudrouter. Contact support for the current agreement.</p>
      <p>Contact support for the current agreement.</p>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <div className="stack">
      <h1>Privacy Policy</h1>
      <p className="muted">How fudrouter handles your data. Contact support for the current policy.</p>
      <p>Contact support for the current policy.</p>
    </div>
  );
}
