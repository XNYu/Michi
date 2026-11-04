import React, { useEffect, useId, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { MetaAgentGuardStatus, MetaAgentToolset } from 'michi-shared';
import { Button } from '../../../ui/controls';
import { formatMichiClock } from '../../content/michiFormat';
import { metaAgentRuntimeLabel } from './runtimeCopy';
import './metaAgentSettings.css';

const TOOLSET_LABELS: Record<MetaAgentToolset, string> = {
  maintenance: 'Background maintenance',
  chat: 'Chat window',
  memory: 'Automatic memory',
};

function joinWords(words: string[]): string {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The red box shown while a Meta agent run is stopped by its restriction check. */
export function MetaAgentGuardAlert({ failures, onRetry, onChangeRuntime }: {
  failures: readonly MetaAgentGuardStatus[];
  onRetry: () => Promise<void> | void;
  onChangeRuntime: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const detailsId = useId();
  if (failures.length === 0) return null;
  const runtimes = joinWords([...new Set(failures.map((failure) => metaAgentRuntimeLabel(failure.runtimeId)))]);
  const tools = [...new Set(failures.flatMap((failure) => failure.unexpectedTools))];
  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } catch (err) {
      toast.error(err instanceof Error && err.message ? `Couldn’t retry: ${err.message}` : 'Couldn’t retry the Meta agent');
    } finally {
      if (mounted.current) setRetrying(false);
    }
  };

  return (
    <div className="meta-set__alert" role="alert">
      <TriangleAlert className="meta-set__alert-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
      <div className="meta-set__alert-body">
        <b>
          {tools.length > 0
            ? `Meta agent stopped: ${runtimes} started with extra tools`
            : `Meta agent stopped: ${runtimes} did not pass its tool check`}
        </b>
        <p>
          {tools.length > 0 && <>Extra tools: {tools.map((tool, index) => (
            <React.Fragment key={tool}>{index > 0 && ', '}<code>{tool}</code></React.Fragment>
          ))}. </>}
          The Meta agent may only read threads and edit pages, so it did not run and pages won’t update.
        </p>
      </div>
      <div className="meta-set__alert-actions">
        <Button variant="primary" size="sm" disabled={retrying} onClick={() => { void retry(); }}>
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
        <Button size="sm" onClick={onChangeRuntime}>Change runtime</Button>
        <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((value) => !value)}>
          Details
        </Button>
      </div>
      {open && (
        <dl className="meta-set__alert-details" id={detailsId}>
          {failures.map((failure) => (
            <div key={failure.toolset}>
              <dt>{TOOLSET_LABELS[failure.toolset] ?? failure.toolset}</dt>
              <dd>
                {metaAgentRuntimeLabel(failure.runtimeId)} · checked {formatMichiClock(failure.checkedAt)}
                {failure.unexpectedTools.length > 0 && <> · extra: <code>{failure.unexpectedTools.join(', ')}</code></>}
                {failure.detail && <div className="meta-set__alert-detail">{failure.detail}</div>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
