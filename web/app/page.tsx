const CHROME_STORE_URL = "https://chrome.google.com/webstore/detail/vaulty-agent";
const PLANS_URL = "https://www.vaulty.ca/plans";
const ONBOARDING_URL = "https://www.vaulty.ca/onboarding";

const LogoSVG = ({ size = 20 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 20 20"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M4 4L10 16L16 4"
      stroke="white"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ChromeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
    <circle cx="12" cy="12" r="4" fill="currentColor" />
    <path d="M12 8H21.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
    <path d="M7.5 15.5L3 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
    <path d="M16.5 15.5L21 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0" />
    <path d="M7.5 15.5L12.5 20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
  </svg>
);

export default function Home() {
  return (
    <main>

      {/* ── NAVBAR ─────────────────────────────────────────────────────── */}
      <header className="navbar">
        <div className="container navbar-inner">
          <a href="/" className="navbar-brand">
            <span className="logo-mark">
              <LogoSVG size={18} />
            </span>
            <span className="logo-wordmark">Vaulty Agent</span>
          </a>
          <nav className="navbar-nav">
            <a
              href={ONBOARDING_URL}
              className="nav-link"
              target="_blank"
              rel="noopener noreferrer"
            >
              Start
            </a>
            <a
              href={CHROME_STORE_URL}
              className="btn-primary"
              target="_blank"
              rel="noopener noreferrer"
            >
              <ChromeIcon />
              Add to Chrome
            </a>
          </nav>
        </div>
      </header>

      {/* ── HERO ───────────────────────────────────────────────────────── */}
      <section className="hero">
        <div className="container hero-inner">

          {/* Copy */}
          <div className="hero-content">
            <div className="hero-badge">
              <span className="hero-badge-dot" />
              AI-Powered Chrome Extension
            </div>
            <h1 className="hero-headline">
              Fill any form.{" "}
              <span className="hero-headline-gradient">Instantly.</span>
            </h1>
            <p className="hero-subheadline">
              Vaulty Agent reads your saved profile and fills web forms for you —
              job applications, sign-ups, surveys — in seconds. Plus an AI Copilot
              that lives right in your browser.
            </p>
            <div className="hero-ctas">
              <a
                href={CHROME_STORE_URL}
                className="btn-hero-primary"
                target="_blank"
                rel="noopener noreferrer"
              >
                Add to Chrome
              </a>
              <a
                href={PLANS_URL}
                className="btn-hero-secondary"
                target="_blank"
                rel="noopener noreferrer"
              >
                View Plans →
              </a>
            </div>
          </div>

          {/* Extension Mockup */}
          <div className="hero-visual">
            <div className="hero-visual-glow" />
            <div className="mockup-card">
              <div className="mockup-header">
                <div className="mockup-brand-row">
                  <span className="mockup-logo">
                    <LogoSVG size={13} />
                  </span>
                  <span className="mockup-brand-name">Vaulty</span>
                  <span className="mockup-brand-sub">Agent</span>
                </div>
                <span className="mockup-logout-btn">Sign out</span>
              </div>
              <div className="mockup-tabs">
                <span className="mockup-tab active">Apply</span>
                <span className="mockup-tab">Copilot</span>
                <span className="mockup-tab">Profile</span>
                <span className="mockup-tab">Settings</span>
              </div>
              <div className="mockup-body">
                <div className="mockup-status-box">
                  <span className="mockup-status-icon">✅</span>
                  <span className="mockup-status-text">
                    Ready. Open a form page and click Fill.
                  </span>
                </div>
                <div className="mockup-fill-btn-wrap">
                  <div className="mockup-fill-btn">
                    Fill This<br />Form
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>
      </section>

      {/* ── TRUST BAR ──────────────────────────────────────────────────── */}
      <div className="trust-bar">
        <div className="container trust-bar-inner">
          <div className="trust-item">
            <span className="trust-icon">🔒</span>
            Data never used for AI training
          </div>
          <div className="trust-item">
            <span className="trust-icon">⚡</span>
            Fills forms in under 5 seconds
          </div>
          <div className="trust-item">
            <span className="trust-icon">📋</span>
            Full action log for every fill
          </div>
          <div className="trust-item">
            <span className="trust-icon">🌐</span>
            Works on any website
          </div>
        </div>
      </div>

      {/* ── FEATURES ───────────────────────────────────────────────────── */}
      <section className="features">
        <div className="container">
          <div className="section-header">
            <span className="section-label">Features</span>
            <h2 className="section-title">Everything you need, nothing you don&apos;t</h2>
            <p className="section-subtitle">
              One extension that handles forms, assists with tasks, and keeps your
              data private — on every site.
            </p>
          </div>
          <div className="features-grid">

            <div className="feature-card">
              <div className="feature-icon-wrap">⚡</div>
              <h3 className="feature-title">Auto-Fill Forms</h3>
              <p className="feature-description">
                AI detects every form field on the page and fills it using your saved
                profile — names, addresses, demographics — in a single click.
              </p>
            </div>

            <div className="feature-card">
              <div className="feature-icon-wrap">🤖</div>
              <h3 className="feature-title">AI Copilot</h3>
              <p className="feature-description">
                Summarize long pages, draft replies to emails, quiz yourself on
                articles, or ask any question — all without ever leaving the tab.
              </p>
            </div>

            <div className="feature-card">
              <div className="feature-icon-wrap">👤</div>
              <h3 className="feature-title">Smart Profile</h3>
              <p className="feature-description">
                Save your personal, demographic, and contact info once. Vaulty
                intelligently maps it to any form field it encounters on any site.
              </p>
            </div>

            <div className="feature-card">
              <div className="feature-icon-wrap">📋</div>
              <h3 className="feature-title">Transparent Logs</h3>
              <p className="feature-description">
                Every agent action — what was filled, why, and what the AI decided
                — is logged in full detail. You are always in control.
              </p>
            </div>

          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ───────────────────────────────────────────────── */}
      <section className="how-it-works">
        <div className="container">
          <div className="section-header">
            <span className="section-label">How It Works</span>
            <h2 className="section-title">Set up once. Save time forever.</h2>
            <p className="section-subtitle">
              Three steps between you and never manually filling a form again.
            </p>
          </div>
          <div className="steps-grid">

            <div className="step-item">
              <div className="step-number">1</div>
              <div>
                <h3 className="step-title">Install &amp; Sign In</h3>
                <p className="step-description">
                  Add Vaulty Agent from the Chrome Web Store. Sign in with your
                  Vaulty account — a paid subscription unlocks all features.
                </p>
              </div>
            </div>

            <div className="step-item">
              <div className="step-number">2</div>
              <div>
                <h3 className="step-title">Build Your Profile</h3>
                <p className="step-description">
                  Fill in your name, address, contact info, and optional demographic
                  details once in the Profile tab. Done — it persists forever.
                </p>
              </div>
            </div>

            <div className="step-item">
              <div className="step-number">3</div>
              <div>
                <h3 className="step-title">Click Fill, Walk Away</h3>
                <p className="step-description">
                  Navigate to any form. Open the sidepanel and click
                  &ldquo;Fill This Form.&rdquo; Review the log. Move on with your day.
                </p>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* ── PRIVACY / TRUST ────────────────────────────────────────────── */}
      <section className="privacy-section">
        <div className="container">
          <div className="privacy-inner">

            <div className="privacy-text-block">
              <span className="section-label">Privacy First</span>
              <h2 className="privacy-title">
                Your data is processed,<br />never harvested.
              </h2>
              <p className="privacy-body">
                When you click Fill, page content is sent to Vaulty servers for AI
                processing. We use third-party AI providers to understand form
                fields. But we are explicit about what we do not do.
              </p>
              <div className="privacy-commitments">
                <div className="privacy-item">
                  <span className="privacy-check">✓</span>
                  <span className="privacy-item-text">
                    <strong>Not used for AI training.</strong> Your data is processed
                    in-flight and never retained to train models.
                  </span>
                </div>
                <div className="privacy-item">
                  <span className="privacy-check">✓</span>
                  <span className="privacy-item-text">
                    <strong>You control what is sent.</strong> The extension only
                    processes pages when you explicitly click Fill or Assist.
                  </span>
                </div>
                <div className="privacy-item">
                  <span className="privacy-check">✓</span>
                  <span className="privacy-item-text">
                    <strong>Full transparency.</strong> Every action is logged in the
                    extension so you can audit exactly what happened.
                  </span>
                </div>
              </div>
            </div>

            <div className="consent-card">
              <p className="consent-card-title">What you agree to when signing in</p>
              <ul className="consent-card-list">
                <li>
                  <span className="consent-bullet" />
                  Page content is sent to Vaulty servers for AI processing
                </li>
                <li>
                  <span className="consent-bullet" />
                  Data is processed by third-party AI providers
                </li>
                <li>
                  <span className="consent-bullet" />
                  Your data is not used to train AI models
                </li>
                <li>
                  <span className="consent-bullet" />
                  You can review the full{" "}
                  <a
                    href="https://vaulty.ca/privacy"
                    style={{ color: "var(--accent-light)", textDecoration: "underline", textUnderlineOffset: "3px" }}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Privacy Policy
                  </a>{" "}
                  at any time
                </li>
              </ul>
            </div>

          </div>
        </div>
      </section>

      {/* ── CTA SECTION ────────────────────────────────────────────────── */}
      <section className="cta-section">
        <div className="container cta-inner">
          <h2 className="cta-headline">
            Stop filling forms.<br />Start using Vaulty.
          </h2>
          <p className="cta-subheadline">
            One extension. Every form. Seconds, not minutes.
          </p>
          <a
            href={CHROME_STORE_URL}
            className="btn-cta-primary"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ChromeIcon />
            Add to Chrome
          </a>
          <a
            href={PLANS_URL}
            className="cta-secondary-link"
            target="_blank"
            rel="noopener noreferrer"
          >
            No account? View plans at vaulty.ca →
          </a>
        </div>
      </section>

      {/* ── FOOTER ─────────────────────────────────────────────────────── */}
      <footer className="footer">
        <div className="container footer-inner">

          <a
            href="https://vaulty.ca"
            className="footer-brand"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span
              className="logo-mark"
              style={{ width: 26, height: 26, borderRadius: 7 }}
            >
              <LogoSVG size={14} />
            </span>
            <span className="footer-brand-name">Vaulty Agent</span>
          </a>

          <div className="footer-links">
            <a
              href="https://vaulty.ca"
              className="footer-link"
              target="_blank"
              rel="noopener noreferrer"
            >
              vaulty.ca
            </a>
            <span className="footer-sep">·</span>
            <a
              href="https://vaulty.ca/privacy"
              className="footer-link"
              target="_blank"
              rel="noopener noreferrer"
            >
              Privacy Policy
            </a>
            <span className="footer-sep">·</span>
            <a
              href="https://vaulty.ca/contact"
              className="footer-link"
              target="_blank"
              rel="noopener noreferrer"
            >
              Support
            </a>
            <span className="footer-sep">·</span>
            <a
              href={PLANS_URL}
              className="footer-link"
              target="_blank"
              rel="noopener noreferrer"
            >
              Plans
            </a>
          </div>

          <p className="footer-copy">
            © {new Date().getFullYear()} Vaulty. All rights reserved.
          </p>

        </div>
      </footer>

    </main>
  );
}
