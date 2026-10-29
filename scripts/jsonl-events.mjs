import fs from 'node:fs';

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parses one log line into an event of the given type, or null. Electron and
 * backend logs prefix the JSON with process tags, so after the whole line the
 * `{"type":"<type>"` position and then the first brace are tried.
 */
export function parseTypedLine(line, type) {
  const direct = tryParse(line);
  if (direct?.type === type) return direct;

  const taggedStart = line.indexOf(`{"type":${JSON.stringify(type)}`);
  if (taggedStart !== -1) {
    const tagged = tryParse(line.slice(taggedStart));
    if (tagged?.type === type) return tagged;
  }

  const firstBrace = line.indexOf('{');
  if (firstBrace !== -1) {
    const sliced = tryParse(line.slice(firstBrace));
    if (sliced?.type === type) return sliced;
  }

  return null;
}

/** Events of one type from every file, in file and line order. */
export function readTypedEvents(files, type) {
  return files.flatMap((file) => fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => parseTypedLine(line, type))
    .filter(Boolean));
}
