import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Reveal } from '../components/Reveal';
import { Button } from '../components/ui/button';
import { Table } from '../components/ui/table';
import { api, formatContext, formatPricePer1M } from '../lib/api';

export function PricingPage() {
  const [groups, setGroups] = useState<{ developer: string; models: { slug: string; name: string; price: { inputPriceMicro: string | null; cachedInputPriceMicro: string | null; outputPriceMicro: string | null }; context: number | null; variesByProvider: boolean }[] }[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    void api.pricing().then((d) => {
      if (d) setGroups(d.groups);
      else setError(true);
    });
  }, []);
  return (
    <Reveal>
      <div className="stack">
        <h1>Pricing</h1>
        <p className="lede muted">Pay per token — no seat fees. One API key, every model. All prices normalized per 1M tokens.</p>
        {error ? <p className="error" role="alert">Pricing could not be loaded — reload in a moment.</p> : null}
        {groups.map((g) => (
          <section key={g.developer}>
            <h2>{g.developer} <span className="muted">· {g.models.length}</span></h2>
            <div className="table-wrap">
              <Table
                head={['Model', 'Input', 'Cached input', 'Output', 'Context']}
                rows={g.models.map((m) => [
                  // The model name is TEXT, not a link. It pointed at
                  // /models/:slug, and that page is withdrawn — every name in
                  // this table was a 404 while /pricing itself stayed indexable,
                  // which is the worst shape a link can have. When a per-model
                  // page comes back, this is the line that becomes a <Link>
                  // again.
                  <span key="m">{m.name}{m.slug !== m.name && <><br /><code className="muted">{m.slug}</code></>}</span>,
                  ...(m.variesByProvider
                    ? [<span key="v" className="muted">varies by provider</span>]
                    : [
                        <span key="i" className="num">{formatPricePer1M(m.price.inputPriceMicro)}</span>,
                        <span key="c" className="num">{formatPricePer1M(m.price.cachedInputPriceMicro)}</span>,
                        <span key="o" className="num">{formatPricePer1M(m.price.outputPriceMicro)}</span>,
                      ]),
                  <span key="x" className="num">{formatContext(m.context)}</span>,
                ])}
              />
            </div>
          </section>
        ))}
        <div className="row">
          <Link to="/signup"><Button>Get started</Button></Link>
          <span className="muted">Then mint a key and point a client at the API.</span>
        </div>
      </div>
    </Reveal>
  );
}
