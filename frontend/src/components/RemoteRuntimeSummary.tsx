const LABELS: Record<string, string> = { kiro: 'Kiro', codex: 'Codex', claude: 'Claude Code', crew: 'Kiro Crew', pi: 'Pi' };

export function RemoteRuntimeSummary({ runtimes }: { runtimes: string[] }) {
  const names = [...new Set(runtimes)].map(id => LABELS[id] ?? id);
  return <p className="remote-connection-notice" role="status">
    {names.length > 0
      ? <>Detected {names.length} {names.length === 1 ? 'runtime' : 'runtimes'}: {names.join(', ')}. You can switch runtimes in the composer.</>
      : <>No agent runtimes detected. Your machine is connected; set up an agent there before starting a chat.</>}
  </p>;
}
