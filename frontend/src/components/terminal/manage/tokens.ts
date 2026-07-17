// Feature-scoped semantic colors for the WorkspaceManage page.
// Borrowed verbatim from the bone palette in the design handoff.
// These DO NOT enter the global token system.

export const MANAGE_COLORS = {
  digest: '#2f6b4e',
  digestSoft: '#d7e7df',
  select: '#c48300',
  selectSoft: '#fef3db',
  mauve: '#6d4aa8',
  ok: '#3a8767',
  digestSoftAlpha33: 'rgba(215, 231, 223, 0.33)',
} as const;

const FILETYPE_LABEL: Record<string, string> = {
  md: 'md', mdx: 'md', markdown: 'md',
  txt: 'txt', log: 'txt', rtf: 'txt',
  pdf: 'pdf', xls: 'xls', xlsx: 'xls', xlsm: 'xls',
  csv: 'csv', tsv: 'csv',
  doc: 'doc', docx: 'doc',
  json: 'json', yaml: 'yml', yml: 'yml', toml: 'toml',
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx',
  py: 'py', rs: 'rs', go: 'go', rb: 'rb', sh: 'sh',
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', svg: 'img', heic: 'img', avif: 'img',
  html: 'html', htm: 'html', xml: 'html',
};

const FILETYPE_COLOR: Record<string, string> = {
  md: '#5a544a', mdx: '#5a544a', markdown: '#5a544a',
  pdf: '#a8261a',
  csv: '#2f6b4e', tsv: '#2f6b4e', xls: '#2f6b4e', xlsx: '#2f6b4e',
  ts: '#0b6cb6', tsx: '#0b6cb6',
  js: '#a08300', jsx: '#a08300',
  py: '#2f6b4e', rs: '#a8261a', go: '#0b6cb6', rb: '#a8261a', sh: '#5a544a',
  png: '#6d4aa8', jpg: '#6d4aa8', jpeg: '#6d4aa8', gif: '#6d4aa8',
  webp: '#6d4aa8', svg: '#6d4aa8', heic: '#6d4aa8', avif: '#6d4aa8',
  html: '#a8451f', htm: '#a8451f', xml: '#a8451f',
  json: '#a08300', yaml: '#a08300', yml: '#a08300', toml: '#a08300',
};

export interface ManageFileType {
  label: string;
  color: string;
  ext: string;
}

export function manageFileType(filePathOrName: string): ManageFileType {
  const m = filePathOrName.toLowerCase().match(/\.([^./\\]+)$/);
  const ext = m?.[1] ?? '';
  return {
    ext,
    label: FILETYPE_LABEL[ext] ?? (ext.slice(0, 3) || '·'),
    color: FILETYPE_COLOR[ext] ?? '#5a544a',
  };
}
