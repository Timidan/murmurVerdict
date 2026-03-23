import { useRef, useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(ScrollTrigger);

const CSS = `
/* ── Reset & Root ────────────────────────────────────────────────────────── */
html,body{background:#0a0a0e}
.lp{--bg:#0a0a0e;--s1:#101014;--s2:#151519;--brd:#1a1a1f;--t1:#e4e4e7;--t2:#a1a1aa;--t3:#71717a;--t4:#3f3f46;--accent:#10b981;--am:rgba(16,185,129,.12);--ab:rgba(16,185,129,.25);background:var(--bg);color:var(--t1);font-family:'Outfit',system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
.lp *,.lp *::before,.lp *::after{box-sizing:border-box;margin:0;padding:0}
a{color:inherit;text-decoration:none}

/* ── Floating Pill Nav ───────────────────────────────────────────────────── */
.ln{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:100;display:flex;align-items:center;gap:32px;padding:12px 24px;background:rgba(16,16,20,.75);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.06);border-radius:100px;font-size:13px}
.ln-brand{font-family:'Geist Mono',monospace;display:flex;align-items:center;gap:6px;font-weight:700;letter-spacing:1.5px;font-size:14px;white-space:nowrap}
.ln-links{display:flex;align-items:center;gap:24px;color:var(--t3)}
.ln-links a:hover{color:var(--t1)}
.ln-cta{background:var(--accent);color:#0a0a0e;padding:7px 18px;border-radius:100px;font-family:'Outfit',sans-serif;font-size:12px;font-weight:600;border:none;cursor:pointer;transition:opacity .15s}
.ln-cta:hover{opacity:.85}

/* ── Hero ────────────────────────────────────────────────────────────────── */
.lh{min-height:100dvh;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:120px 24px 80px;position:relative;overflow:hidden;background:url('https://images.unsplash.com/photo-1534796636912-3b95b3ab5986?w=1920&q=80') center/cover no-repeat}
.lh::before{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,10,14,.92) 0%,rgba(10,10,14,.85) 40%,rgba(10,10,14,.95) 100%);pointer-events:none}
.lh-eyebrow{font-family:'Geist Mono',monospace;font-size:11px;letter-spacing:3px;color:var(--accent);text-transform:uppercase;margin-bottom:24px}
.lh-title{font-size:clamp(2.8rem,6vw,4.5rem);font-weight:700;line-height:1.05;letter-spacing:-.04em;max-width:14ch;margin-bottom:24px}
.lh-title em{font-style:italic;font-family:'Instrument Serif','Georgia',serif;font-weight:400;color:var(--t2)}
.lh-desc{font-size:17px;color:var(--t3);line-height:1.6;max-width:48ch;margin-bottom:36px}
.lh-actions{display:flex;gap:12px;align-items:center;margin-bottom:48px}
.lh-primary{background:var(--accent);color:#0a0a0e;padding:14px 32px;border-radius:100px;font-size:14px;font-weight:600;border:none;cursor:pointer;font-family:'Outfit',sans-serif;transition:transform .15s}
.lh-primary:active{transform:scale(.97)}
.lh-ghost{color:var(--t3);padding:14px 32px;border-radius:100px;font-size:14px;font-weight:500;border:1px solid var(--brd);cursor:pointer;font-family:'Outfit',sans-serif;background:transparent}
.lh-proof{font-family:'Geist Mono',monospace;font-size:11px;color:var(--t4);letter-spacing:1px;display:flex;align-items:center;gap:8px}
.lh-proof .dot{width:6px;height:6px;border-radius:50%;background:var(--accent);display:inline-block}
/* Glitch ASCII logo — exact showcase #20 at 14px, scaled via transform */
.lh-logo{position:relative;z-index:2;margin-bottom:60px;display:flex;justify-content:center}
.lh-logo-inner{transform:scale(clamp(1.8,4vw,3.5));transform-origin:center center}
.lh-logo-inner pre{font-family:'JetBrains Mono','Fira Code',monospace;white-space:pre;line-height:1.2;font-size:14px;margin:0;text-align:center;user-select:none}
.lh-logo-inner .gp{color:#f472b6;text-shadow:0 0 10px #ff006e,0 0 30px rgba(255,0,110,.3)}
.lh-logo-inner .gc{color:#67e8f9;text-shadow:0 0 10px #00d4ff,0 0 30px rgba(0,212,255,.3)}
.lh-logo-inner .gt{color:#a78bfa;text-shadow:0 0 10px #7c3aed,0 0 30px rgba(124,58,237,.3)}
.lh-logo-inner .gd{color:#334155}
.lh-logo-inner .gm{color:#52525b}

/* Grid lines behind hero */
.lh-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.03) 1px,transparent 1px);background-size:60px 60px;pointer-events:none;mask-image:radial-gradient(ellipse 80% 70% at 50% 50%,black 10%,transparent 60%)}

/* ── Feature Cards Section ───────────────────────────────────────────────── */
.lf{padding:0 40px 120px}
.lf-header{text-align:center;padding:100px 24px 64px}
.lf-label{font-family:'Geist Mono',monospace;font-size:11px;letter-spacing:3px;color:var(--t4);text-transform:uppercase;margin-bottom:16px}
.lf-title{font-size:clamp(1.8rem,3.5vw,2.8rem);font-weight:700;letter-spacing:-.02em;max-width:28ch;margin:0 auto;line-height:1.1}
.lf-title em{font-style:italic;font-family:'Instrument Serif','Georgia',serif;font-weight:400;color:var(--t2)}

/* Big rounded cards — mandate style */
.lf-cards{display:flex;flex-direction:column;gap:16px;max-width:1100px;margin:0 auto}
.lf-card{display:grid;grid-template-columns:1fr 1fr;background:var(--s1);border:1px solid var(--brd);border-radius:24px;overflow:hidden;min-height:420px}
.lf-card:nth-child(even){direction:rtl}
.lf-card:nth-child(even)>*{direction:ltr}
.lf-card-text{padding:56px 48px;display:flex;flex-direction:column;justify-content:center;gap:16px}
.lf-card-num{font-family:'Geist Mono',monospace;font-size:64px;font-weight:800;color:rgba(255,255,255,.04);line-height:1;margin-bottom:8px}
.lf-card-step{font-family:'Geist Mono',monospace;font-size:11px;color:var(--accent);letter-spacing:2px;text-transform:uppercase}
.lf-card-name{font-size:28px;font-weight:700;letter-spacing:-.01em;line-height:1.15}
.lf-card-desc{font-size:14px;color:var(--t3);line-height:1.65;max-width:38ch}
.lf-card-visual{background:var(--s2);display:flex;align-items:center;justify-content:center;padding:40px;position:relative;overflow:hidden}
/* Subtle grid inside visual */
.lf-card-visual::before{content:'';position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.02) 1px,transparent 1px);background-size:32px 32px;pointer-events:none;opacity:.5}

/* Terminal mock inside feature cards */
.lt{background:rgba(10,10,14,.9);border:1px solid var(--brd);border-radius:12px;padding:16px 20px;width:100%;max-width:340px;font-family:'Geist Mono',monospace;font-size:12px;line-height:1.7;position:relative;z-index:1}
.lt-bar{display:flex;gap:6px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--brd)}
.lt-dot{width:8px;height:8px;border-radius:50%}

/* ── Stats Band ──────────────────────────────────────────────────────────── */
.ls{display:grid;grid-template-columns:repeat(4,1fr);max-width:1100px;margin:0 auto 120px;background:var(--s1);border:1px solid var(--brd);border-radius:20px;overflow:hidden}
.ls-item{padding:40px 32px;text-align:center;position:relative}
.ls-item+.ls-item::before{content:'';position:absolute;left:0;top:20%;height:60%;width:1px;background:var(--brd)}
.ls-val{font-family:'Geist Mono',monospace;font-size:28px;font-weight:700;margin-bottom:6px}
.ls-label{font-size:12px;color:var(--t3)}

/* ── Sponsors ────────────────────────────────────────────────────────────── */
.lsp{padding:0 40px 100px}
.lsp-inner{max-width:1100px;margin:0 auto;text-align:center}
.lsp-label{font-family:'Geist Mono',monospace;font-size:10px;letter-spacing:3px;color:var(--t4);text-transform:uppercase;margin-bottom:28px}
.lsp-grid{display:flex;gap:40px;align-items:center;justify-content:center;flex-wrap:wrap}
.lsp-name{opacity:.7;transition:opacity .3s;display:inline-flex;align-items:center;flex-direction:column;gap:8px}
.lsp-name:hover{opacity:1}
.lsp-logo{height:40px;width:auto;max-width:120px;object-fit:contain}
.lsp-logo[data-invert]{filter:invert(1)}
.lsp-txt{font-family:'Geist Mono',monospace;font-size:11px;color:var(--t4)}

/* ── CTA Band ────────────────────────────────────────────────────────────── */
.lc{padding:0 40px 100px}
.lc-inner{max-width:1100px;margin:0 auto;background:linear-gradient(135deg,rgba(16,185,129,.08) 0%,rgba(16,185,129,.02) 100%);border:1px solid rgba(16,185,129,.12);border-radius:24px;padding:72px 64px;display:grid;grid-template-columns:1.3fr 1fr;gap:48px;align-items:center}
.lc-title{font-size:clamp(1.8rem,3vw,2.5rem);font-weight:700;letter-spacing:-.03em;line-height:1.1}
.lc-title em{font-style:italic;font-family:'Instrument Serif','Georgia',serif;font-weight:400;color:var(--t2)}
.lc-right{display:flex;flex-direction:column;gap:20px}
.lc-desc{font-size:15px;color:var(--t3);line-height:1.6;max-width:42ch}
.lc-actions{display:flex;gap:12px;align-items:center}

/* ── Footer ──────────────────────────────────────────────────────────────── */
.lftr{max-width:1100px;margin:0 auto;padding:48px 40px;border-top:1px solid var(--brd);display:flex;justify-content:space-between;align-items:flex-start;gap:40px}
.lftr-brand{display:flex;flex-direction:column;gap:8px}
.lftr-brand-name{font-family:'Geist Mono',monospace;font-size:16px;font-weight:700;color:var(--t1)}
.lftr-brand-desc{font-size:12px;color:var(--t4);max-width:28ch;line-height:1.5}
.lftr-cols{display:flex;gap:64px}
.lftr-col h4{font-family:'Geist Mono',monospace;font-size:11px;letter-spacing:2px;color:var(--t4);text-transform:uppercase;margin-bottom:12px}
.lftr-col a{display:block;font-size:13px;color:var(--t3);margin-bottom:8px;transition:color .15s}
.lftr-col a:hover{color:var(--t1)}
.lftr-bottom{max-width:1100px;margin:0 auto;padding:20px 40px 40px;display:flex;justify-content:space-between;font-size:11px;color:var(--t4)}

/* ── Responsive ──────────────────────────────────────────────────────────── */
@media(max-width:1024px){
  .lf{padding:0 24px 80px}
  .lf-card{min-height:360px}
  .lf-card-text{padding:40px 32px}
  .lc-inner{padding:56px 40px}
  .ls{margin:0 24px 80px}
}
@media(max-width:768px){
  .ln{top:12px;padding:10px 16px;gap:12px;font-size:12px}
  .ln-links a:not(.ln-cta){display:none}
  .lh{padding:100px 20px 60px}
  .lh-title{font-size:clamp(2rem,8vw,3rem)}
  .lh-ascii{font-size:10px}
  .lf{padding:0 16px 60px}
  .lf-header{padding:60px 16px 40px}
  .lf-card{grid-template-columns:1fr;min-height:auto}
  .lf-card:nth-child(even){direction:ltr}
  .lf-card-text{padding:32px 24px}
  .lf-card-visual{min-height:220px;padding:32px 24px}
  .lf-card-num{font-size:40px}
  .ls{grid-template-columns:1fr 1fr;margin:0 16px 60px;border-radius:16px}
  .ls-item{padding:28px 20px}
  .lsp{padding:0 16px 60px}
  .lc{padding:0 16px 60px}
  .lc-inner{grid-template-columns:1fr;padding:40px 24px;border-radius:16px}
  .lftr{flex-direction:column;padding:32px 16px}
  .lftr-cols{gap:40px}
  .lftr-bottom{padding:16px;flex-direction:column;gap:8px}
}
@media(prefers-reduced-motion:reduce){.lp *,.lp *::before,.lp *::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
`;

// ASCII_LINES removed — replaced by TetrisMlogo canvas component

const SPONSORS = [
  { name: "Santiment",    logo: "/logos/santiment.png",   invert: false },
  { name: "Venice AI",    logo: "/logos/venice.svg",      invert: false },
  { name: "Filecoin",     logo: "/logos/filecoin.png",    invert: false },
  { name: "Blockscout",   logo: "/logos/blockscout.svg",  invert: false },
  { name: "ENS",          logo: "/logos/ens.png",         invert: false },
  { name: "OpenServ",     logo: "/logos/openserv.png",    invert: true },
  { name: "Merit (x402)", logo: "/logos/merit.png",       invert: false },
];

export function Landing() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = CSS;
    document.head.appendChild(el);
    // Load Instrument Serif for italic accents
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@1&display=swap";
    document.head.appendChild(link);
    return () => { document.head.removeChild(el); document.head.removeChild(link); };
  }, []);

  useGSAP(() => {
    if (window.matchMedia("(prefers-reduced-motion:reduce)").matches) return;

    // Hero entrance
    gsap.from(ref.current!.querySelectorAll(".lh-anim"), {
      y: 40, opacity: 0, duration: 1, ease: "power4.out", stagger: 0.12, delay: 0.15,
    });

    // Feature cards slide up
    ref.current!.querySelectorAll(".lf-card").forEach((card) => {
      gsap.from(card, {
        y: 80, opacity: 0, duration: 0.9, ease: "power4.out",
        scrollTrigger: { trigger: card, start: "top 85%" },
      });
    });

    // Stats count
    ref.current!.querySelectorAll(".ls-val").forEach((el) => {
      const n = el.getAttribute("data-n");
      if (n) {
        const num = parseInt(n);
        const suf = el.getAttribute("data-s") || "";
        const obj = { v: 0 };
        gsap.to(obj, {
          v: num, duration: 1.2, ease: "power2.out",
          scrollTrigger: { trigger: el, start: "top 90%" },
          onUpdate() { (el as HTMLElement).textContent = Math.round(obj.v) + suf; },
        });
      } else {
        gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.6, scrollTrigger: { trigger: el, start: "top 90%" } });
      }
    });

    // Sponsors stagger
    gsap.fromTo(ref.current!.querySelectorAll(".lsp-name"),
      { opacity: 0, y: 12 },
      { opacity: 0.7, y: 0, duration: 0.4, stagger: 0.08,
        scrollTrigger: { trigger: ref.current!.querySelector(".lsp"), start: "top 90%" },
      },
    );

    // CTA lift
    const cta = ref.current!.querySelector(".lc-inner");
    if (cta) {
      gsap.from(cta, {
        y: 50, opacity: 0, duration: 1, ease: "power4.out",
        scrollTrigger: { trigger: cta, start: "top 85%" },
      });
    }
  }, { scope: ref });

  const go = () => { window.location.hash = "#/app"; };

  return (
    <div className="lp" ref={ref}>
      {/* ── Nav ──────────────────────────────────────────────── */}
      <nav className="ln">
        <div className="ln-brand">
          <span style={{ color: "#f472b6" }}>{"\u2593\u2593"}</span>
          <span style={{ color: "#67e8f9" }}>{"\u2593\u2593"}</span>
          <span style={{ color: "#a78bfa" }}>MURMUR</span>
        </div>
        <div className="ln-links">
          <a href="#how" onClick={(e) => { e.preventDefault(); document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }); }}>How it works</a>
          <a href="#features" onClick={(e) => { e.preventDefault(); document.getElementById("features")?.scrollIntoView({ behavior: "smooth" }); }}>Features</a>
          <a href="#built" onClick={(e) => { e.preventDefault(); document.getElementById("built")?.scrollIntoView({ behavior: "smooth" }); }}>Built with</a>
          <button className="ln-cta" onClick={go}>Launch App</button>
        </div>
      </nav>

      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className="lh">
        <div className="lh-grid" />
        <div className="lh-logo lh-anim"><div className="lh-logo-inner" dangerouslySetInnerHTML={{ __html: `<pre>
<span class="gp">  ▓▓▓   ▓▓▓                              </span>
<span class="gp">  ▓▓▓▓ ▓▓▓▓ </span><span class="gt">█ █ █▀▄ █▄ ▄█ █ █ █▀▄</span>
<span class="gc">  ▓▓ ▓▓▓ ▓▓ </span><span class="gt">█ █ ██▀ █ ▀ █ █ █ ██▀</span>
<span class="gc">  ▓▓  ▓  ▓▓ </span><span class="gt">▀▀▀ ▀ ▀ ▀   ▀ ▀▀▀ ▀ ▀</span>
<span class="gd">  ░░     ░░ ░░░░░░░░░░░░░░░░░░░░░░░</span>
<span class="gm">        ═══ LISTEN. TRADE. REPEAT. ═══</span></pre>` }} /></div>
        <div className="lh-eyebrow lh-anim">Autonomous DeFi Agent</div>
        <h1 className="lh-title lh-anim">
          It hears the market <em>before the market hears itself.</em>
        </h1>
        <p className="lh-desc lh-anim">
          Connect your wallet. Deposit USDC. Set your risk limits. Murmur trades
          autonomously within your on-chain enforced bounds — every decision
          cryptographically signed and stored on Filecoin.
        </p>
        <div className="lh-actions lh-anim">
          <button className="lh-primary" onClick={go}>Launch App</button>
          <a className="lh-ghost" href="#how">How it works</a>
        </div>
        <div className="lh-proof lh-anim">
          <span className="dot" />
          LIVE ON BASE SEPOLIA &middot; BUILT FOR THE SYNTHESIS HACKATHON
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────── */}
      <div className="lf-header" id="how">
        <div className="lf-label">How it works</div>
        <h2 className="lf-title">Four steps to <em>autonomous trading.</em></h2>
      </div>

      <section className="lf" id="features">
        <div className="lf-cards">
          {/* 01 */}
          <div className="lf-card">
            <div className="lf-card-text">
              <div className="lf-card-num">01</div>
              <div className="lf-card-step">Step 01</div>
              <h3 className="lf-card-name">Connect &amp; Authenticate</h3>
              <p className="lf-card-desc">Sign in with your wallet via RainbowKit on Base Sepolia. A server-side nonce challenge verifies ownership — no passwords, no emails.</p>
            </div>
            <div className="lf-card-visual">
              <div className="lt">
                <div className="lt-bar">
                  <div className="lt-dot" style={{ background: "#ef4444" }} />
                  <div className="lt-dot" style={{ background: "#f59e0b" }} />
                  <div className="lt-dot" style={{ background: "#22c55e" }} />
                </div>
                <div style={{ color: "#71717a" }}>$ murmur auth --wallet</div>
                <div style={{ color: "#22c55e" }}>Nonce issued: 0xa7f3...</div>
                <div style={{ color: "#22c55e" }}>Signature verified</div>
                <div style={{ color: "#e4e4e7" }}>Session active <span style={{ color: "#22c55e" }}>{"\u25CF"}</span></div>
              </div>
            </div>
          </div>

          {/* 02 */}
          <div className="lf-card">
            <div className="lf-card-text">
              <div className="lf-card-num">02</div>
              <div className="lf-card-step">Step 02</div>
              <h3 className="lf-card-name">Deposit to Your Vault</h3>
              <p className="lf-card-desc">Deposit USDC into a non-custodial TradeVault smart contract that you own. Funds never sit in a hot wallet — the agent trades through vault.executeTrade().</p>
            </div>
            <div className="lf-card-visual">
              <div style={{ textAlign: "center", position: "relative", zIndex: 1 }}>
                <div style={{ color: "#71717a", marginBottom: 8, fontFamily: "'Geist Mono',monospace", fontSize: 11, letterSpacing: 2 }}>TRADEVAULT</div>
                <div style={{ fontSize: 36, fontWeight: 700, color: "#22c55e", fontFamily: "'Geist Mono',monospace" }}>$250.00</div>
                <div style={{ color: "#3f3f46", marginTop: 8, fontSize: 12 }}>USDC deposited</div>
                <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "center" }}>
                  <span style={{ background: "rgba(34,197,94,.1)", color: "#22c55e", padding: "4px 12px", borderRadius: 100, fontSize: 11, border: "1px solid rgba(34,197,94,.2)" }}>Active</span>
                  <span style={{ background: "rgba(255,255,255,.04)", color: "#71717a", padding: "4px 12px", borderRadius: 100, fontSize: 11, border: "1px solid rgba(255,255,255,.06)" }}>Non-custodial</span>
                </div>
              </div>
            </div>
          </div>

          {/* 03 */}
          <div className="lf-card">
            <div className="lf-card-text">
              <div className="lf-card-num">03</div>
              <div className="lf-card-step">Step 03</div>
              <h3 className="lf-card-name">Set Boundaries</h3>
              <p className="lf-card-desc">Configure max trade size, risk profile, and daily trade limits. These parameters are enforced on-chain — the agent physically cannot exceed your bounds.</p>
            </div>
            <div className="lf-card-visual">
              <div className="lt">
                <div style={{ color: "#71717a" }}>max_trade_usd: <span style={{ color: "#e4e4e7" }}>$5.00</span></div>
                <div style={{ color: "#71717a" }}>risk_profile:  <span style={{ color: "#f59e0b" }}>balanced</span></div>
                <div style={{ color: "#71717a" }}>daily_limit:   <span style={{ color: "#e4e4e7" }}>10 trades</span></div>
                <div style={{ color: "#71717a" }}>autopilot:     <span style={{ color: "#22c55e" }}>enabled</span></div>
              </div>
            </div>
          </div>

          {/* 04 */}
          <div className="lf-card">
            <div className="lf-card-text">
              <div className="lf-card-num">04</div>
              <div className="lf-card-step">Step 04</div>
              <h3 className="lf-card-name">Agent Trades Autonomously</h3>
              <p className="lf-card-desc">Murmur ingests Santiment social sentiment, scores assets with Venice AI, checks risk gates, and executes trades. Every decision is attested via ERC-8004 and stored on Filecoin.</p>
            </div>
            <div className="lf-card-visual">
              <div className="lt">
                <div className="lt-bar">
                  <div className="lt-dot" style={{ background: "#ef4444" }} />
                  <div className="lt-dot" style={{ background: "#f59e0b" }} />
                  <div className="lt-dot" style={{ background: "#22c55e" }} />
                </div>
                <div style={{ color: "#71717a" }}>cycle_14 <span style={{ color: "#f59e0b" }}>deliberating...</span></div>
                <div style={{ color: "#22c55e" }}>BUY WETH $4.80</div>
                <div style={{ color: "#71717a" }}>risk_gate: <span style={{ color: "#22c55e" }}>7/7 passed</span></div>
                <div style={{ color: "#3b82f6" }}>attested: ipfs://bafk...x7q</div>
                <div style={{ color: "#71717a", marginTop: 4 }}>receipt_hash: <span style={{ color: "#a78bfa" }}>0x8a3f...c21d</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats ────────────────────────────────────────────── */}
      <div className="ls">
        <div className="ls-item">
          <div className="ls-val" data-n="100" data-s="%">0%</div>
          <div className="ls-label">Non-custodial</div>
        </div>
        <div className="ls-item">
          <div className="ls-val">24/7</div>
          <div className="ls-label">Autonomous</div>
        </div>
        <div className="ls-item">
          <div className="ls-val">ERC-8004</div>
          <div className="ls-label">Attested on-chain</div>
        </div>
        <div className="ls-item">
          <div className="ls-val" data-n="7" data-s="">0</div>
          <div className="ls-label">Integrations</div>
        </div>
      </div>

      {/* ── Sponsors ─────────────────────────────────────────── */}
      <section className="lsp" id="built">
        <div className="lsp-inner">
          <div className="lsp-label">Built with</div>
          <div className="lsp-grid">
            {SPONSORS.map((s) => (
              <span key={s.name} className="lsp-name">
                <img src={s.logo} alt={s.name} className="lsp-logo" {...(s.invert ? { "data-invert": "" } : {})} />
                <span className="lsp-txt">{s.name}</span>
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────── */}
      <section className="lc">
        <div className="lc-inner">
          <h2 className="lc-title">Start trading with an agent that <em>listens.</em></h2>
          <div className="lc-right">
            <p className="lc-desc">Connect your wallet on Base Sepolia, fund your vault, and let Murmur handle the rest. Every decision is transparent, attested, and within your control.</p>
            <div className="lc-actions">
              <button className="lh-primary" onClick={go}>Launch App</button>
              <a className="lh-ghost" href="https://github.com" target="_blank" rel="noopener noreferrer">Read the docs</a>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────── */}
      <footer className="lftr">
        <div className="lftr-brand">
          <div className="lftr-brand-name">
            <span style={{ color: "#f472b6" }}>{"\u2593\u2593"}</span>{" "}
            <span style={{ color: "#67e8f9" }}>{"\u2593\u2593"}</span>{" "}
            <span style={{ color: "#a78bfa" }}>MURMUR</span>
          </div>
          <div className="lftr-brand-desc">Autonomous DeFi agent. Sentiment-driven. On-chain attested.</div>
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, fontFamily: "'Geist Mono',monospace", fontSize: 11, color: "#3f3f46" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981", display: "inline-block" }} />
            LIVE ON BASE SEPOLIA
          </div>
        </div>
        <div className="lftr-cols">
          <div className="lftr-col">
            <h4>Product</h4>
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#" onClick={(e) => { e.preventDefault(); go(); }}>Dashboard</a>
          </div>
          <div className="lftr-col">
            <h4>Developers</h4>
            <a href="https://github.com" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href="https://x.com/Timidan_x" target="_blank" rel="noopener noreferrer">Twitter</a>
          </div>
        </div>
      </footer>
      <div className="lftr-bottom">
        <span>&copy; 2026 Murmur</span>
        <span>Built for The Synthesis Hackathon</span>
      </div>
    </div>
  );
}
