import { parse, type DefaultTreeAdapterMap } from "parse5";

/**
 * HTML to readable text for fetch_content.
 *
 * Keeps the page's reading content and its structure as plain text: headings
 * become "#" lines, list items "-" / "1." lines, links "[text](url)", tables
 * "a | b" rows, preformatted blocks fenced code. Scripts, styles, forms
 * controls, hidden elements and page chrome (navigation, banners, sidebars,
 * footers, cookie notices) are dropped. When the page marks its main content
 * (<main>, role=main, or one dominant <article>), only that part is read.
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

export interface HtmlText {
    title: string | null;
    text: string;
}

/** Never read: no reading content, or not text at all. */
const SKIPPED_TAGS = new Set([
    "head", "script", "style", "noscript", "template", "link", "meta", "base",
    "svg", "math", "canvas", "iframe", "frame", "frameset", "object", "embed", "applet",
    "audio", "video", "picture", "source", "track", "map", "img",
    "input", "button", "select", "option", "optgroup", "textarea", "datalist", "output",
    "progress", "meter", "dialog",
]);

/** Page chrome, dropped unless the element is the chosen content root itself. */
const CHROME_TAGS = new Set(["nav", "aside", "footer"]);
const CHROME_ROLES = new Set([
    "navigation", "banner", "contentinfo", "complementary", "search",
    "menu", "menubar", "toolbar", "dialog", "alertdialog",
]);
/** class/id tokens of common non-content blocks. */
const CHROME_HINT = /(?:^|[\s_-])(?:cookies?|consent|gdpr|advert|advertisement|ads|ad-slot|sponsored|promo|newsletter|social|share|sharing|breadcrumbs?|sidebar|skip-link|popup|modal|navbar|site-nav|site-header|site-footer|masthead)(?:$|[\s_-])/i;

/** Separated from neighbours by a blank line. */
const PARAGRAPH_TAGS = new Set([
    "p", "blockquote", "pre", "table", "ul", "ol", "dl", "figure", "address", "details", "fieldset",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr",
]);
/** Start on their own line. */
const BLOCK_TAGS = new Set([
    "html", "body", "main", "article", "section", "div", "header", "footer", "nav", "aside",
    "li", "dt", "dd", "tr", "figcaption", "summary", "legend", "caption", "center", "hgroup",
    "form", "tbody", "thead", "tfoot", "menu", "dir",
]);
const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** Deeper markup is read as flat text, so hostile nesting cannot exhaust the stack. */
const MAX_RENDER_DEPTH = 200;

export function htmlToText(html: string, pageUrl: string): HtmlText {
    const document = parse(html);
    const htmlElement = childElements(document).find((el) => el.tagName === "html");
    const head = htmlElement && childElements(htmlElement).find((el) => el.tagName === "head");
    const body = htmlElement && childElements(htmlElement).find((el) => el.tagName === "body");
    const title = head ? documentTitle(head) : null;
    if (!body) return { title, text: "" };

    const base = baseUrl(head, pageUrl);
    const root = contentRoot(body);
    const renderer = new Renderer(base, root);
    renderer.render(root, 0);
    return { title, text: renderer.sink.toString() };
}

function contentRoot(body: Element): Element {
    const isChrome = (el: Element) => isSkipped(el) || isChromeFor(el, body, true);
    const bodyLength = textLength(body, isChrome);
    const main = findFirst(body, (el) => el.tagName === "main" || attr(el, "role") === "main", isSkipped);
    if (main) {
        const length = textLength(main, (el) => isSkipped(el) || isChromeFor(el, main, false));
        if (length >= 500 || length >= bodyLength * 0.3) return main;
    }
    const articles = findAll(body, (el) => el.tagName === "article", isSkipped);
    let best: Element | null = null;
    let bestLength = 0;
    for (const article of articles) {
        const length = textLength(article, (el) => isSkipped(el) || isChromeFor(el, article, false));
        if (length > bestLength) { best = article; bestLength = length; }
    }
    if (best && bestLength >= bodyLength * 0.5) return best;
    return body;
}

function isSkipped(el: Element): boolean {
    if (SKIPPED_TAGS.has(el.tagName)) return true;
    if (hasAttr(el, "hidden") || attr(el, "aria-hidden") === "true") return true;
    const style = attr(el, "style");
    return Boolean(style && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style));
}

