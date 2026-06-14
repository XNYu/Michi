import React, { useState } from "react";
import { authClient } from "../services/auth";
import "./LandingPage.css";

/**
 * Pre-auth landing. Shown when the backend reports requireAuth:true and no
 * session cookie is present. Posts to better-auth's /sign-in/social, which
 * redirects to Google and back; on return the cookie is set and App.tsx
 * remounts the real shell.
 *
 * Layout from the Claude Design handoff (michi-login/project/landing.html):
 * topbar → hero (headline + CTA) → branching-tree visualization → footer.
 */
export function LandingPage() {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const onSignIn = async () => {
        setBusy(true);
        setError(null);
        try {
            await authClient.signIn.social({
                provider: "google",
                callbackURL: "/",
            });
        } catch (err) {
            setBusy(false);
            setError((err as Error).message || "Sign-in failed");
        }
    };

    return (
        <main className="landing-root">
            <LandingTopbar onSignIn={onSignIn} busy={busy} />

            <section className="landing-hero">
                <div className="landing-paper" aria-hidden="true" />

                <div className="landing-eyebrow">
                    <span className="landing-eyebrow__rule" />
                    <span className="landing-eyebrow__label">
                        Branching chat for knowledge exploration
                    </span>
                </div>

                <h1 className="landing-headline">
                    Every conversation is a <em>tree.</em>
                </h1>

                <p className="landing-sub">
                    Fork any reply into a parallel branch.{" "}
                    <strong>Compare answers side&#8209;by&#8209;side</strong>,
                    keep every direction you wandered, and weave them back
                    together with digests when you're done. Your API key, your
                    data, your tree.
                </p>

                <div className="landing-cta-row">
                    <button
                        type="button"
                        className="landing-signin-btn"
                        onClick={onSignIn}
                        disabled={busy}
                        aria-label="Sign in with Google"
                    >
                        <GoogleGlyph />
                        <span>{busy ? "Redirecting…" : "Sign in with Google"}</span>
                        <span className="landing-signin-btn__arrow" aria-hidden="true" />
                    </button>
                    <span className="landing-note">
                        <span className="landing-note__dot" />
                        BYO API key &middot; Anthropic, OpenAI, &amp; OpenRouter
                    </span>
                </div>

                {error && (
                    <p className="landing-error" role="alert">
                        {error}
                    </p>
                )}

                <div className="landing-credits" aria-label="meta">
                    <span>
                        Open source &middot; <b>MIT</b>
                    </span>
                    <span>
                        ★ <b>4.2k</b> on GitHub
                    </span>
                    <span>
                        Self-host or <b>cloud</b>
                    </span>
                    <span>
                        <b>Free</b> &middot; bring your own keys
                    </span>
                </div>
            </section>

            <ChainViz />
            <LandingFooter />
        </main>
    );
}

/* ---------- topbar ---------- */

function LandingTopbar({
    onSignIn,
    busy,
}: {
    onSignIn: () => void;
    busy: boolean;
}) {
    return (
        <header className="landing-topbar">
            <div className="landing-topbar__left">
                <a className="landing-brand" href="#" aria-label="michi home">
                    <BrandTreeGlyph />
                    <span>
                        michi<span className="landing-brand__dot" />
                    </span>
                </a>
                <nav className="landing-nav" aria-label="primary">
                    <a href="#">Docs</a>
                    <a href="#">Changelog</a>
                    <a href="#">Blog</a>
                    <a href="#">GitHub</a>
                </nav>
            </div>
            <div className="landing-topbar__right">
                <a
                    href="#"
                    className="landing-version-pill"
                    aria-label="latest changelog"
                >
                    <span className="landing-version-pill__tag">v1.4</span>
                    <span className="landing-version-pill__label">
                        digests &amp; cross-thread refs
                    </span>
                    <span className="landing-version-pill__arrow">→</span>
                </a>
                <button
                    type="button"
                    className="landing-signin-link"
                    onClick={onSignIn}
                    disabled={busy}
                >
                    Sign in
                </button>
            </div>
        </header>
    );
}

/* ---------- chain viz ---------- */

/**
 * The mock's "A typical michi conversation tree" — a static SVG-edge + DOM-card
 * composition that visually demonstrates branching, digests, and tool nodes.
 * Coordinates and copy are lifted directly from the design source so cards
 * align with edges. Width is fixed at 1480px and dissolves at the right edge.
 */
