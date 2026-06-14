import React from 'react';

export interface ActionSheetItem {
  id: string;
  label: string;
  glyph?: string;
  /** When true the item is rendered in muted colour as a "cancel" type. */
  cancel?: boolean;
  onSelect: () => void;
}

interface Props {
  items: ActionSheetItem[];
  onClose: () => void;
}

export default function ActionSheet({ items, onClose }: Props) {
  return (
    <>
      <div className="m-sheet-scrim" onClick={onClose} />
      <div className="m-sheet" role="menu">
        {items.map((it) => (
          <div
            key={it.id}
            className="m-sheet-row"
            data-cancel={it.cancel}
            onClick={() => {
              it.onSelect();
              onClose();
            }}
          >
            {it.glyph && <span style={{ width: 18, textAlign: 'center' }}>{it.glyph}</span>}
            <span>{it.label}</span>
          </div>
        ))}
      </div>
    </>
  );
}