/** Page chrome relative to the content root. A <header> is chrome only around the page, not inside an article. */
function isChromeFor(el: Element, root: Element, rootIsBody: boolean): boolean {
    if (el === root || el.tagName === "main" || el.tagName === "article") return false;
    if (CHROME_TAGS.has(el.tagName)) return true;
    if (rootIsBody && el.tagName === "header") return true;
    const role = attr(el, "role");
    if (role && CHROME_ROLES.has(role.toLowerCase())) return true;
    const hint = `${attr(el, "class") ?? ""} ${attr(el, "id") ?? ""}`;
    return CHROME_HINT.test(hint);
}

class Renderer {
    readonly sink = new TextSink();
    private readonly lists: Array<{ ordered: boolean; next: number }> = [];
    private readonly rootIsBody: boolean;

    constructor(private readonly base: URL, private readonly root: Element) {
        this.rootIsBody = root.tagName === "body";
    }

    render(node: Node, depth: number): void {
        if (node.nodeName === "#text") {
            this.sink.inline((node as DefaultTreeAdapterMap["textNode"]).value);
            return;
        }
        if (!isElement(node)) return;
        const el = node;
        if (this.skip(el)) return;
        if (depth > MAX_RENDER_DEPTH) {
            this.sink.inline(` ${flatText(el, (child) => this.skip(child))} `);
            return;
        }
        const tag = el.tagName;
        const level = HEADING_LEVEL[tag];
        if (level) {
            const text = flatText(el, (child) => this.skip(child));
            if (!text) return;
            this.sink.blank();
            this.sink.inline(`${"#".repeat(level)} ${text}`);
            this.sink.blank();
            return;
        }
        switch (tag) {
            case "br":
                this.sink.lineBreak();
                return;
            case "hr":
                this.sink.blank();
                this.sink.inline("---");
                this.sink.blank();
                return;
            case "pre": {
                const text = rawText(el).replace(/^\n/, "").replace(/\s+$/, "");
                if (!text) return;
                this.sink.blank();
                this.sink.preformatted(`\`\`\`\n${text}\n\`\`\``);
                this.sink.blank();
                return;
            }
            case "code": {
                const text = flatText(el, (child) => this.skip(child));
                if (text) this.sink.inline(`\`${text}\``);
                return;
            }
            case "a":
                this.renderLink(el, depth);
                return;
            case "ul":
            case "ol":
                this.renderList(el, depth, tag === "ol");
                return;
            case "li":
                this.renderListItem(el, depth);
                return;
            case "table":
                if (this.renderDataTable(el)) return;
                break;
            case "td":
            case "th":
                this.sink.inline(" ");
                this.renderChildren(el, depth);
                this.sink.inline(" ");
                return;
            case "blockquote":
                this.sink.blank();
                this.sink.pushPrefix("> ");
                this.renderChildren(el, depth);
                this.sink.popPrefix();
                this.sink.blank();
                return;
        }
        if (PARAGRAPH_TAGS.has(tag)) {
            this.sink.blank();
            this.renderChildren(el, depth);
            this.sink.blank();
        } else if (BLOCK_TAGS.has(tag)) {
            this.sink.lineBreak();
            this.renderChildren(el, depth);
            this.sink.lineBreak();
        } else {
            this.renderChildren(el, depth);
        }
    }

    private skip(el: Element): boolean {
        return isSkipped(el) || isChromeFor(el, this.root, this.rootIsBody);
    }

    private renderChildren(el: Element, depth: number): void {
        for (const child of el.childNodes) this.render(child, depth + 1);
    }

    private renderLink(el: Element, depth: number): void {
        const target = linkTarget(el, this.base);
        if (hasBlockDescendant(el)) {
            this.renderChildren(el, depth);
            if (target) this.sink.inline(` (${target}) `);
            return;
        }
        let text = flatText(el, (child) => this.skip(child));
        if (!text) {
            // An image link is named by its alt text.
            const image = findFirst(el, (child) => child.tagName === "img", () => false);
            text = image ? (attr(image, "alt") ?? "").replace(/\s+/g, " ").trim() : "";
        }
        if (!text) return;
        if (!target || text === target) this.sink.inline(text);
        else this.sink.inline(`[${text}](${target})`);
    }