function ChainViz() {
    return (
        <section
            className="landing-chain"
            aria-label="A typical michi conversation tree"
        >
            <div className="landing-chain__title-row">
                <span className="landing-chain__title">
                    A conversation, one week in
                </span>
                <span className="landing-chain__hint">
                    <span>scroll right</span>
                    <span aria-hidden="true">→</span>
                </span>
            </div>

            <div className="landing-chain__canvas">
                <svg
                    className="landing-chain__edges"
                    viewBox="0 0 1480 360"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                >
                    <defs>
                        <linearGradient id="landing-edge-grad" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="#b85d17" stopOpacity="0.45" />
                            <stop offset="100%" stopColor="#b85d17" stopOpacity="0.18" />
                        </linearGradient>
                        <linearGradient id="landing-edge-mid" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="#1c1917" stopOpacity="0.18" />
                            <stop offset="100%" stopColor="#1c1917" stopOpacity="0.06" />
                        </linearGradient>
                        <linearGradient id="landing-edge-end" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="#1c1917" stopOpacity="0.10" />
                            <stop offset="100%" stopColor="#1c1917" stopOpacity="0.02" />
                        </linearGradient>
                    </defs>

                    {/* root → 3 mid branches */}
                    <path d="M 280 195 C 310 195, 310 60,  340 60"  stroke="url(#landing-edge-grad)" strokeWidth="1.5"  fill="none" />
                    <path d="M 280 195 C 310 195, 310 195, 340 195" stroke="url(#landing-edge-grad)" strokeWidth="1.75" fill="none" />
                    <path d="M 280 195 C 310 195, 310 330, 340 330" stroke="url(#landing-edge-grad)" strokeWidth="1.5"  fill="none" />

                    {/* mid → leaf */}
                    <path d="M 580 60  C 610 60,  610 22,  640 22"  stroke="url(#landing-edge-mid)" strokeWidth="1.25" fill="none" />
                    <path d="M 580 60  C 610 60,  610 102, 640 102" stroke="url(#landing-edge-mid)" strokeWidth="1.25" fill="none" />
                    <path d="M 580 195 C 610 195, 610 195, 640 195" stroke="url(#landing-edge-mid)" strokeWidth="1.25" fill="none" />
                    <path d="M 580 330 C 610 330, 610 290, 640 290" stroke="url(#landing-edge-mid)" strokeWidth="1.25" fill="none" />
                    <path d="M 580 330 C 610 330, 610 360, 640 360" stroke="url(#landing-edge-mid)" strokeWidth="1.25" fill="none" />

                    {/* leaf → ghost */}
                    <path d="M 860 22  C 890 22,  890 -5,  920 -5"  stroke="url(#landing-edge-end)" strokeWidth="1" fill="none" />
                    <path d="M 860 22  C 890 22,  890 56,  920 56"  stroke="url(#landing-edge-end)" strokeWidth="1" fill="none" />
                    <path d="M 860 102 C 890 102, 890 120, 920 120" stroke="url(#landing-edge-end)" strokeWidth="1" fill="none" />
                    <path d="M 860 195 C 890 195, 890 180, 920 180" stroke="url(#landing-edge-end)" strokeWidth="1" fill="none" />
                    <path d="M 860 195 C 890 195, 890 230, 920 230" stroke="url(#landing-edge-end)" strokeWidth="1" fill="none" />
                    <path d="M 860 290 C 890 290, 890 290, 920 290" stroke="url(#landing-edge-end)" strokeWidth="1" fill="none" />

                    {/* ghost continuation */}
                    <path d="M 1140 56  C 1180 56,  1180 56,  1220 56"  stroke="url(#landing-edge-end)" strokeWidth="0.8" fill="none" />
                    <path d="M 1140 120 C 1180 120, 1180 130, 1220 130" stroke="url(#landing-edge-end)" strokeWidth="0.8" fill="none" />
                    <path d="M 1140 180 C 1180 180, 1180 180, 1220 180" stroke="url(#landing-edge-end)" strokeWidth="0.8" fill="none" />
                    <path d="M 1140 230 C 1180 230, 1180 230, 1220 230" stroke="url(#landing-edge-end)" strokeWidth="0.8" fill="none" />
                    <path d="M 1140 290 C 1180 290, 1180 300, 1220 300" stroke="url(#landing-edge-end)" strokeWidth="0.8" fill="none" />

                    {/* dashed cross-thread digest reference */}
                    <path
                        d="M 740 132 C 760 160, 760 175, 740 178"
                        stroke="#2f6b4e"
                        strokeOpacity="0.35"
                        strokeWidth="1"
                        fill="none"
                        strokeDasharray="3 3"
                    />
                </svg>

                {/* root */}
                <Card
                    className="landing-nc--root"
                    style={{ left: 40, top: 140, width: 240 }}
                    role="user"
                    id="n-001"
                    body="Why did the Roman Republic collapse in the 1st century BCE? I keep hearing different answers — what's the real cause?"
                    foot={
                        <>
                            <span className="landing-nc__chip">
                                <span>⎇</span>3 branches
                            </span>
                            <span>Mar 14</span>
                        </>
                    }
                />

                {/* col 2 */}
                <Card
                    style={{ left: 340, top: 20, width: 240 }}
                    role="michi"
                    id="n-002 · sonnet"
                    body={
                        <>
                            Several causes overlap. The <em>Marian reforms</em> (107 BCE)
                            turned legions into client armies loyal to generals, not the
                            Senate. Soldiers expected land from their commanders…
                        </>
                    }
                    foot={
                        <>
                            <span className="landing-nc__chip">⎇ 2</span>
                            <span>military · structural</span>
                        </>
                    }
                />
                <Card
                    style={{ left: 340, top: 155, width: 240 }}
                    role="michi"
                    id="n-003 · opus"
                    body={
                        <>
                            Land concentration is the structural answer — the{" "}
                            <em>latifundia</em> displaced the smallholder class that had fed
                            the legions. The Gracchi tried reform; the senate killed them.
                        </>
                    }
                    foot={
                        <>
                            <span className="landing-nc__chip">⎇ 1</span>
                            <span>economic · class</span>
                        </>
                    }
                />
                <Card
                    style={{ left: 340, top: 290, width: 240 }}
                    role="michi"
                    id="n-004 · sonnet"
                    body="Personality. Sulla, Pompey, Caesar — each used the army as a personal political tool. The institutions never recovered from the Sullan precedent of marching on Rome."
                    foot={
                        <>
                            <span className="landing-nc__chip">⎇ 2</span>
                            <span>great-men theory</span>
                        </>
                    }
                />

                {/* col 3 */}
                <Card
                    style={{ left: 640, top: -7, width: 220 }}
                    role="user"
                    id="n-005"
                    body="Wait — what were the Marian reforms specifically? Spell it out."
                    foot={<span>~14 messages</span>}
                />
                <Card
                    className="landing-nc--digest"
                    style={{ left: 640, top: 73, width: 220 }}
                    role="digest"
                    id="d-006"
                    body={'Summary of "Sulla\'s march on Rome" thread — 4 sources, 23 turns. Precedent of using the legions against the city itself.'}
                    foot={
                        <span className="landing-nc__chip landing-nc__chip--digest">
                            ⊕ 4 sources
                        </span>
                    }
                />
                <Card
                    style={{ left: 640, top: 165, width: 220 }}
                    role="user"
                    id="n-007"
                    body="How did the Senate actually respond to the Gracchi? Like, mechanically — who voted what?"
                    foot={<span>~6 messages</span>}
                />
                <Card
                    style={{ left: 640, top: 260, width: 220 }}
                    role="user"
                    id="n-008"
                    body="Counterfactual: was civil war inevitable after Sulla, or did the Republic still have a chance?"
                    foot={<span>~9 messages</span>}
                />
                <Card
                    className="landing-nc--tool"
                    style={{ left: 640, top: 330, width: 220 }}
                    role="tool"
                    roleLabel="tool · web"
                    id="t-009"
                    body={
                        <>
                            → fetched 3 sources
                            <br />
                            brill.com · jstor · loeb
                        </>
                    }
                    foot={<span>2.4s · 312 tokens</span>}
                />

                {/* col 4 — ghost */}
                <Card
                    className="landing-nc--ghost"
                    style={{ left: 920, top: -20, width: 200 }}
                    role="michi"
                    id="n-010"
                    body='Marius reduced the property qualification for legionary service — the "head count" (capite censi) were now eligible…'
                    foot={<span>⎇ 1</span>}
                />
                <Card
                    className="landing-nc--ghost"
                    style={{ left: 920, top: 38, width: 200 }}
                    role="michi"
                    id="n-011"
                    body="Soldiers no longer had a farm to return to, so they looked to their commander for land grants…"
                    foot={<span>⎇ 0</span>}
                />
                <Card
                    className="landing-nc--ghost"
                    style={{ left: 920, top: 100, width: 200 }}
                    role="michi"
                    id="n-012"
                    body="The Senate's reaction was procedural at first — they declared the lex Sempronia agraria unconstitutional…"
                    foot={<span>⎇ 0</span>}
                />
                <Card
                    className="landing-nc--ghost"
                    style={{ left: 920, top: 162, width: 200 }}
                    role="user"
                    id="n-013"
                    body="Hold on. So who was on the senatorial faction?"
                    foot={<span>~3 msg</span>}
                />
                <Card
                    className="landing-nc--ghost"
                    style={{ left: 920, top: 212, width: 200 }}
                    role="michi"
                    id="n-014"
                    body="The optimates — Scipio Nasica chief among them. He led the mob that killed Tiberius…"
                    foot={<span>⎇ 0</span>}
                />
                <Card
                    className="landing-nc--ghost"
                    style={{ left: 920, top: 272, width: 200 }}
                    role="michi"
                    id="n-015"
                    body="Probably not inevitable. The Sertorian war in Spain offered an off-ramp, but Pompey foreclosed it…"
                    foot={<span>⎇ 0</span>}
                />

                {/* col 5 — single faded marker */}
                <Card
                    className="landing-nc--ghost"
                    style={{ left: 1220, top: 160, width: 160, opacity: 0.18 }}
                    role="michi"
                    id="…"
                    body="…"
                />
            </div>

            <div className="landing-chain__fade" aria-hidden="true" />
        </section>
    );
}

