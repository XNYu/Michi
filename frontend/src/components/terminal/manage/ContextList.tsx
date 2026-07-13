import React from 'react';
import type { ContextEntry } from '../../../state/chatTypes';
import { manageFileType } from './tokens';

interface Props {
  contexts: ContextEntry[];
  filter: string;
  selectedContextId: string | null;
  onSelect: (id: string) => void;
  onToggleAutoInject: (id: string, next: boolean) => void;
  onDelete: (id: string) => void;
  onPreview: (filePath: string) => void;
  onAdd: () => void;
}

function fmtBytes(n: number | undefined): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10_485_760 ? 1 : 0)} MB`;
}

export default function ContextList({
  contexts,
  filter,
  selectedContextId,
  onSelect,
  onToggleAutoInject,
  onDelete,
  onPreview,
  onAdd,
}: Props) {
  const norm = filter.trim().toLowerCase();
  const filtered = norm
    ? contexts.filter(
        (c) =>
          c.name.toLowerCase().includes(norm) ||
          c.filePath.toLowerCase().includes(norm),
      )
    : contexts;

  const totalBytes = filtered.reduce((acc, c) => acc + (c.size ?? 0), 0);
  const favoriteCount = filtered.filter((c) => c.pinnedAt).length;

  // Group by artifact type; within a group favorites sort first, then newest first.
  const byType = new Map<string, ContextEntry[]>();
  for (const c of filtered) {
    const t = artifactType(c);
    const arr = byType.get(t) ?? [];
    arr.push(c);
    byType.set(t, arr);
  }
  for (const arr of byType.values()) {
    arr.sort((a, b) => {
      if (!!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1;
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });
  }

  return (
    <div>
      <Strip totalBytes={totalBytes} favoriteCount={favoriteCount} onAdd={onAdd} />
      {TYPE_GROUPS.map((g) => (
        <Section
          key={g.key}
          title={g.title}
          count={(byType.get(g.key) ?? []).length}
          rows={byType.get(g.key) ?? []}
          selectedId={selectedContextId}
          onSelect={onSelect}
          onPin={onPin}
          onDelete={onDelete}
          onPreview={onPreview}
        />
      ))}
    </div>
  );
}

function Strip({
  totalBytes,
  favoriteCount,
  onAdd,
}: {
  totalBytes: number;
  favoriteCount: number;
  onAdd: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 14,
        padding: '0 14px',
        color: 'var(--term-muted)',
        fontFamily: 'var(--ui-font)',
        fontSize: 13,
      }}
    >
      <span>Drag &amp; drop files anywhere, or</span>
      <button
        type="button"
        onClick={onAdd}
        style={{
          border: 'none',
          background: 'var(--term-fg)',
          color: 'var(--term-bg, #fff)',
          padding: '4px 12px',
          fontFamily: 'inherit',
          fontSize: 12.5,
          fontWeight: 500,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          cursor: 'pointer',
        }}
      >
        + Add source
      </button>
      <span style={{ flex: 1 }} />
      <span style={{ color: 'var(--term-faint, var(--term-muted))', fontSize: 12 }}>
        {favoriteCount} favorite{favoriteCount === 1 ? '' : 's'} · {fmtBytes(totalBytes)} total
      </span>
    </div>
  );
}

function Section({
  title,
  subtitle,
  count,
  rows,
  selectedId,
  onSelect,
  onToggleAutoInject,
  onDelete,
  onPreview,
}: {
  title: string;
  subtitle: string;
  count: number;
  rows: ContextEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggleAutoInject: (id: string, next: boolean) => void;
  onDelete: (id: string) => void;
  onPreview: (filePath: string) => void;
}) {
  const [hoverId, setHoverId] = React.useState<string | null>(null);
  if (rows.length === 0) return null;
  return (
    <section style={{ marginBottom: 28 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          padding: '0 14px 8px 14px',
          borderBottom: '1px solid var(--term-line)',
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 13,
            lineHeight: 1.3,
            fontWeight: 500,
            color: 'var(--term-fg)',
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 11.5,
            color: 'var(--term-faint, var(--term-muted))',
            fontFamily: 'var(--ui-font)',
          }}
        >
          · {count}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 11.5,
            color: 'var(--term-faint, var(--term-muted))',
            fontStyle: 'italic',
            fontFamily: 'var(--ui-font)',
          }}
        >
          {subtitle}
        </span>
      </div>
      {rows.map((c) => {
        const ft = manageFileType(c.name);
        const selected = selectedId === c.id;
        const hovered = hoverId === c.id;
        return (
          <div
            key={c.id}
            data-selected={selected}
            data-hovered={hovered}
            onMouseEnter={() => setHoverId(c.id)}
            onMouseLeave={() =>
              setHoverId((cur) => (cur === c.id ? null : cur))
            }
            onClick={() => onSelect(c.id)}
            style={{
              display: 'flex',
              gap: 14,
              alignItems: 'center',
              padding: '12px 14px',
              background: selected
                ? 'var(--term-sel, color-mix(in srgb, var(--term-accent) 14%, transparent))'
                : hovered
                  ? 'var(--term-hover, var(--term-alt))'
                  : 'transparent',
              cursor: 'pointer',
              position: 'relative',
            }}
          >
            {selected && (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  background: 'var(--term-accent)',
                }}
              />
            )}
            <div
              style={{
                width: 30,
                height: 36,
                background: `${ft.color}15`,
                color: ft.color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.04em',
                flexShrink: 0,
                fontFamily: 'var(--ui-font)',
                textTransform: 'uppercase',
              }}
            >
              {ft.label}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontFamily: 'var(--ui-font)',
                  fontSize: 14,
                  lineHeight: 1.3,
                  fontWeight: 500,
                  color: 'var(--term-fg)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {c.name}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--term-faint, var(--term-muted))',
                  marginTop: 2,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  fontFamily: 'var(--ui-font)',
                }}
              >
                {c.kind === 'reference' ? '↗ ' : ''}
                {c.filePath}
              </div>
            </div>
            {hovered ? (
              <RowActions
                favorite={!!c.pinnedAt}
                onPreview={() => onPreview(c.filePath)}
                onPin={() => onToggleAutoInject(c.id, !c.autoInject)}
                onDelete={() => onDelete(c.id)}
                contextName={c.name}
              />
            ) : (
              <RowMeta size={c.size} />
            )}
          </div>
        );
      })}
    </section>
  );
}

function RowMeta({ size }: { size: number | undefined }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        gap: 12,
        color: 'var(--term-muted)',
        whiteSpace: 'nowrap',
        fontFamily: 'var(--ui-font)',
        fontSize: 12,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span style={{ width: 60, textAlign: 'right' }}>{fmtBytes(size)}</span>
    </span>
  );
}

function RowActions({
  favorite,
  onPreview,
  onPin,
  onDelete,
  contextName,
}: {
  favorite: boolean;
  onPreview: () => void;
  onPin: () => void;
  onDelete: () => void;
  contextName: string;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        gap: 4,
        whiteSpace: 'nowrap',
      }}
    >
      <IconBtn
        ariaLabel={`preview ${contextName}`}
        title="Open in OS default app"
        onClick={onPreview}
      >
        <FolderOpenIcon />
      </IconBtn>
      <IconBtn
        ariaLabel={favorite
          ? `Remove ${contextName} from favorites`
          : `Add ${contextName} to favorites`}
        title={favorite ? 'Remove from favorites' : 'Add to favorites'}
        active={favorite}
        ariaPressed={favorite}
        onClick={onPin}
      >
        <StarIcon filled={favorite} />
      </IconBtn>
      <IconBtn
        ariaLabel={`delete ${contextName}`}
        title="Delete"
        danger
        onClick={onDelete}
      >
        <TrashIcon />
      </IconBtn>
    </span>
  );
}

function IconBtn({
  children,
  onClick,
  ariaLabel,
  title,
  active,
  ariaPressed,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
  title: string;
  active?: boolean;
  ariaPressed?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        color: danger
          ? 'var(--term-danger, #a8261a)'
          : active
            ? 'var(--term-accent)'
            : 'var(--term-muted)',
        padding: '2px 6px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 0,
      }}
    >
      {children}
    </button>
  );
}

function FolderOpenIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <path d="M1.5 4.5h4.5l1.5 1.5h6.5v2.5" />
      <path d="M2 7.5h12.5l-1.6 5.5H1.5L2 7.5z" />
    </svg>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.5l1.95 3.95 4.36.63-3.15 3.07.74 4.34L8 11.44l-3.9 2.05.74-4.34-3.15-3.07 4.36-.63L8 1.5z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M3 4h10M6 4V2.5h4V4M4.5 4l.5 9.5h6L11.5 4M7 6.5v5M9 6.5v5" strokeLinecap="round" />
    </svg>
  );
}