    private renderList(el: Element, depth: number, ordered: boolean): void {
        const start = ordered ? Number.parseInt(attr(el, "start") ?? "1", 10) : 1;
        if (this.lists.length === 0) this.sink.blank();
        else this.sink.lineBreak();
        this.lists.push({ ordered, next: Number.isFinite(start) ? start : 1 });
        this.renderChildren(el, depth);
        this.lists.pop();
        if (this.lists.length === 0) this.sink.blank();
        else this.sink.lineBreak();
    }

    private renderListItem(el: Element, depth: number): void {
        const list = this.lists[this.lists.length - 1];
        const marker = list?.ordered ? `${list.next++}. ` : "- ";
        this.sink.beginItem(marker);
        this.renderChildren(el, depth);
        this.sink.endItem();
    }

    /** A table of plain cells becomes "a | b" rows; layout tables (nested tables, or cells with paragraphs, lists or headings) render as ordinary blocks. */
    private renderDataTable(table: Element): boolean {
        const rows: Element[] = [];
        for (const child of childElements(table)) {
            if (child.tagName === "tr") rows.push(child);
            else if (child.tagName === "thead" || child.tagName === "tbody" || child.tagName === "tfoot") {
                rows.push(...childElements(child).filter((row) => row.tagName === "tr"));
            }
        }
        const cellsOf = (row: Element) => childElements(row).filter((cell) => cell.tagName === "td" || cell.tagName === "th");
        const layout = rows.some((row) => cellsOf(row).some((cell) =>
            findFirst(cell, (inner) => PARAGRAPH_TAGS.has(inner.tagName) || inner.tagName === "li", (inner) => this.skip(inner)) !== null));
        if (layout) return false;
        const lines = rows
            .map((row) => cellsOf(row).filter((cell) => !this.skip(cell)).map((cell) => flatText(cell, (inner) => this.skip(inner))))
            .filter((cells) => cells.some(Boolean))
            .map((cells) => cells.join(" | "));
        if (lines.length === 0) return true;
        const caption = childElements(table).find((child) => child.tagName === "caption");
        const captionText = caption ? flatText(caption, (inner) => this.skip(inner)) : "";
        this.sink.blank();
        if (captionText) {
            this.sink.inline(captionText);
            this.sink.lineBreak();
        }
        for (const line of lines) {
            this.sink.inline(line);
            this.sink.lineBreak();
        }
        this.sink.blank();
        return true;
    }
}

/**
 * Builds the text: collapses inline whitespace, keeps at most one blank line
 * between blocks, and prefixes lines inside quotes and list items.
 */
class TextSink {
    private readonly out: string[] = [];
    private atLineStart = true;
    private pendingSpace = false;
    /** Newlines at the end of the output; the start counts as after a blank line. */
    private newlines = 2;
    private readonly prefixes: string[] = [];
    /** The first line of a list item that has no text yet. */
    private pendingMarker: string | null = null;

    inline(text: string): void {
        const collapsed = text.replace(/\s+/g, " ");
        if (!collapsed) return;
        const core = collapsed.trim();
        if (collapsed.startsWith(" ") && !this.atLineStart) this.pendingSpace = true;
        if (core) {
            if (this.atLineStart) {
                this.out.push(this.linePrefix());
                this.atLineStart = false;
            } else if (this.pendingSpace) {
                this.out.push(" ");
            }
            this.out.push(core);
            this.pendingSpace = false;
            this.newlines = 0;
        }
        if (collapsed.endsWith(" ") && !this.atLineStart) this.pendingSpace = true;
    }

    preformatted(text: string): void {
        this.lineBreak();
        const lines = text.split("\n");
        for (const line of lines) {
            this.out.push(`${this.linePrefix()}${line}\n`);
        }
        this.atLineStart = true;
        this.pendingSpace = false;
        this.newlines = 1;
    }

    lineBreak(): void {
        if (this.pendingMarker !== null || this.atLineStart) return;
        this.out.push("\n");
        this.atLineStart = true;
        this.pendingSpace = false;
        this.newlines = 1;
    }

    blank(): void {
        if (this.pendingMarker !== null) return;
        this.lineBreak();
        if (this.newlines < 2) {
            this.out.push("\n");
            this.newlines = 2;
        }
    }