type CardRole = "user" | "michi" | "digest" | "tool";

function Card({
    role,
    roleLabel,
    id,
    body,
    foot,
    className = "",
    style,
}: {
    role: CardRole;
    roleLabel?: string;
    id: string;
    body: React.ReactNode;
    foot?: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
}) {
    return (
        <article className={`landing-nc ${className}`} style={style}>
            <header className="landing-nc__head">
                <span className={`landing-nc__role landing-nc__role--${role}`}>
                    {roleLabel ?? role}
                </span>
                <span className="landing-nc__id">{id}</span>
            </header>
            <p className="landing-nc__body">{body}</p>
            {foot && <div className="landing-nc__foot">{foot}</div>}
        </article>
    );
}

/* ---------- footer ---------- */

function LandingFooter() {
    return (
        <footer className="landing-footer">
            <div className="landing-footer__inner">
                <div className="landing-footer__col landing-footer__brand">
                    <a className="landing-brand" href="#">
                        <BrandTreeGlyph />
                        <span>
                            michi<span className="landing-brand__dot" />
                        </span>
                    </a>
                    <p>
                        Branching chat for knowledge exploration. Open source.
                        Bring your own API key. Built for the kind of thinking
                        that doesn't end at one answer.
                    </p>
                </div>

                <div className="landing-footer__col">
                    <h6>Product</h6>
                    <ul>
                        <li><a href="#">Download</a></li>
                        <li><a href="#">Self-host guide</a></li>
                        <li>
                            <a href="#">
                                Pricing<span className="landing-meta">free</span>
                            </a>
                        </li>
                        <li><a href="#">Roadmap</a></li>
                    </ul>
                </div>

                <div className="landing-footer__col">
                    <h6>Resources</h6>
                    <ul>
                        <li><a href="#">Docs</a></li>
                        <li>
                            <a href="#">
                                Changelog<span className="landing-meta">v1.4</span>
                            </a>
                        </li>
                        <li><a href="#">Developer blog</a></li>
                        <li><a href="#">RSS</a></li>
                    </ul>
                </div>

                <div className="landing-footer__col">
                    <h6>Community</h6>
                    <ul>
                        <li>
                            <a href="#">
                                GitHub<span className="landing-meta">★ 4.2k</span>
                            </a>
                        </li>
                        <li><a href="#">Discord</a></li>
                        <li><a href="#">Mastodon</a></li>
                        <li><a href="#">Status</a></li>
                    </ul>
                </div>
            </div>
            <div className="landing-footer__legal">
                <span>© 2026 michi project · MIT licensed</span>
                <nav>
                    <a href="#">Privacy</a>
                    <a href="#">Terms</a>
                    <a href="#">Security</a>
                    <a href="#">Contact</a>
                </nav>
            </div>
        </footer>
    );
}

/* ---------- glyphs ---------- */

function BrandTreeGlyph() {
    return (
        <svg
            className="landing-brand__tree"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <circle cx="5" cy="6" r="2" />
            <circle cx="5" cy="18" r="2" />
            <circle cx="19" cy="6" r="2" />
            <circle cx="19" cy="12" r="2" />
            <circle cx="19" cy="18" r="2" />
            <path d="M7 6 H 12 a3 3 0 0 1 3 3 v 0" />
            <path d="M7 18 H 12 a3 3 0 0 0 3 -3 v 0" />
            <path d="M7 6 V 18" />
        </svg>
    );
}

function GoogleGlyph() {
    return (
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path
                fill="#4285F4"
                d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
            />
            <path
                fill="#34A853"
                d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
            />
            <path
                fill="#FBBC05"
                d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"
            />
            <path
                fill="#EA4335"
                d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"
            />
        </svg>
    );
}
