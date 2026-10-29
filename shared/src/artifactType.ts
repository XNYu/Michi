/** Shelf classification only: every extension is accepted. */
export function artifactTypeForPath(path: string): 'doc' | 'file' | 'image' {
  const ext = path.toLowerCase().match(/\.([^./\\]+)$/)?.[1] ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'avif', 'bmp', 'tiff', 'tif'].includes(ext)) return 'image';
  if (['md', 'mdx', 'markdown', 'txt'].includes(ext)) return 'doc';
  return 'file';
}

/** Formats supported by the workspace image endpoint. Others remain downloadable. */
export function artifactHasImagePreview(path: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(path);
}
