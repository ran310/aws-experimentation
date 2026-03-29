import mermaid from 'mermaid';
import { useCallback, useEffect, useRef, useState } from 'react';

type StackOverview = {
  id: string;
  description: string;
  environment: string;
  resourceCount: number;
  resourcesByType: Record<string, number>;
  outputs: { key: string; description: string; exportName: string | null }[];
};

type OverviewPayload = {
  generatedAt: string;
  stacks: StackOverview[];
};

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    primaryColor: '#232f3e',
    primaryTextColor: '#fff',
    primaryBorderColor: '#ff9900',
    lineColor: '#8b9bb4',
    secondaryColor: '#1a2332',
    tertiaryColor: '#131d2e',
  },
  flowchart: {
    curve: 'basis',
    padding: 12,
  },
  securityLevel: 'loose',
});

export default function App() {
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [diagram, setDiagram] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [lastPoll, setLastPoll] = useState<string>('');
  const diagramHost = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [oRes, dRes] = await Promise.all([
        fetch('/api/overview'),
        fetch('/api/architecture.mmd'),
      ]);
      if (!oRes.ok) {
        const t = await oRes.text();
        throw new Error(t || oRes.statusText);
      }
      if (!dRes.ok) {
        const t = await dRes.text();
        throw new Error(t || dRes.statusText);
      }
      const o = (await oRes.json()) as OverviewPayload;
      const d = await dRes.text();
      setOverview(o);
      setDiagram(d);
      setError(null);
      setLastPoll(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const id = window.setInterval(load, 2500);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!diagram || !diagramHost.current) return;
    const host = diagramHost.current;
    let alive = true;
    host.innerHTML = '';
    const id = `mmd-${Date.now()}`;
    mermaid
      .render(id, diagram)
      .then(({ svg }) => {
        if (alive) host.innerHTML = svg;
      })
      .catch(() => {
        if (alive) {
          host.innerHTML =
            '<p class="err">Could not render Mermaid. Check architecture.mmd syntax.</p>';
        }
      });
    return () => {
      alive = false;
    };
  }, [diagram]);

  return (
    <>
      <header>
        <h1>AWS CDK infrastructure</h1>
        <p>
          Live view of stacks synthesized from <code>aws-infra</code>. The Python
          backend re-runs <code>npm run synth</code> when CDK sources change, then this
          page picks up new JSON and diagram on the next poll.
        </p>
        <div className="meta-bar">
          <span>
            <span className="pulse" />
            Polling /api every 2.5s
          </span>
          {overview && (
            <span>
              stacks-overview.json: <strong>{overview.generatedAt}</strong>
            </span>
          )}
          <span>last fetch: {lastPoll || '—'}</span>
        </div>
      </header>

      {error && (
        <div className="err" role="alert">
          {error}
          <div style={{ marginTop: '0.75rem', fontSize: '0.85rem' }}>
            Start the API: <code>cd aws-infra-dashboard/backend && uvicorn main:app --reload</code>
            <br />
            Run synth once: <code>cd aws-infra && npm run synth</code>
          </div>
        </div>
      )}

      <section>
        <h2>Architecture (Mermaid)</h2>
        <p className="stack-desc" style={{ marginTop: 0 }}>
          Source file: <code>aws-infra/generated/architecture.mmd</code> (regenerated on each
          synth).
        </p>
        <div className="diagram-wrap" ref={diagramHost} />
      </section>

      <section>
        <h2>CloudFormation stacks</h2>
        {!overview ? (
          <p className="stack-desc">Loading…</p>
        ) : (
          overview.stacks.map((s) => (
            <div key={s.id} className="stack-card">
              <h3>{s.id}</h3>
              {s.description ? (
                <p className="stack-desc">{s.description}</p>
              ) : (
                <p className="stack-desc">(no template description)</p>
              )}
              <div className="stack-meta">
                {s.environment && <>Environment: {s.environment} · </>}
                Resources: {s.resourceCount}
              </div>
              <details className="resources">
                <summary>Resources by CloudFormation type</summary>
                <ul>
                  {Object.entries(s.resourcesByType)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([t, n]) => (
                      <li key={t}>
                        {t} × {n}
                      </li>
                    ))}
                </ul>
              </details>
              {s.outputs.length > 0 && (
                <details className="outputs">
                  <summary>Outputs ({s.outputs.length})</summary>
                  <table>
                    <thead>
                      <tr>
                        <th>Key</th>
                        <th>Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.outputs.map((o) => (
                        <tr key={o.key}>
                          <td>{o.key}</td>
                          <td>{o.description || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          ))
        )}
      </section>
    </>
  );
}
