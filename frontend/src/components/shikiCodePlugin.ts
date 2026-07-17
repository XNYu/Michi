import { createHighlighterCore, type HighlighterCore, type TokensResult } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

export type HighlightResult = TokensResult;

const langLoaders: Record<string, () => Promise<{ default: unknown }>> = {
  bash: () => import('@shikijs/langs/bash'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  go: () => import('@shikijs/langs/go'),
  html: () => import('@shikijs/langs/html'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsx: () => import('@shikijs/langs/jsx'),
  markdown: () => import('@shikijs/langs/markdown'),
  php: () => import('@shikijs/langs/php'),
  python: () => import('@shikijs/langs/python'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  shell: () => import('@shikijs/langs/shell'),
  sql: () => import('@shikijs/langs/sql'),
  swift: () => import('@shikijs/langs/swift'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
};

const aliases: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  htm: 'html',
  'c++': 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  kt: 'java',
  docker: 'dockerfile',
  'objective-c': 'c',
  'shell-session': 'shell',
  console: 'shell',
};

const themeLoaders = {
  'github-light': () => import('@shikijs/themes/github-light'),
  'github-dark': () => import('@shikijs/themes/github-dark'),
} as const;

const supported = new Set(Object.keys(langLoaders));

function normalize(raw: string): string {
  const k = raw.trim().toLowerCase();
  return aliases[k] ?? k;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();
const inflightLangs = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise) return highlighterPromise;
  const created = createHighlighterCore({
    themes: [themeLoaders['github-light'](), themeLoaders['github-dark']()],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  highlighterPromise = created;
  return created;
}

async function ensureLang(lang: string): Promise<void> {
  if (loadedLangs.has(lang)) return;
  const pending = inflightLangs.get(lang);
  if (pending) return pending;
  const loader = langLoaders[lang];
  if (!loader) return;
  const task = (async () => {
    const hl = await getHighlighter();
    const mod = await loader();
    await hl.loadLanguage(mod.default as Parameters<HighlighterCore['loadLanguage']>[0]);
    loadedLangs.add(lang);
  })().finally(() => inflightLangs.delete(lang));
  inflightLangs.set(lang, task);
  return task;
}

export type ThemeName = keyof typeof themeLoaders;
export type ThemePair = [ThemeName, ThemeName];

export interface HighlightOptions {
  code: string;
  language: string;
  themes: ThemePair;
}

export interface CodeHighlighterPlugin {
  name: 'shiki';
  type: 'code-highlighter';
  supportsLanguage(language: string): boolean;
  getSupportedLanguages(): string[];
  getThemes(): ThemePair;
  highlight(
    opts: HighlightOptions,
    callback?: (result: HighlightResult) => void,
  ): HighlightResult | null;
}

const resultCache = new Map<string, HighlightResult>();
const pendingCallbacks = new Map<string, Set<(r: HighlightResult) => void>>();
const queuedKeys = new Set<string>();
const highlightQueue: Array<() => Promise<void>> = [];
let queueScheduled = false;

function scheduleIdleWork(fn: () => void): void {
  if (typeof window === 'undefined') {
    setTimeout(fn, 0);
    return;
  }
  const idle = (window as Window & {
    requestIdleCallback?: (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number;
  }).requestIdleCallback;
  if (idle) {
    idle(() => fn(), { timeout: 1200 });
    return;
  }
  window.setTimeout(fn, 32);
}

function scheduleHighlightQueue(): void {
  if (queueScheduled) return;
  queueScheduled = true;
  scheduleIdleWork(() => {
    queueScheduled = false;
    const task = highlightQueue.shift();
    if (!task) return;
    void task().finally(() => {
      if (highlightQueue.length > 0) {
        scheduleHighlightQueue();
      }
    });
  });
}

function enqueueHighlight(task: () => Promise<void>): void {
  highlightQueue.push(task);
  scheduleHighlightQueue();
}

function cacheKey(code: string, lang: string, themes: ThemePair): string {
  const head = code.slice(0, 100);
  const tail = code.length > 100 ? code.slice(-100) : '';
  return `${lang}:${themes[0]}:${themes[1]}:${code.length}:${head}:${tail}`;
}

export function createCodePlugin(options: { themes?: ThemePair } = {}): CodeHighlighterPlugin {
  const defaultThemes: ThemePair = options.themes ?? ['github-light', 'github-dark'];

  return {
    name: 'shiki',
    type: 'code-highlighter',
    supportsLanguage(language: string) {
      return supported.has(normalize(language));
    },
    getSupportedLanguages() {
      return Array.from(supported);
    },
    getThemes() {
      return defaultThemes;
    },
    highlight(opts: HighlightOptions, callback?: (result: HighlightResult) => void): HighlightResult | null {
      const lang = supported.has(normalize(opts.language)) ? normalize(opts.language) : 'text';
      const themes = opts.themes ?? defaultThemes;
      const key = cacheKey(opts.code, lang, themes);
      const cached = resultCache.get(key);
      if (cached) return cached;
      if (callback) {
        let cbs = pendingCallbacks.get(key);
        if (!cbs) {
          cbs = new Set();
          pendingCallbacks.set(key, cbs);
        }
        cbs.add(callback);
      }
      if (queuedKeys.has(key)) return null;
      queuedKeys.add(key);
      enqueueHighlight(async () => {
        try {
          const hl = await getHighlighter();
          if (lang !== 'text') await ensureLang(lang);
          const effectiveLang = lang !== 'text' && hl.getLoadedLanguages().includes(lang) ? lang : 'text';
          const tokens = hl.codeToTokens(opts.code, {
            lang: effectiveLang,
            themes: { light: themes[0], dark: themes[1] },
          });
          resultCache.set(key, tokens);
          const cbs = pendingCallbacks.get(key);
          if (cbs) {
            for (const cb of cbs) cb(tokens);
            pendingCallbacks.delete(key);
          }
        } catch (err) {
          console.error('[shikiCodePlugin] highlight failed:', err);
          pendingCallbacks.delete(key);
        } finally {
          queuedKeys.delete(key);
        }
      });
      return null;
    },
  };
}
