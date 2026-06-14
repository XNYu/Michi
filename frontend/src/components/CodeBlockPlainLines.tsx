import { useMemo } from 'react';

export default function CodeBlockPlainLines({ source }: { source: string }) {
  const lines = useMemo(() => source.split('\n'), [source]);
  return (
    <>
      {lines.map((line, index) => (
        <span className="michi-code-line" key={index}>
          {line}
        </span>
      ))}
    </>
  );
}
