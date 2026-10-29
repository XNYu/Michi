type Node = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

/** Keep paths distinct from web URLs, anchors, commands and protocol-relative URLs. */
export function fileLinkPath(value: string): string | null {
  let path = value;
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== 'localhost') return null;
      path = decodeURIComponent(url.pathname);
    } catch { return null; }
  } else {
    try { path = decodeURIComponent(path); } catch { return null; }
  }
  if (!path || /[\r\n\0]/.test(path) || path.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(path)) return null;
  return /^(?:\/|\.\.?\/)/.test(path) || /^[\w@.-]+(?:\/[\w .@()-]+)*\.[a-z\d]{1,12}(?::\d+(?::\d+)?)?(?:#L\d+)?$/i.test(path) ? path : null;
}

/** Link whole inline code paths; never rewrite source code blocks or existing links. */
export function rehypeFileLinks() {
  return (tree: Node) => {
    const walk = (node: Node) => {
      if (['a', 'pre', 'script', 'style', 'svg', 'math'].includes(node.tagName ?? '')) return;
      if (node.tagName === 'code' && node.children?.length === 1 && node.children[0].type === 'text') {
        const value = node.children[0].value ?? '';
        const path = fileLinkPath(value);
        if (path) node.children = [{ type: 'element', tagName: 'a', properties: { href: encodeURI(path).replace(/#/g, '%23') }, children: node.children }];
        return;
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
