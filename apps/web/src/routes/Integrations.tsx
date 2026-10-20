import { useState } from 'react';
import { Reveal } from '../components/Reveal';
import { Badge } from '../components/ui/badge';

type Category = 'CLI coding tools' | 'SDKs' | 'Frameworks' | 'Self-hosted';

const CATEGORIES: Category[] = ['CLI coding tools', 'SDKs', 'Frameworks', 'Self-hosted'];

type Status = 'Tested' | 'Community';

interface Integration {
  name: string;
  category: Category;
  status: Status;
  desc: string;
  /** Env var or config path the tool reads its base URL from. */
  config: string;
  code: string;
}

const BASE_URL = 'https://api.your-domain.com/v1';

// One guide per tool: the base URL is the same everywhere, the config knob is
// what differs. Every card is Community — no integration here has been
// exercised against this router by this project, so none may claim Tested.
// The Status type keeps both values so a verified path can be marked later.
const INTEGRATIONS: Integration[] = [
  {
    name: 'Claude Code',
    category: 'CLI coding tools',
    status: 'Community',
    desc: 'Anthropic’s CLI coding agent.',
    config: 'ANTHROPIC_BASE_URL',
    code: `export ANTHROPIC_BASE_URL="${BASE_URL}"
export ANTHROPIC_AUTH_TOKEN="sk-ar-..."
export ANTHROPIC_MODEL="<any model slug from /v1/models>"
claude`,
  },
  {
    name: 'Codex',
    category: 'CLI coding tools',
    status: 'Community',
    desc: 'OpenAI’s CLI coding agent.',
    config: 'OPENAI_BASE_URL',
    code: `export OPENAI_BASE_URL="${BASE_URL}"
export OPENAI_API_KEY="sk-ar-..."
codex`,
  },
  {
    name: 'Cline',
    category: 'CLI coding tools',
    status: 'Community',
    desc: 'VS Code coding agent with an OpenAI-compatible provider.',
    config: 'Settings → API Provider → OpenAI Compatible',
    code: `Base URL: ${BASE_URL}
API Key: sk-ar-...
Model: <any model slug from /v1/models>`,
  },
  {
    name: 'Cursor',
    category: 'CLI coding tools',
    status: 'Community',
    desc: 'AI-first code editor with a custom base URL option.',
    config: 'Settings → Models → OpenAI API Key (base URL override)',
    code: `Base URL: ${BASE_URL}
API Key: sk-ar-...
Model: <any model slug from /v1/models>`,
  },
  {
    name: 'Continue',
    category: 'CLI coding tools',
    status: 'Community',
    desc: 'Open-source IDE assistant with configurable models.',
    config: '~/.continue/config.json',
    code: `{
  "models": [{
    "title": "fudrouter",
    "provider": "openai",
    "model": "<any model slug from /v1/models>",
    "apiBase": "${BASE_URL}",
    "apiKey": "sk-ar-..."
  }]
}`,
  },
  {
    name: 'Crush',
    category: 'CLI coding tools',
    status: 'Community',
    desc: 'Charm’s terminal coding agent.',
    config: 'CRUSH_OPENAI_BASE_URL',
    code: `export CRUSH_OPENAI_BASE_URL="${BASE_URL}"
export CRUSH_OPENAI_API_KEY="sk-ar-..."
crush`,
  },
  {
    name: 'Aider',
    category: 'CLI coding tools',
    status: 'Community',
    desc: 'Pair programming in the terminal.',
    config: '--openai-api-base',
    code: `export OPENAI_API_KEY="sk-ar-..."
aider --openai-api-base ${BASE_URL} --model "<any model slug from /v1/models>"`,
  },
  {
    name: 'OpenCode',
    category: 'CLI coding tools',
    status: 'Community',
    desc: 'Terminal-native coding agent.',
    config: 'opencode config (provider.baseURL)',
    code: `{
  "provider": {
    "fudrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "${BASE_URL}", "apiKey": "sk-ar-..." }
    }
  }
}`,
  },
  {
    name: 'Droid',
    category: 'CLI coding tools',
    status: 'Community',
    desc: 'Factory’s CLI coding agent.',
    config: 'FACTORY_OPENAI_BASE_URL',
    code: `export FACTORY_OPENAI_BASE_URL="${BASE_URL}"
export FACTORY_OPENAI_API_KEY="sk-ar-..."
droid`,
  },
  {
    name: 'Kilo Code',
    category: 'CLI coding tools',
    status: 'Community',
    desc: 'VS Code coding agent, OpenAI-compatible provider.',
    config: 'Settings → API Provider → OpenAI Compatible',
    code: `Base URL: ${BASE_URL}
API Key: sk-ar-...
Model: <any model slug from /v1/models>`,
  },
  {
    name: 'openai (Python)',
    category: 'SDKs',
    status: 'Community',
    desc: 'The official OpenAI Python SDK.',
    config: 'base_url',
    code: `from openai import OpenAI
client = OpenAI(base_url="${BASE_URL}", api_key="sk-ar-...")
client.chat.completions.create(model="<any model slug from /v1/models>", messages=[{"role": "user", "content": "hi"}])`,
  },
  {
    name: 'openai (Node)',
    category: 'SDKs',
    status: 'Community',
    desc: 'The official OpenAI Node SDK.',
    config: 'baseURL',
    code: `import OpenAI from "openai";
const client = new OpenAI({ baseURL: "${BASE_URL}", apiKey: "sk-ar-..." });
await client.chat.completions.create({ model: "<any model slug from /v1/models>", messages: [{ role: "user", content: "hi" }] });`,
  },
  {
    name: 'anthropic (Python)',
    category: 'SDKs',
    status: 'Community',
    desc: 'The official Anthropic Python SDK.',
    config: 'base_url',
    code: `import anthropic
client = anthropic.Anthropic(base_url="${BASE_URL}", api_key="sk-ar-...")
client.messages.create(model="<any model slug from /v1/models>", max_tokens=1024, messages=[{"role": "user", "content": "hi"}])`,
  },
  {
    name: 'Vercel AI SDK',
    category: 'SDKs',
    status: 'Community',
    desc: 'TypeScript SDK with an OpenAI-compatible provider.',
    config: 'createOpenAICompatible({ baseURL })',
    code: `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
const provider = createOpenAICompatible({ baseURL: "${BASE_URL}", apiKey: "sk-ar-..." });`,
  },
  {
    name: 'LangChain',
    category: 'SDKs',
    status: 'Community',
    desc: 'Python/JS framework with a ChatOpenAI model.',
    config: 'openai_api_base',
    code: `from langchain_openai import ChatOpenAI
llm = ChatOpenAI(model="<any model slug from /v1/models>", openai_api_base="${BASE_URL}", openai_api_key="sk-ar-...")`,
  },
  {
    name: 'Dify',
    category: 'Frameworks',
    status: 'Community',
    desc: 'LLM app platform with an OpenAI-API-compatible model provider.',
    config: 'Settings → Model Provider → OpenAI-API-compatible',
    code: `API Base: ${BASE_URL}
API Key: sk-ar-...
Model: <any model slug from /v1/models>`,
  },
  {
    name: 'Langflow',
    category: 'Frameworks',
    status: 'Community',
    desc: 'Visual LLM flow builder with an OpenAI component.',
    config: 'OpenAI component → Base URL',
    code: `Base URL: ${BASE_URL}
API Key: sk-ar-...
Model: <any model slug from /v1/models>`,
  },
  {
    name: 'Open WebUI',
    category: 'Frameworks',
    status: 'Community',
    desc: 'Self-hosted chat UI with an OpenAI connection.',
    config: 'Settings → Connections → OpenAI API',
    code: `URL: ${BASE_URL}
Key: sk-ar-...
Model: <any model slug from /v1/models>`,
  },
  {
    name: 'llama.cpp',
    category: 'Self-hosted',
    status: 'Community',
    desc: 'Local GGUF inference server, usable as an upstream provider.',
    config: '--api-key / server URL',
    code: `./llama-server -m <your-model>.gguf --port 8080
# register http://127.0.0.1:8080/v1 as an upstream provider in the console`,
  },
  {
    name: 'vLLM',
    category: 'Self-hosted',
    status: 'Community',
    desc: 'High-throughput OpenAI-compatible inference server.',
    config: '--port / server URL',
    code: `vllm serve <your-model-repo> --port 8080
# register http://127.0.0.1:8080/v1 as an upstream provider in the console`,
  },
  {
    name: 'Ollama',
    category: 'Self-hosted',
    status: 'Community',
    desc: 'Local model runner with an OpenAI-compatible endpoint.',
    config: 'OLLAMA_HOST / server URL',
    code: `ollama serve
# register http://127.0.0.1:11434/v1 as an upstream provider in the console`,
  },
];