    pushPrefix(prefix: string): void { this.prefixes.push(prefix); }
    popPrefix(): void { this.prefixes.pop(); }

    beginItem(marker: string): void {
        this.lineBreak();
        this.pendingMarker = `${this.prefixes.join("")}${marker}`;
        this.prefixes.push(" ".repeat(marker.length));
    }

    endItem(): void {
        this.prefixes.pop();
        this.pendingMarker = null;
        this.lineBreak();
    }

    toString(): string {
        return this.out.join("")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    private linePrefix(): string {
        if (this.pendingMarker !== null) {
            const marker = this.pendingMarker;
            this.pendingMarker = null;
            return marker;
        }
        return this.prefixes.join("");
    }
}

function documentTitle(head: Element): string | null {
    const title = childElements(head).find((el) => el.tagName === "title");
    const text = title ? flatText(title, () => false) : "";
    if (text) return text;
    const og = childElements(head).find((el) => el.tagName === "meta" && attr(el, "property") === "og:title");
    const content = og ? (attr(og, "content") ?? "").replace(/\s+/g, " ").trim() : "";
    return content || null;
}

function baseUrl(head: Element | undefined, pageUrl: string): URL {
    const page = new URL(pageUrl);
    const base = head && childElements(head).find((el) => el.tagName === "base" && attr(el, "href"));
    if (!base) return page;
    try {
        return new URL(attr(base, "href")!, page);
    } catch {
        return page;
    }
}

function linkTarget(el: Element, base: URL): string | null {
    const href = attr(el, "href")?.trim();
    if (!href || href.startsWith("#")) return null;
    let url: URL;
    try {
        url = new URL(href, base);
    } catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
}

function isElement(node: Node): node is Element {
    return "tagName" in node;
}

function childElements(node: ParentNode): Element[] {
    return node.childNodes.filter(isElement);
}

function attr(el: Element, name: string): string | undefined {
    return el.attrs.find((a) => a.name === name)?.value;
}

function hasAttr(el: Element, name: string): boolean {
    return el.attrs.some((a) => a.name === name);
}

function hasBlockDescendant(el: Element): boolean {
    return findFirst(el, (child) => PARAGRAPH_TAGS.has(child.tagName) || BLOCK_TAGS.has(child.tagName), () => false) !== null;
}

/** Depth-first search below `root` without recursion; `prune` subtrees are not entered. */
function findFirst(root: Element, match: (el: Element) => boolean, prune: (el: Element) => boolean): Element | null {
    const stack: Node[] = [...root.childNodes].reverse();
    while (stack.length > 0) {
        const node = stack.pop()!;
        if (!isElement(node) || prune(node)) continue;
        if (match(node)) return node;
        for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
    return null;
}

function findAll(root: Element, match: (el: Element) => boolean, prune: (el: Element) => boolean): Element[] {
    const found: Element[] = [];
    const stack: Node[] = [...root.childNodes].reverse();
    while (stack.length > 0) {
        const node = stack.pop()!;
        if (!isElement(node) || prune(node)) continue;
        if (match(node)) found.push(node);
        for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
    return found;
}

/** Text below `root`, whitespace collapsed, without recursion. */
function flatText(root: Element, prune: (el: Element) => boolean): string {
    const parts: string[] = [];
    const stack: Node[] = [...root.childNodes].reverse();
    while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.nodeName === "#text") {
            parts.push((node as DefaultTreeAdapterMap["textNode"]).value);
            continue;
        }
        if (!isElement(node) || prune(node)) continue;
        // Block boundaries separate words.
        if (node.tagName === "br" || BLOCK_TAGS.has(node.tagName) || PARAGRAPH_TAGS.has(node.tagName)) parts.push(" ");
        for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
    return parts.join("").replace(/\s+/g, " ").trim();
}

function textLength(root: Element, prune: (el: Element) => boolean): number {
    return flatText(root, prune).length;
}

/** Text with whitespace preserved, for <pre>. */
function rawText(root: Element): string {
    const parts: string[] = [];
    const stack: Node[] = [...root.childNodes].reverse();
    while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.nodeName === "#text") {
            parts.push((node as DefaultTreeAdapterMap["textNode"]).value);
            continue;
        }
        if (!isElement(node) || isSkipped(node)) continue;
        if (node.tagName === "br") parts.push("\n");
        for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
    return parts.join("");
}
