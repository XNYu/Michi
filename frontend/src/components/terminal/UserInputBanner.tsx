import React, { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { animate, motion, type AnimationPlaybackControls } from 'motion/react';
import type { UserInputRequest } from '../../state/chatTypes';
import type { UserInputAnswer } from '../../services/chatStreamEvents';
import { usePrefs } from '../../state/prefs';
import { prefersReducedMotion } from '../../hooks/useReducedMotion';
import { DUR, EASE } from '../../motion/tokens';
import { useFresh } from '../../motion/useFresh';
import './UserInputBanner.css';

/**
 * What sending an answer returns. A promise that rejects or resolves `false`
 * means it did not land: the card takes input again at once. Without one the
 * card falls back to a timeout.
 */
type AnswerResult = void | boolean | PromiseLike<unknown>;

interface UserInputBannerProps {
  userInput: UserInputRequest;
  onSubmit: (answers: UserInputAnswer[]) => AnswerResult;
  onSkip: () => AnswerResult;
  readOnly?: boolean;
}

export interface QuestionDetail {
  label?: string;
  value: string;
  /** The value was wrapped in “…”: a quoted text such as a prompt. */
  quoted?: boolean;
}

/** `Label: value`, `Label：value` or `Label → value`, with a short label. */
const DETAIL_LINE = /^([^\s:：→“”"][^:：→“”"]{0,39}?)(?::\s+|：\s*|\s+→\s+)(\S[\s\S]*)$/;
const QUOTED = /^“([\s\S]*)”$/;

/**
 * A question written as a title line followed by one fact per line, at least
 * one of them `Label: value` (approval questions, such as scheduled jobs).
 * Returns null for any other shape, including text separated by a blank line
 * (a message to approve), which keeps rendering as written.
 */
export function questionLayout(text: string): { title: string; details: QuestionDetail[] } | null {
  const lines = text.split('\n').map((line) => line.trim());
  if (lines.length < 2 || lines.some((line) => !line)) return null;
  const details = lines.slice(1).map((line): QuestionDetail => {
    const match = DETAIL_LINE.exec(line);
    if (!match) return { value: line };
    const quoted = QUOTED.exec(match[2]);
    return quoted
      ? { label: match[1].trim(), value: quoted[1], quoted: true }
      : { label: match[1].trim(), value: match[2] };
  });
  if (!details.some((detail) => detail.label)) return null;
  return { title: lines[0], details };
}

function QuestionText({ text }: { text: string }) {
  const layout = questionLayout(text);
  if (!layout) return <span className="ask-card-qtext">{text}</span>;
  return (
    <div className="ask-card-qtext ask-card-qtext-structured">
      <div className="ask-card-qtitle">{layout.title}</div>
      <div className="ask-card-details">
        {layout.details.map((detail, i) => detail.label ? (
          <div key={i} className={`ask-card-detail${detail.quoted ? ' is-quoted' : ''}`}>
            <span className="ask-card-detail-label">{detail.label}</span>
            <span className="ask-card-detail-value">{detail.value}</span>
          </div>
        ) : (
          <div key={i} className="ask-card-detail is-note">{detail.value}</div>
        ))}
      </div>
    </div>
  );
}

/** Delay between picking a single-select option and auto-advancing to the next question. */
const ADVANCE_MS = 320;
/** Horizontal gap between questions in the sliding track. Must match `.ask-track` CSS. */
const TRACK_GAP = 28;

// --- Answered → receipt hand-off ---------------------------------------------
// Answering does not wait for anything: the answer is sent at once and the live
// card marks it (the chosen options take an accent fill, the others fade). The
// receipt replaces the card when the store resolves the request, which is a
// different component (MessageBlock swaps them), so the live card leaves a
// hand-off behind: its height, when the answer was sent, and a frozen copy of
// itself taken as it unmounts. The receipt (in the same commit) finishes the
// marking on that copy, fades it out and collapses from the card's height,
// instead of popping in as if a new question had arrived. Receipts with no
// fresh hand-off (history, remounts, answered elsewhere) render settled.
//
// The copy is visual only: inert, aria-hidden, without labels, and its text
// is drawn as generated content (UserInputBanner.css), so text lookups (find
// in page, Testing Library, Playwright getByText) see the receipt alone.

/** The live card's entrance curve (was `ask-card-in`; also the track's slide). */
const ASK_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
/** Strength of the chosen option's accent fill (the alert bar's 12% tint). */
const FILL_OPACITY = 0.12;
/** The chosen option fills over 120ms while the others fade over 100ms. */
const FILL_S = 0.12;
/** The receipt takes over this long after the answer was sent. */
const MARK_S = 0.14;
/** The receipt: the card collapses over 220ms, the old content leaves over 80ms. */
const COLLAPSE_S = 0.22;
const GHOST_OUT_S = 0.08;
const RECEIPT_IN_S = 0.16;
/** Without a send result to wait on, give the card back after this long. */
const ANSWER_REVERT_MS = 3000;
/** How long after sending a receipt may still take over from the live card. */
const HANDOFF_TTL_MS = 10_000;
/** The copy is taken in the commit that mounts the receipt; older ones are stale. */
const GHOST_FRESH_MS = 250;
const GHOST_TEXT_ATTR = 'data-ask-ghost-text';
/** Attributes that would make the copy findable by label, placeholder, id or test id. */
const GHOST_STRIPPED_ATTRS = ['id', 'aria-live', 'aria-label', 'aria-labelledby', 'aria-describedby', 'title', 'placeholder', 'data-testid'];

interface AskHandoff {
  /** Live card's border-box height when the answer was sent. */
  height: number;
  sentAt: number;
  /** Frozen copy of the live card, taken as it unmounted. */
  ghost?: HTMLElement;
  capturedAt?: number;
}

const handoffs = new Map<string, AskHandoff>();

/** One conversation's request: the pane it sits in (`[data-node-id]`) plus the request. */
function handoffKey(el: Element, userInput: Pick<UserInputRequest, 'requestId' | 'interactionId'>): string {
  const scope = el.closest('[data-node-id]')?.getAttribute('data-node-id') ?? '';
  return `${scope}|${userInput.interactionId ?? `request:${userInput.requestId}`}`;
}

function recordHandoff(key: string, height: number) {
  const now = Date.now();
  for (const [k, entry] of handoffs) if (now - entry.sentAt > HANDOFF_TTL_MS) handoffs.delete(k);
  if (height > 0) handoffs.set(key, { height, sentAt: now });
  else handoffs.delete(key);
}

/** A copy of the live card that can sit over the receipt without being a live layer or findable text. */
function freezeCard(card: HTMLElement, height: number): HTMLElement {
  // motion runs the fades on WAAPI and writes the inline value only when an
  // animation finishes; commit what is on screen so the copy starts from it.
  if (typeof card.getAnimations === 'function') {
    for (const animation of card.getAnimations({ subtree: true })) {
      try { animation.commitStyles(); } catch { /* target not rendered */ }
    }
  }
  const look = getComputedStyle(card);
  const ghost = card.cloneNode(true) as HTMLElement;
  // Not an `.ask-card`: lookups for the live card (focusPendingRequest, tests)
  // must not find it. Its own box comes from the card's computed style.
  ghost.className = 'ask-card-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('inert', '');
  ghost.removeAttribute('data-answering');
  for (const attr of GHOST_STRIPPED_ATTRS) {
    ghost.removeAttribute(attr);
    for (const el of ghost.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
  }
  const walker = document.createTreeWalker(ghost, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  for (const text of texts) {
    if (!text.data.trim()) continue;
    const drawn = document.createElement('span');
    drawn.setAttribute(GHOST_TEXT_ATTR, text.data);
    text.replaceWith(drawn);
  }
  Object.assign(ghost.style, {
    position: 'absolute', top: '0', left: '0', right: '0', height: `${height}px`, margin: '0',
    boxSizing: 'border-box', overflow: 'hidden', zIndex: '1', pointerEvents: 'none',
    display: look.display, flexDirection: look.flexDirection, gap: look.gap, padding: look.padding,
    borderRadius: look.borderRadius, backgroundColor: look.backgroundColor,
    opacity: '1', transform: 'none', animation: 'none', boxShadow: 'none',
  });
  return ghost;
}

function captureGhost(key: string, card: HTMLElement) {
  const entry = handoffs.get(key);
  if (!entry) return;
  entry.ghost = freezeCard(card, entry.height);
  entry.capturedAt = Date.now();
  // Unclaimed (the card left for another reason): let the copy go.
  setTimeout(() => { if (handoffs.get(key) === entry) handoffs.delete(key); }, GHOST_FRESH_MS);
}

interface HandoffClaim {
  entry: AskHandoff & { ghost: HTMLElement };
  /** Seconds of the live card's marking still to play. */
  delay: number;
}

/**
 * Take this receipt's hand-off. Only the first claimant gets it; a stale one
 * (sent too long ago, or copied in an earlier commit because the card left
 * for another reason) is dropped with its copy.
 */
function takeHandoff(key: string): HandoffClaim | null {
  const entry = handoffs.get(key);
  if (!entry) return null;
  handoffs.delete(key);
  const now = Date.now();
  const { ghost, capturedAt } = entry;
  if (!ghost || capturedAt === undefined || now - capturedAt > GHOST_FRESH_MS || now - entry.sentAt > HANDOFF_TTL_MS) return null;
  return { entry: { ...entry, ghost }, delay: Math.max(0, MARK_S - (now - entry.sentAt) / 1000) };
}

/** The hand-off itself, on the receipt's settled DOM. Returns its cleanup. */
function playHandoff(card: HTMLElement, { entry, delay }: HandoffClaim): () => void {
  const { ghost } = entry;
  const body = card.querySelector<HTMLElement>('.ask-card-body');
  const settledHeight = card.offsetHeight;
  const reduce = prefersReducedMotion(document.documentElement.dataset.reduceMotion === 'on');
  Object.assign(card.style, { position: 'relative', isolation: 'isolate', height: `${entry.height}px` });
  if (body) body.style.opacity = '0';
  card.appendChild(ghost);

  const runs: AnimationPlaybackControls[] = [];
  const fills = ghost.querySelectorAll<HTMLElement>('[data-ask-fill]');
  const fades = ghost.querySelectorAll<HTMLElement>('[data-ask-fade]');
  if (delay > 0 && fills.length) runs.push(animate(fills, { opacity: FILL_OPACITY }, { duration: delay, ease: EASE.out }));
  if (delay > 0 && fades.length) runs.push(animate(fades, { opacity: 0 }, { duration: Math.min(delay, DUR.soft), ease: 'linear' }));
  const out = animate(ghost, { opacity: 0 }, { duration: GHOST_OUT_S, delay, ease: 'linear' });
  void out.then(() => ghost.remove());
  const collapse = animate(card, { height: [`${entry.height}px`, `${settledHeight}px`] }, { duration: COLLAPSE_S, delay, ease: EASE.drawer });
  void collapse.then(() => { card.style.height = ''; });
  runs.push(out, collapse);
  if (body) {
    const reveal = animate(body, reduce ? { opacity: [0, 1] } : { opacity: [0, 1], y: [3, 0] },
      { duration: RECEIPT_IN_S, delay: delay + GHOST_OUT_S, ease: EASE.out });
    void reveal.then(() => { body.style.opacity = ''; body.style.transform = ''; });
    runs.push(reveal);
  }
  return () => {
    for (const run of runs) run.stop();
    ghost.remove();
    Object.assign(card.style, { position: '', isolation: '', height: '' });
    if (body) Object.assign(body.style, { opacity: '', transform: '' });
  };
}

/** A chosen option hosts its fill behind its own content. */
const FILL_HOST = { position: 'relative', isolation: 'isolate' } as const;

/** The chosen option's accent fill, laid under its content while answering. */
function AnswerFill() {
  return (
    <motion.span
      aria-hidden
      data-ask-fill=""
      style={{ position: 'absolute', inset: 0, zIndex: -1, borderRadius: 'inherit', background: 'var(--term-accent)', pointerEvents: 'none' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: FILL_OPACITY }}
      transition={{ duration: FILL_S, ease: EASE.out }}
    />
  );
}

function ReceiptBody({ userInput }: { userInput: UserInputRequest }) {
  const { questions, answers } = userInput;
  if (!answers.length) {
    return questions.map((q, i) => <div key={q.id ?? i} className="ask-qa-pair">
      <div className="ask-qa-question">{q.header || q.question}</div>
      <span className="ask-qa-answer skipped">{userInput.interrupted ? '(not answered before the turn ended)' : '(skipped)'}</span>
    </div>);
  }
  return questions.map((q, i) => (
    <div key={i} className="ask-qa-pair">
      <div className="ask-qa-question">{q.header || q.question}</div>
      <div className={`ask-qa-answer${!answers[i]?.answer ? ' skipped' : ''}`}>
        {(answers.find(answer => q.id && answer.id === q.id) ?? answers.find(answer => answer.question === q.question) ?? answers[i])?.answer || '(skipped)'}
      </div>
    </div>
  ));
}

export function ResolvedUserInput({ userInput }: { userInput: UserInputRequest }) {
  const cardRef = useRef<HTMLDivElement>(null);
  /** The claim, once taken: StrictMode re-runs the effect on the same mount. */
  const claimRef = useRef<HandoffClaim | null | undefined>(undefined);
  const { requestId, interactionId } = userInput;

  // Layout effect: the copy is taken while the live card unmounts in this same
  // commit, and the hand-off must be in place before the first paint. Mount
  // only: later renders of the same receipt never replay it.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    if (claimRef.current === undefined) claimRef.current = takeHandoff(handoffKey(card, { requestId, interactionId }));
    return claimRef.current ? playHandoff(card, claimRef.current) : undefined;
  }, [requestId, interactionId]);

  return (
    <div ref={cardRef} className="ask-card ask-resolved">
      <div className="ask-card-body"><ReceiptBody userInput={userInput} /></div>
    </div>
  );
}

export default function UserInputBanner({ userInput, onSubmit, onSkip, readOnly = false }: UserInputBannerProps) {
  const { questions } = userInput;
  const { prefs } = usePrefs();
  const isMultiQuestion = questions.length > 1;
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selections, setSelections] = useState<Map<number, Set<string>>>(() => new Map());
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(() => new Map());
  const [answered, setAnswered] = useState<Set<number>>(() => new Set());

  // --- sliding-track measurements (horizontal slide, viewport height follows) ---
  const viewportRef = useRef<HTMLDivElement>(null);
  const questionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const measuredRef = useRef(false);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [qWidth, setQWidth] = useState<number | undefined>(undefined);
  const [viewH, setViewH] = useState<number | undefined>(undefined);
  const [slideAnim, setSlideAnim] = useState(false);

  // --- answering (see the hand-off notes above ResolvedUserInput) ---
  // `answering` holds from sending until the receipt replaces the card; the
  // ref also stops a second send from Enter or a double click in between. A
  // send that reports failure gives the card back at once; with no result to
  // wait on, a timeout does.
  const [answering, setAnswering] = useState(false);
  const answeringRef = useRef(false);
  const attemptRef = useRef(0);
  const inFlightRef = useRef(false);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentKeyRef = useRef<string | null>(null);
  const cardElRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useCallback((el: HTMLDivElement | null) => {
    cardElRef.current = el;
    if (!el) return;
    return () => {
      cardElRef.current = null;
      if (sentKeyRef.current) captureGhost(sentKeyRef.current, el);
    };
  }, []);

  // Only a request that just arrived plays its entrance; hydrated ones (no
  // stamp) and remounts render settled.
  const enter = useFresh(userInput.receivedAt);

  useEffect(() => () => {
    if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
  }, []);

  const safeIdx = Math.min(currentIdx, Math.max(questions.length - 1, 0));

  // Deterministic X offset: every question is locked to the viewport width, so
  // the active question sits at idx * (width + gap). Computed at render time —
  // no DOM reads, so it can never go stale (a previous version measured
  // offsetLeft inside a ResizeObserver callback whose closure captured the
  // mount-time step index; the height transition itself fired the observer and
  // snapped the track back to question 1 while question 2 held the opacity).
  const trackX = qWidth && qWidth > 0 ? safeIdx * (qWidth + TRACK_GAP) : 0;

  // Lock each question to the viewport width. Panes are user-resizable, so a
  // ResizeObserver (not window resize) keeps the track aligned. Only react to
  // WIDTH changes: our own height animation resizes the viewport too, and
  // responding to that would loop.
  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const measure = () => setQWidth(vp.clientWidth > 2 ? vp.clientWidth - 2 : undefined);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    let lastW = vp.clientWidth;
    const ro = new ResizeObserver(() => {
      if (vp.clientWidth === lastW) return;
      lastW = vp.clientWidth;
      measure();
    });
    ro.observe(vp);
    return () => ro.disconnect();
  }, []);

  // Measure the active question's height whenever the step, the locked width,
  // or content that can change wrapping does. Runs after commit, so the
  // width lock is already applied to the DOM.
  useLayoutEffect(() => {
    const item = questionRefs.current[safeIdx];
    if (!item) return;
    setViewH(item.offsetHeight + 2);
    if (!measuredRef.current) {
      measuredRef.current = true;
      const reduce =
        prefs.reduceMotion || (
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      // Enable transitions only after the first paint-ready measure so the
      // initial layout doesn't animate from empty.
      if (!reduce) setSlideAnim(true);
    }
  }, [safeIdx, qWidth, questions, selections, otherTexts]);

  useEffect(() => () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
  }, []);

  const q = questions[safeIdx];

  const currentSelections = selections.get(safeIdx) ?? new Set<string>();
  const currentOtherText = otherTexts.get(safeIdx) ?? '';

  const markAnswered = useCallback((idx: number) => {
    setAnswered(prev => {
      const next = new Set(prev);
      next.add(idx);
      return next;
    });
  }, []);

  const goToStep = useCallback((next: number) => {
    if (answeringRef.current) return;
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    setCurrentIdx(Math.min(Math.max(next, 0), questions.length - 1));
  }, [questions.length]);

  const toggleOption = useCallback((label: string) => {
    if (readOnly || !q || answeringRef.current) return;
    setSelections(prev => {
      const next = new Map(prev);
      const set = new Set(prev.get(safeIdx) ?? []);
      if (q.multiSelect) {
        if (set.has(label)) set.delete(label);
        else set.add(label);
      } else {
        set.clear();
        set.add(label);
      }
      next.set(safeIdx, set);
      return next;
    });
    markAnswered(safeIdx);
    // Single-select: slide to the next question after a beat (AICSS behavior).
    if (!q.multiSelect && safeIdx < questions.length - 1) {
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
      advanceTimer.current = setTimeout(() => {
        setCurrentIdx(idx => Math.min(idx + 1, questions.length - 1));
      }, ADVANCE_MS);
    }
  }, [safeIdx, q, questions.length, readOnly, markAnswered]);

  const setOtherText = useCallback((text: string) => {
    if (answeringRef.current) return;
    setOtherTexts(prev => {
      const next = new Map(prev);
      next.set(safeIdx, text);
      return next;
    });
    if (text.trim()) markAnswered(safeIdx);
  }, [safeIdx, markAnswered]);

  const buildAnswer = (idx: number): string => {
    const sel = selections.get(idx) ?? new Set<string>();
    const other = otherTexts.get(idx) ?? '';
    const parts = [...sel];
    if (other.trim()) parts.push(other.trim());
    return parts.join(', ');
  };

  /** Give the card back after attempt `attempt` did not land (ignored once a newer one started). */
  const releaseAnswer = (attempt: number) => {
    if (attempt !== attemptRef.current) return;
    if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    fallbackTimer.current = null;
    answeringRef.current = false;
    setAnswering(false);
  };

  const armFallback = (attempt: number) => {
    if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    fallbackTimer.current = setTimeout(() => {
      fallbackTimer.current = null;
      if (!inFlightRef.current) releaseAnswer(attempt);
    }, ANSWER_REVERT_MS);
  };

  /** Mark the card as answered, leave the receipt its hand-off, and send. */
  const sendAnswer = (send: () => AnswerResult) => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    const attempt = ++attemptRef.current;
    answeringRef.current = true;
    setAnswering(true);
    const card = cardElRef.current;
    const key = card ? handoffKey(card, userInput) : null;
    sentKeyRef.current = key;
    if (key) recordHandoff(key, card?.offsetHeight ?? 0);
    armFallback(attempt);
    const result = send();
    if (!result || typeof result !== 'object' || typeof result.then !== 'function') return;
    inFlightRef.current = true;
    result.then(
      (outcome) => {
        inFlightRef.current = false;
        if (outcome === false) releaseAnswer(attempt);
        else armFallback(attempt); // landed: the receipt should replace the card shortly
      },
      () => {
        inFlightRef.current = false;
        releaseAnswer(attempt);
      },
    );
  };

  const handleSubmit = () => {
    if (answeringRef.current) return;
    markAnswered(safeIdx);
    const answers: UserInputAnswer[] = questions.map((question, idx) => ({
      ...(question.id !== undefined ? { id: question.id } : {}),
      question: question.question,
      answer: buildAnswer(idx),
    }));
    sendAnswer(() => onSubmit(answers));
  };

  const handleSkip = () => {
    if (answeringRef.current) return;
    sendAnswer(onSkip);
  };

  if (userInput.resolved) {
    return <ResolvedUserInput userInput={userInput} />;
  }
  if (!q) return null;

  const isLastQuestion = safeIdx === questions.length - 1;
  const hasSelection = currentSelections.size > 0 || currentOtherText.trim().length > 0;
  /** While the answer is on its way, the controls say so to AT (they ignore input). */
  const busy = answering ? true : undefined;

  return (
    <motion.div
      ref={cardRef}
      className="ask-card"
      data-answering={answering ? 'true' : undefined}
      initial={enter ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DUR.decay, ease: ASK_EASE }}
    >
      <div className="ask-card-head">
        <span className="ask-head-icon" aria-hidden>?</span>
        <span className="ask-head-title">{isMultiQuestion ? 'Questions' : 'Question'}</span>
        {isMultiQuestion && (
          <span className="ask-head-count">{safeIdx + 1} / {questions.length}</span>
        )}
      </div>

      <div
        ref={viewportRef}
        className="ask-viewport"
        style={viewH != null ? { height: viewH } : undefined}
        data-animate={slideAnim ? 'true' : undefined}
        aria-live="polite"
      >
        <div
          className="ask-track"
          style={{ transform: `translate3d(${-trackX}px, 0, 0)` }}
          data-animate={slideAnim ? 'true' : undefined}
        >
          {questions.map((question, qi) => {
            const active = qi === safeIdx;
            const qSelections = selections.get(qi) ?? new Set<string>();
            const qOther = otherTexts.get(qi) ?? '';
            return (
              <div
                key={qi}
                ref={(el) => { questionRefs.current[qi] = el; }}
                className="ask-question"
                style={qWidth ? { width: qWidth } : undefined}
                data-active={active ? 'true' : undefined}
                aria-hidden={active ? undefined : true}
              >
                <div className="ask-card-qheader">
                  {question.header && <span className="ask-card-chip">{question.header}</span>}
                  <QuestionText text={question.question} />
                  {question.multiSelect && <span className="ask-card-hint">Select all that apply.</span>}
                </div>
                <div className="ask-card-options" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question}>
                  {question.options.map((opt) => {
                    const chosen = qSelections.has(opt.label);
                    const fading = answering && !chosen;
                    return (
                      <motion.button
                        key={opt.label}
                        type="button"
                        role={question.multiSelect ? 'checkbox' : 'radio'}
                        aria-checked={chosen}
                        tabIndex={active ? 0 : -1}
                        className={`ask-card-opt${chosen ? ' selected' : ''}`}
                        onClick={() => { if (active) toggleOption(opt.label); }}
                        disabled={readOnly}
                        aria-disabled={busy}
                        data-ask-fade={fading ? '' : undefined}
                        style={answering ? (chosen ? FILL_HOST : { pointerEvents: 'none' }) : undefined}
                        initial={false}
                        animate={{ opacity: fading ? 0 : 1 }}
                        transition={{ duration: DUR.soft, ease: 'linear' }}
                      >
                        {answering && chosen && <AnswerFill />}
                        <span className={`ask-card-indicator${question.multiSelect ? ' checkbox' : ''}`} />
                        <span className="ask-card-opt-label">
                          {opt.label}
                          {opt.description && <span className="ask-card-opt-desc">{opt.description}</span>}
                        </span>
                      </motion.button>
                    );
                  })}
                  <motion.div
                    className={`ask-card-opt ask-card-opt-other${qOther.trim() ? ' selected' : ''}`}
                    onClick={(e) => {
                      if (!active) return;
                      (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus();
                    }}
                    data-ask-fade={answering && !qOther.trim() ? '' : undefined}
                    style={answering ? (qOther.trim() ? FILL_HOST : { pointerEvents: 'none' }) : undefined}
                    initial={false}
                    animate={{ opacity: answering && !qOther.trim() ? 0 : 1 }}
                    transition={{ duration: DUR.soft, ease: 'linear' }}
                  >
                    {answering && qOther.trim() && <AnswerFill />}
                    <span className={`ask-card-indicator${question.multiSelect ? ' checkbox' : ''}`} />
                    <input
                      type="text"
                      placeholder="Other — type your own…"
                      value={qOther}
                      tabIndex={active ? 0 : -1}
                      onChange={(e) => { if (active) setOtherText(e.target.value); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          if (isLastQuestion) handleSubmit();
                          else goToStep(safeIdx + 1);
                        }
                      }}
                      disabled={readOnly}
                      aria-disabled={busy}
                    />
                  </motion.div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {!readOnly && (
        <div className="ask-card-footer">
          <button type="button" className="ask-card-skip" onClick={handleSkip} aria-disabled={busy}>
            {isMultiQuestion ? 'Skip all' : 'Skip'}
          </button>
          <div className="ask-card-footer-right">
            {isMultiQuestion && (
              <>
                <button type="button" className="ask-nav-arrow" aria-label="Previous question" aria-disabled={busy}
                  onClick={() => goToStep(safeIdx - 1)} disabled={safeIdx === 0}>‹</button>
                <button type="button" className="ask-nav-arrow" aria-label="Next question" aria-disabled={busy}
                  onClick={() => goToStep(safeIdx + 1)} disabled={isLastQuestion}>›</button>
              </>
            )}
            {isLastQuestion ? (
              <button
                type="button"
                className="ask-card-submit"
                aria-disabled={busy}
                onClick={handleSubmit}
                disabled={!hasSelection && !answered.size}
              >
                {isMultiQuestion ? 'Submit all ✓' : q.multiSelect && currentSelections.size > 0 ? `Submit (${currentSelections.size})` : 'Submit'}
              </button>
            ) : (
              <button type="button" className="ask-card-submit" aria-disabled={busy} onClick={() => goToStep(safeIdx + 1)} disabled={!hasSelection}>
                Next →
              </button>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}