const FILTERS = ['All', ...CATEGORIES] as const;
type Filter = (typeof FILTERS)[number];

export function IntegrationsPage() {
  const [filter, setFilter] = useState<Filter>('All');
  const shown = filter === 'All' ? INTEGRATIONS : INTEGRATIONS.filter((i) => i.category === filter);
  return (
    <Reveal>
      <div className="stack">
        <h1>Integrations</h1>
        <p className="lede muted">fudrouter speaks [OI]. Anything that can change its base URL works.</p>

        <section className="card" aria-labelledby="integrations-universal">
          <h2 id="integrations-universal" className="card-title">Universal setup</h2>
          <p>If your tool supports a custom [OI] base URL, it works.</p>
          <dl className="stack">
            <div>
              <dt className="fr-label">Base URL</dt>
              <dd><code>{BASE_URL}</code></dd>
            </div>
            <div>
              <dt className="fr-label">Key format</dt>
              <dd><code>sk-ar-...</code></dd>
            </div>
            <div>
              <dt className="fr-label">Model</dt>
              <dd>anything from <code>/v1/models</code></dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="integrations-list">
          <h2 id="integrations-list">Supported tools</h2>
          <div className="row" role="group" aria-label="Filter by category">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                className={f === filter ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                aria-pressed={f === filter}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="cat-grid">
            {shown.map((i) => (
              <div key={i.name} className="card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <h3 className="card-title">{i.name}</h3>
                  <Badge tone={i.status === 'Tested' ? 'ok' : 'info'}>{i.status}</Badge>
                </div>
                <p className="card-desc">{i.desc}</p>
                <p className="meta">{i.category}</p>
                <details>
                  <summary>Setup guide</summary>
                  <p className="fr-label">{i.config}</p>
                  <pre className="code-block"><code>{i.code}</code></pre>
                </details>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="integrations-request">
          <h2 id="integrations-request">Request an integration</h2>
          <p className="muted">
            Missing a tool?{' '}
            <a href="mailto:integrations@your-domain.com?subject=Integration%20request">Request an integration</a>.
          </p>
        </section>
      </div>
    </Reveal>
  );
}
