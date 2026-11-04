/**
 * PDF to text for fetch_content, through unpdf's serverless pdf.js build
 * (no worker, no canvas, no font loading). Text is extracted page by page
 * with "[Page n]" markers, up to a page and character budget, so a huge
 * document cannot hold the backend for long.
 */

export interface PdfText {
    title: string | null;
    text: string;
    totalPages: number;
    pagesRead: number;
    /** Stopped at the page or character budget. */
    truncated: boolean;
}

export interface PdfLimits {
    maxPages: number;
    maxChars: number;
    signal?: AbortSignal;
}

export async function pdfToText(data: Uint8Array, limits: PdfLimits): Promise<PdfText> {
    // Loaded on first use: pdf.js is large and installs DOM polyfills when it loads.
    const { getDocumentProxy } = await import("unpdf");
    // pdf.js may take ownership of the buffer it is given; hand it a copy.
    // No URLs for fonts, CMaps or WASM are configured, so it loads nothing over the network.
    const pdf = await getDocumentProxy(new Uint8Array(data), {
        useSystemFonts: false,
        disableFontFace: true,
        verbosity: 0,
    });
    try {
        const totalPages = pdf.numPages;
        const pages: string[] = [];
        let chars = 0;
        let pagesRead = 0;
        let truncated = totalPages > limits.maxPages;
        for (let number = 1; number <= Math.min(totalPages, limits.maxPages); number++) {
            limits.signal?.throwIfAborted();
            const page = await pdf.getPage(number);
            const content = await page.getTextContent();
            let text = "";
            for (const item of content.items) {
                if (!("str" in item)) continue;
                text += item.str;
                if (item.hasEOL) text += "\n";
            }
            page.cleanup();
            const normalized = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
            pages.push(`[Page ${number}]\n${normalized}`);
            pagesRead = number;
            chars += normalized.length;
            if (chars >= limits.maxChars) {
                truncated = truncated || number < totalPages;
                break;
            }
        }
        const metadata = await pdf.getMetadata().catch(() => null);
        const info = metadata?.info as Record<string, unknown> | undefined;
        const title = typeof info?.Title === "string" && info.Title.trim() ? info.Title.trim() : null;
        return { title, text: pages.join("\n\n"), totalPages, pagesRead, truncated };
    } finally {
        await pdf.loadingTask.destroy().catch(() => {});
    }
}
