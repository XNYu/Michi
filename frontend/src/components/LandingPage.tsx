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

            </section>

            <ChainViz />
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
            <div className="landing-chain__canvas">
                <svg
                    className="landing-chain__edges"
                    viewBox="0 0 1200 680"
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
                    </defs>

                    {/* A → B, C, D */}
                    <path d="M 270 340 C 300 340, 300 100, 320 100" stroke="url(#landing-edge-grad)" strokeWidth="1.5"  fill="none" />
                    <path d="M 270 340 C 300 340, 300 340, 320 340" stroke="url(#landing-edge-grad)" strokeWidth="1.75" fill="none" />
                    <path d="M 270 340 C 300 340, 300 570, 320 570" stroke="url(#landing-edge-grad)" strokeWidth="1.5"  fill="none" />

                    {/* B → E, F */}
                    <path d="M 590 100 C 620 100, 620 80,  640 80"  stroke="url(#landing-edge-mid)" strokeWidth="1.25" fill="none" />
                    <path d="M 590 100 C 620 100, 620 270, 640 270" stroke="url(#landing-edge-mid)" strokeWidth="1.25" fill="none" />

                    {/* D → G */}
                    <path d="M 590 570 C 620 570, 620 560, 640 560" stroke="url(#landing-edge-mid)" strokeWidth="1.25" fill="none" />

                    {/* E+F+G → Digest (dashed) */}
                    <path
                        d="M 900 270 C 930 270, 930 300, 950 300"
                        stroke="#2f6b4e"
                        strokeOpacity="0.35"
                        strokeWidth="1"
                        fill="none"
                        strokeDasharray="3 3"
                    />
                </svg>

                {/* A — root */}
                <Card
                    className="landing-nc--root"
                    style={{ left: 20, top: 260, width: 250 }}
                    role="user"
                    id=""
                    body="3 days in Tokyo — help me plan. I like culture, food, and anime. What are my options?"
                    foot={
                        <>
                            <span className="landing-nc__chip">
                                <span>⎇</span>3 branches
                            </span>
                        </>
                    }
                />

                {/* B — Culture */}
                <Card
                    style={{ left: 320, top: 20, width: 270 }}
                    role="michi"
                    id=""
                    body={
                        <>
                            <strong>Culture &amp; History</strong>
                            <br />
                            Senso-ji at dawn → Meiji Shrine → Imperial Palace East
                            Gardens → Ueno National Museum. A slow-paced walking
                            itinerary with matcha stops and goshuin collecting along
                            the way. End the day in Yanaka's temple district.
                        </>
                    }
                    foot={
                        <>
                            <span className="landing-nc__chip">⎇ 2</span>
                        </>
                    }
                />
                {/* C — Food */}
                <Card
                    style={{ left: 320, top: 250, width: 270 }}
                    role="michi"
                    id=""
                    body={
                        <>
                            <strong>Food &amp; Izakaya</strong>
                            <br />
                            Tsukiji outer market breakfast → Shibuya ramen alley →
                            Shinjuku Omoide Yokocho izakaya crawl → Shimokitazawa
                            kissaten for dessert. Eat-first, sightsee-second. Budget
                            roughly ¥5,000/day for the full experience.
                        </>
                    }
                    foot={
                        <>
                            <span className="landing-nc__chip">⎇ 1</span>
                        </>
                    }
                />
                {/* D — Anime/Pop */}
                <Card
                    style={{ left: 320, top: 480, width: 270 }}
                    role="michi"
                    id=""
                    body={
                        <>
                            <strong>Anime &amp; Pop Culture</strong>
                            <br />
                            Akihabara electric town → Nakano Broadway vintage figures →
                            teamLab Borderless → Harajuku Takeshita Street. Heavy on
                            shops and exhibits, best on weekdays to avoid weekend crowds.
                        </>
                    }
                    foot={
                        <>
                            <span className="landing-nc__chip">⎇ 1</span>
                        </>
                    }
                />

                {/* E from B */}
                <Card
                    style={{ left: 640, top: 10, width: 260 }}
                    role="michi"
                    id=""
                    body={
                        <>
                            <em>Can I do Meiji Shrine and Senso-ji in one day?</em>
                            <br />
                            Yes — take the Ginza line from Asakusa to Omotesando
                            (25 min). Do Senso-ji early morning when it's empty,
                            then shrine after lunch. You'll have time for Harajuku
                            in between.
                        </>
                    }
                    foot={<span>~8 messages</span>}
                />
                {/* F from B */}
                <Card
                    style={{ left: 640, top: 210, width: 260 }}
                    role="michi"
                    id=""
                    body={
                        <>
                            <em>What else is near Ueno besides the museum?</em>
                            <br />
                            Ameyoko market (street food + bargain shopping), Ueno
                            Park zoo, Shinobazu Pond, and Yanaka — an old-Tokyo
                            neighborhood with quiet temples and famous cats.
                        </>
                    }
                    foot={<span>~5 messages</span>}
                />
                {/* G from D */}
                <Card
                    style={{ left: 640, top: 470, width: 260 }}
                    role="michi"
                    id=""
                    body={
                        <>
                            <em>Best shops for second-hand figures in Akihabara?</em>
                            <br />
                            Mandarake Complex (4F for figures), TRADERS Akihabara,
                            and Surugaya — all within a 5-min walk of the station.
                            Go on weekday mornings for the best selection.
                        </>
                    }
                    foot={<span>~6 messages</span>}
                />

                {/* Digest */}
                <Card
                    className="landing-nc--digest"
                    style={{ left: 950, top: 200, width: 230 }}
                    role="digest"
                    id=""
                    body={
                        <>
                            <strong>Your 3-Day Tokyo Plan</strong>
                            <br />
                            Day 1: Asakusa + Ueno (culture + Ameyoko lunch).
                            Day 2: Akihabara + Nakano + Harajuku.
                            Day 3: Tsukiji breakfast → Shibuya → Shinjuku izakaya
                            night. All connected by Yamanote line.
                        </>
                    }
                    foot={
                        <span className="landing-nc__chip landing-nc__chip--digest">
                            ⊕ 3 branches merged
                        </span>
                    }
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
