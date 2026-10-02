<script>
  let features = [
    { icon: '🔌', title: 'Unified API', desc: 'One endpoint for OpenAI, Anthropic, Google, xAI, and 40+ providers' },
    { icon: '🔄', title: 'Smart Failover', desc: 'Automatic retry with multiple keys on rate limits and errors' },
    { icon: '🔒', title: 'MITM Proxy', desc: 'Intercept and route IDE traffic transparently' },
    { icon: '📊', title: 'Usage Analytics', desc: 'Real-time cost tracking, token counting, and quota management' },
    { icon: '🛠️', title: 'CLI Tools', desc: 'Built-in support for Claude Code, Codex, Cursor, and more' },
    { icon: '🔑', title: 'OAuth Manager', desc: 'Automatic token refresh for all provider accounts' }
  ]

  let steps = [
    { num: '01', title: 'Add Provider Keys', desc: 'Connect your OpenAI, Anthropic, Google, or xAI accounts' },
    { num: '02', title: 'Configure Strategy', desc: 'Set failover rules, load balancing, and routing priorities' },
    { num: '03', title: 'Start Building', desc: 'Use one API endpoint for all your AI applications' }
  ]
</script>

<div class="landing">
  <!-- Nav -->
  <nav class="landing-nav">
    <div class="nav-inner">
      <a href="/" class="nav-brand">
        <span class="fox">🦊</span>
        <span class="brand-text">fudrouter</span>
      </a>
      <div class="nav-links">
        <a href="#features">Features</a>
        <a href="#how">How it Works</a>
        <a href="https://docs.fudrouter.dev" target="_blank">Docs</a>
      </div>
      <div class="nav-cta">
        <a href="/login" class="btn btn-ghost">Sign In</a>
        <a href="/dashboard" class="btn btn-primary">Open Dashboard</a>
      </div>
      <button class="mobile-menu-btn" onclick={() => {}}>☰</button>
    </div>
  </nav>

  <!-- Hero -->
  <section class="hero">
    <div class="hero-bg"></div>
    <div class="hero-content">
      <div class="hero-badge">
        <span class="badge-dot"></span>
        v1.0 — Production Ready
      </div>
      <h1 class="hero-title">
        One API for<br>
        <span class="hero-gradient">Every AI Provider</span>
      </h1>
      <p class="hero-sub">
        Unified proxy with smart failover, real-time analytics, and transparent MITM routing.<br>
        Built for developers who refuse to be locked in.
      </p>
      <div class="hero-cta">
        <a href="/dashboard" class="btn btn-primary btn-lg">
          Open Dashboard →
        </a>
        <a href="#features" class="btn btn-ghost btn-lg">
          See Features
        </a>
      </div>
      <div class="hero-stats">
        <div class="hero-stat">
          <span class="hero-stat-num">40+</span>
          <span class="hero-stat-label">Providers</span>
        </div>
        <div class="hero-stat">
          <span class="hero-stat-num">99.9%</span>
          <span class="hero-stat-label">Uptime</span>
        </div>
        <div class="hero-stat">
          <span class="hero-stat-num">&lt;5ms</span>
          <span class="hero-stat-label">Latency</span>
        </div>
      </div>
    </div>
  </section>

  <!-- Features -->
  <section id="features" class="features">
    <div class="container">
      <h2 class="section-title">Everything You Need</h2>
      <p class="section-sub">Production-grade AI infrastructure in a single binary</p>
      <div class="feature-grid">
        {#each features as f}
          <div class="feature-card">
            <div class="feature-icon">{f.icon}</div>
            <h3>{f.title}</h3>
            <p>{f.desc}</p>
          </div>
        {/each}
      </div>
    </div>
  </section>

  <!-- How It Works -->
  <section id="how" class="how">
    <div class="container">
      <h2 class="section-title">How It Works</h2>
      <p class="section-sub">Three steps to AI infrastructure nirvana</p>
      <div class="steps">
        {#each steps as s}
          <div class="step">
            <div class="step-num">{s.num}</div>
            <div class="step-content">
              <h3>{s.title}</h3>
              <p>{s.desc}</p>
            </div>
          </div>
        {/each}
      </div>
    </div>
  </section>

  <!-- CTA -->
  <section class="cta-section">
    <div class="container">
      <div class="cta-card">
        <h2>Ready to unify your AI stack?</h2>
        <p>Deploy in minutes. No dependencies. Pure Go binary.</p>
        <div class="hero-cta">
          <a href="/dashboard" class="btn btn-primary btn-lg">Get Started</a>
          <a href="https://github.com/anvxxr-arch/fudrouter" target="_blank" class="btn btn-ghost btn-lg">
            ⭐ GitHub
          </a>
        </div>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="footer">
    <div class="container">
      <div class="footer-inner">
        <div class="footer-brand">
          <span class="fox">🦊</span>
          <span class="brand-text">fudrouter</span>
        </div>
        <div class="footer-links">
          <a href="https://docs.fudrouter.dev">Docs</a>
          <a href="https://github.com/anvxxr-arch/fudrouter">GitHub</a>
          <a href="/login">Login</a>
        </div>
        <div class="footer-copy">© 2026 fudrouter · Built by Fox 🦊</div>
      </div>
    </div>
  </footer>
</div>

<style>
  .landing {
    min-height: 100vh;
  }

  /* Nav */
  .landing-nav {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 100;
    background: rgba(10, 10, 26, 0.8);
    backdrop-filter: blur(20px);
    border-bottom: 1px solid var(--border);
  }

  .nav-inner {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0.8rem 1.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .nav-brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 700;
    font-size: 1.1rem;
    color: var(--text-primary);
  }

  .fox { font-size: 1.4rem; animation: pulse-glow 3s ease-in-out infinite; }

  .brand-text {
    background: linear-gradient(135deg, var(--accent), var(--accent-bright));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .nav-links {
    display: flex;
    gap: 1.5rem;
  }

  .nav-links a {
    color: var(--text-muted);
    font-size: 0.85rem;
    transition: color var(--transition);
  }

  .nav-links a:hover { color: var(--accent); }

  .nav-cta {
    display: flex;
    gap: 0.5rem;
  }

  .mobile-menu-btn { display: none; }

  /* Hero */
  .hero {
    position: relative;
    padding: 8rem 1.5rem 4rem;
    text-align: center;
    overflow: hidden;
  }

  .hero-bg {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse at center, rgba(232, 168, 124, 0.08) 0%, transparent 60%),
      radial-gradient(ellipse at 30% 20%, rgba(94, 200, 255, 0.05) 0%, transparent 50%);
    pointer-events: none;
    z-index: -1;
  }

  .hero-content {
    max-width: 800px;
    margin: 0 auto;
  }

  .hero-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.9rem;
    border-radius: 100px;
    background: rgba(232, 168, 124, 0.08);
    border: 1px solid var(--border);
    font-size: 0.75rem;
    color: var(--accent);
    margin-bottom: 1.5rem;
  }

  .badge-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--success);
    animation: pulse-glow 2s ease-in-out infinite;
  }

  .hero-title {
    font-size: clamp(2.5rem, 5vw, 4rem);
    font-weight: 800;
    line-height: 1.1;
    margin-bottom: 1.2rem;
    letter-spacing: -0.04em;
  }

  .hero-gradient {
    background: linear-gradient(135deg, var(--accent), var(--accent-bright));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .hero-sub {
    font-size: 1.1rem;
    color: var(--text-muted);
    line-height: 1.7;
    margin-bottom: 2rem;
  }

  .hero-cta {
    display: flex;
    gap: 0.8rem;
    justify-content: center;
    flex-wrap: wrap;
    margin-bottom: 3rem;
  }

  .btn-lg {
    padding: 0.7rem 1.5rem;
    font-size: 0.95rem;
  }

  .hero-stats {
    display: flex;
    gap: 3rem;
    justify-content: center;
  }

  .hero-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
  }

  .hero-stat-num {
    font-size: 1.6rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .hero-stat-label {
    font-size: 0.7rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* Sections */
  .container {
    max-width: 1100px;
    margin: 0 auto;
    padding: 0 1.5rem;
  }

  .section-title {
    font-size: 2rem;
    font-weight: 700;
    text-align: center;
    margin-bottom: 0.5rem;
    letter-spacing: -0.03em;
  }

  .section-sub {
    text-align: center;
    color: var(--text-muted);
    margin-bottom: 3rem;
  }

  /* Features */
  .features {
    padding: 5rem 0;
  }

  .feature-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 1.2rem;
  }

  .feature-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.5rem;
    transition: all var(--transition);
  }

  .feature-card:hover {
    border-color: var(--border-glow);
    box-shadow: var(--shadow-glow);
    transform: translateY(-3px);
  }

  .feature-icon {
    font-size: 1.8rem;
    margin-bottom: 0.8rem;
  }

  .feature-card h3 {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 0.4rem;
  }

  .feature-card p {
    font-size: 0.85rem;
    color: var(--text-muted);
    line-height: 1.5;
  }

  /* How */
  .how {
    padding: 5rem 0;
  }

  .steps {
    max-width: 600px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .step {
    display: flex;
    gap: 1.2rem;
    align-items: flex-start;
  }

  .step-num {
    font-size: 2rem;
    font-weight: 800;
    color: var(--accent-dim);
    line-height: 1;
    flex-shrink: 0;
    min-width: 60px;
  }

  .step-content h3 {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 0.3rem;
  }

  .step-content p {
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  /* CTA */
  .cta-section {
    padding: 4rem 0 6rem;
  }

  .cta-card {
    background: linear-gradient(135deg, rgba(232, 168, 124, 0.06), rgba(232, 168, 124, 0.02));
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 3rem 2rem;
    text-align: center;
  }

  .cta-card h2 {
    font-size: 1.8rem;
    font-weight: 700;
    margin-bottom: 0.5rem;
  }

  .cta-card p {
    color: var(--text-muted);
    margin-bottom: 1.5rem;
  }

  /* Footer */
  .footer {
    border-top: 1px solid var(--border);
    padding: 2rem 0;
  }

  .footer-inner {
    max-width: 1100px;
    margin: 0 auto;
    padding: 0 1.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .footer-brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .footer-links {
    display: flex;
    gap: 1.5rem;
  }

  .footer-links a {
    color: var(--text-muted);
    font-size: 0.85rem;
    transition: color var(--transition);
  }

  .footer-links a:hover { color: var(--accent); }

  .footer-copy {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  /* Responsive */
  @media (max-width: 768px) {
    .nav-links { display: none; }
    .nav-cta { display: none; }
    .mobile-menu-btn { display: block; }
    .hero { padding: 6rem 1rem 3rem; }
    .hero-stats { gap: 1.5rem; }
    .feature-grid { grid-template-columns: 1fr; }
    .footer-inner { flex-direction: column; text-align: center; }
  }
</style>
