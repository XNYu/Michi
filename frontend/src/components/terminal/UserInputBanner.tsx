import React, { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { UserInputRequest } from '../../state/chatTypes';
import type { UserInputAnswer } from '../../services/chatStreamEvents';

interface UserInputBannerProps {
  userInput: UserInputRequest;
  onSubmit: (answers: UserInputAnswer[]) => void;
  onSkip: () => void;
  readOnly?: boolean;
}

/** Delay between picking a single-select option and auto-advancing to the next question. */
const ADVANCE_MS = 320;
/** Horizontal gap between questions in the sliding track. Must match `.ask-track` CSS. */
const TRACK_GAP = 28;

export function ResolvedUserInput({ userInput }: { userInput: UserInputRequest }) {
  const { questions, answers } = userInput;
  if (!answers.length) {
    return (
      <div className="ask-card ask-resolved">
        <div className="ask-card-body">
          <div className="ask-qa-pair">
            <span className="ask-qa-answer skipped">(skipped)</span>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="ask-card ask-resolved">
      <div className="ask-card-body">
        {questions.map((q, i) => (
          <div key={i} className="ask-qa-pair">
            <div className="ask-qa-question">{q.header || q.question}</div>
            <div className={`ask-qa-answer${!answers[i]?.answer ? ' skipped' : ''}`}>
              {answers[i]?.answer || '(skipped)'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function UserInputBanner({ userInput, onSubmit, onSkip, readOnly = false }: UserInputBannerProps) {
  const { questions } = userInput;
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
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    setCurrentIdx(Math.min(Math.max(next, 0), questions.length - 1));
  }, [questions.length]);

  const toggleOption = useCallback((label: string) => {
    if (readOnly || !q) return;
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

  const handleSubmit = () => {
    markAnswered(safeIdx);
    const answers: UserInputAnswer[] = questions.map((question, idx) => ({
      question: question.question,
      answer: buildAnswer(idx),
    }));
    onSubmit(answers);
  };

  if (userInput.resolved) {
    return <ResolvedUserInput userInput={userInput} />;
  }
  if (!q) return null;

  const isLastQuestion = safeIdx === questions.length - 1;
  const hasSelection = currentSelections.size > 0 || currentOtherText.trim().length > 0;

  return (
    <div className="ask-card">
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
                  <span className="ask-card-qtext">{question.question}</span>
                  {question.multiSelect && <span className="ask-card-hint">Select all that apply.</span>}
                </div>
                <div className="ask-card-options" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question}>
                  {question.options.map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      role={question.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={qSelections.has(opt.label)}
                      tabIndex={active ? 0 : -1}
                      className={`ask-card-opt${qSelections.has(opt.label) ? ' selected' : ''}`}
                      onClick={() => { if (active) toggleOption(opt.label); }}
                      disabled={readOnly}
                    >
                      <span className={`ask-card-indicator${question.multiSelect ? ' checkbox' : ''}`} />
                      <span className="ask-card-opt-label">
                        {opt.label}
                        {opt.description && <span className="ask-card-opt-desc">{opt.description}</span>}
                      </span>
                    </button>
                  ))}
                  <div
                    className={`ask-card-opt ask-card-opt-other${qOther.trim() ? ' selected' : ''}`}
                    onClick={(e) => {
                      if (!active) return;
                      (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus();
                    }}
                  >
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
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {!readOnly && (
        <div className="ask-card-footer">
          <button type="button" className="ask-card-skip" onClick={onSkip}>
            {isMultiQuestion ? 'Skip all' : 'Skip'}
          </button>
          <div className="ask-card-footer-right">
            {isMultiQuestion && (
              <>
                <button type="button" className="ask-nav-arrow" aria-label="Previous question"
                  onClick={() => goToStep(safeIdx - 1)} disabled={safeIdx === 0}>‹</button>
                <button type="button" className="ask-nav-arrow" aria-label="Next question"
                  onClick={() => goToStep(safeIdx + 1)} disabled={isLastQuestion}>›</button>
              </>
            )}
            {isLastQuestion ? (
              <button
                type="button"
                className="ask-card-submit"
                onClick={handleSubmit}
                disabled={!hasSelection && !answered.size}
              >
                {isMultiQuestion ? 'Submit all ✓' : q.multiSelect && currentSelections.size > 0 ? `Submit (${currentSelections.size})` : 'Submit'}
              </button>
            ) : (
              <button type="button" className="ask-card-submit" onClick={() => goToStep(safeIdx + 1)} disabled={!hasSelection}>
                Next →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
