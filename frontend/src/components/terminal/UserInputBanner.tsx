import React, { useState, useCallback } from 'react';
import type { UserInputRequest } from '../../state/chatTypes';
import type { UserInputAnswer } from '../../services/chatStreamEvents';

interface UserInputBannerProps {
  userInput: UserInputRequest;
  onSubmit: (answers: UserInputAnswer[]) => void;
  onSkip: () => void;
  readOnly?: boolean;
}

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
  if (userInput.resolved) {
    return <ResolvedUserInput userInput={userInput} />;
  }

  const { questions } = userInput;
  const isMultiQuestion = questions.length > 1;
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selections, setSelections] = useState<Map<number, Set<string>>>(() => new Map());
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(() => new Map());
  const [showOther, setShowOther] = useState<Map<number, boolean>>(() => new Map());
  const [answered, setAnswered] = useState<Set<number>>(() => new Set());

  const q = questions[currentIdx];
  if (!q) return null;

  const currentSelections = selections.get(currentIdx) ?? new Set();
  const currentOtherText = otherTexts.get(currentIdx) ?? '';
  const currentShowOther = showOther.get(currentIdx) ?? false;

  const toggleOption = useCallback((label: string) => {
    if (readOnly) return;
    setSelections(prev => {
      const next = new Map(prev);
      const set = new Set(prev.get(currentIdx) ?? []);
      if (q.multiSelect) {
        if (set.has(label)) set.delete(label);
        else set.add(label);
      } else {
        set.clear();
        set.add(label);
      }
      next.set(currentIdx, set);
      return next;
    });
  }, [currentIdx, q.multiSelect, readOnly]);

  const toggleOther = useCallback(() => {
    if (readOnly) return;
    setShowOther(prev => {
      const next = new Map(prev);
      next.set(currentIdx, !prev.get(currentIdx));
      return next;
    });
  }, [currentIdx, readOnly]);

  const setOtherText = useCallback((text: string) => {
    setOtherTexts(prev => {
      const next = new Map(prev);
      next.set(currentIdx, text);
      return next;
    });
  }, [currentIdx]);

  const buildAnswer = (idx: number): string => {
    const sel = selections.get(idx) ?? new Set();
    const other = otherTexts.get(idx) ?? '';
    const parts = [...sel];
    if (other.trim()) parts.push(other.trim());
    return parts.join(', ');
  };

  const markAnswered = () => {
    setAnswered(prev => {
      const next = new Set(prev);
      next.add(currentIdx);
      return next;
    });
  };

  const handleNext = () => {
    markAnswered();
    if (currentIdx < questions.length - 1) {
      setCurrentIdx(currentIdx + 1);
    }
  };

  const handlePrev = () => {
    if (currentIdx > 0) setCurrentIdx(currentIdx - 1);
  };

  const handleSubmit = () => {
    markAnswered();
    const answers: UserInputAnswer[] = questions.map((question, idx) => ({
      question: question.question,
      answer: buildAnswer(idx),
    }));
    onSubmit(answers);
  };

  const isLastQuestion = currentIdx === questions.length - 1;
  const hasSelection = currentSelections.size > 0 || currentOtherText.trim().length > 0;

  return (
    <div className="ask-card">
      {isMultiQuestion && (
        <div className="ask-card-pagination">
          <div className="ask-card-pagination-left">
            <span className="ask-card-badge">? INPUT</span>
            <div className="ask-card-dots">
              {questions.map((_, i) => (
                <span
                  key={i}
                  className={`ask-card-dot${i === currentIdx ? ' active' : ''}${answered.has(i) && i !== currentIdx ? ' done' : ''}`}
                  onClick={() => setCurrentIdx(i)}
                />
              ))}
            </div>
          </div>
          <span className="ask-card-counter">{currentIdx + 1} / {questions.length}</span>
        </div>
      )}

      <div className="ask-card-body">
        <div className="ask-card-qheader">
          {q.header && <span className="ask-card-chip">{q.header}</span>}
          <span className="ask-card-qtext">{q.question}</span>
          {q.multiSelect && <span className="ask-card-hint">Select all that apply.</span>}
        </div>

        <div className="ask-card-options">
          {q.options.map((opt) => (
            <button
              key={opt.label}
              className={`ask-card-opt${currentSelections.has(opt.label) ? ' selected' : ''}`}
              onClick={() => toggleOption(opt.label)}
              disabled={readOnly}
            >
              <span className={`ask-card-indicator${q.multiSelect ? ' checkbox' : ''}`} />
              <span className="ask-card-opt-label">
                {opt.label}
                {opt.description && <span className="ask-card-opt-desc">{opt.description}</span>}
              </span>
            </button>
          ))}
        </div>

        <div className="ask-card-other">
          <button
            className={`ask-card-other-toggle${currentShowOther ? ' open' : ''}`}
            onClick={toggleOther}
            disabled={readOnly}
          >
            <span className="chev">›</span> Other
          </button>
          {currentShowOther && (
            <div className="ask-card-other-input">
              <input
                type="text"
                placeholder="Type your own answer..."
                value={currentOtherText}
                onChange={(e) => setOtherText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (isLastQuestion) handleSubmit();
                    else handleNext();
                  }
                }}
                disabled={readOnly}
                autoFocus
              />
            </div>
          )}
        </div>

        {!readOnly && (
          <div className="ask-card-footer">
            <button className="ask-card-skip" onClick={onSkip}>
              {isMultiQuestion ? 'Skip all' : 'Skip'}
            </button>
            <div className="ask-card-footer-right">
              {isMultiQuestion && (
                <>
                  <button className="ask-card-nav" onClick={handlePrev} disabled={currentIdx === 0}>‹</button>
                  <button className="ask-card-nav" onClick={handleNext} disabled={isLastQuestion}>›</button>
                </>
              )}
              {isLastQuestion ? (
                <button
                  className="ask-card-submit"
                  onClick={handleSubmit}
                  disabled={!hasSelection && !answered.size}
                >
                  {isMultiQuestion ? 'Submit all ✓' : q.multiSelect && currentSelections.size > 0 ? `Submit (${currentSelections.size})` : 'Submit'}
                </button>
              ) : (
                <button className="ask-card-submit" onClick={handleNext} disabled={!hasSelection}>
                  Next →
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
