import type { RuntimeWarning, UserInputAnswer, UserInputQuestion } from 'michi-shared';
import { log } from '../../services/logger';

/**
 * Michi's ExtensionUIContext for the Pi SDK.
 *
 * Dialogs become questions on the running turn through ask_user's channel:
 * answers, skip, turn cancel, replay after a refresh and the
 * MICHI_APPROVE_TIMEOUT_MS timeout all behave as they do for ask_user, and a
 * dismissed dialog returns Pi's cancel value (undefined, or false for
 * confirm). notify becomes a warning on the turn's stream, which the pane
 * shows as a notice. Terminal-only methods have nothing to draw on: they
 * return the cancel value or do nothing, at once, and each extension's first
 * use of each one is logged so the degraded behavior can be explained.
 */

/**
 * The SDK's headless embedding mode. Dialogs reach a host client (so
 * `ctx.hasUI` is true) and terminal components do not exist, which is what
 * extensions check `ctx.mode === "tui"` for before custom() or editor
 * components. "tui" would promise components Michi cannot draw; "print" and
 * "json" are the modes without dialogs.
 */
export const PI_EXTENSION_UI_MODE = 'rpc' as const;

/** What a Pi session gives the bridge (PiSession implements it). */
export interface PiExtensionUiHost {
    /** The running turn's signal once its stream can show UI; undefined otherwise. */
    activeTurn(): AbortSignal | undefined;
    /** ask_user's channel: the answers, or null when skipped, timed out, dismissed or the turn stopped. */
    requestUserInput(questions: UserInputQuestion[], dismiss?: AbortSignal): Promise<UserInputAnswer[] | null>;
    /** A notice on the running turn's stream, or held for the next turn. */
    notify(notice: RuntimeWarning): void;
}

export interface PiExtensionUi {
    /** The ExtensionUIContext for AgentSession.bindExtensions. */
    readonly context: Record<string, unknown>;
    /**
     * A third-party factory whose handlers, commands and tools see `ctx.ui`
     * attributed to `extension`, and whose tools are passed through `guardTool`.
     */
    scope(
        factory: (pi: any) => unknown,
        extension: string,
        guardTool: <T extends { name: string; execute: (...args: any[]) => unknown }>(tool: T) => T,
    ): (pi: any) => Promise<unknown>;
}

const UNATTRIBUTED = '<unattributed>';
/**
 * The question chip and the notice source ("Pi extension: <message>"): these
 * come from an extension, not from the model.
 */
const EXTENSION_LABEL = 'Pi extension';
const YES = 'Yes';
const NO = 'No';
const MAX_NOTICE_CHARS = 500;
const MAX_NOTICES_PER_TURN = 20;
const MAX_QUESTION_DETAIL_CHARS = 2_000;
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

const NEEDS_TERMINAL = 'needs a terminal, which Michi does not have; ignored';
const NO_EDITOR = 'Michi has no editor an extension can control; ignored';
const NOT_SHOWN = 'not shown in Michi yet; ignored';

/** `extension` is the extension's SDK path (`<inline:N>`), or `<unattributed>`. */
function logDiagnostic(extension: string, method: string, detail: string): void {
    log.warn('chat', `Pi extension ${extension} ui.${method}: ${detail}`, { extension, method });
}

const plainText = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? '')).replace(ANSI_ESCAPE, '');
const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** The title, with an optional second part (a message, placeholder or prefill) on the next line. */
function questionText(title: unknown, detail?: unknown): string {
    const head = plainText(title).trim();
    const body = typeof detail === 'string' ? clip(plainText(detail).trim(), MAX_QUESTION_DETAIL_CHARS) : '';
    return body ? `${head}\n${body}` : head;
}

const question = (text: string, options: string[] = []): UserInputQuestion =>
    ({ question: text, header: EXTENSION_LABEL, options: options.map((label) => ({ label })), multiSelect: false });

/** Pi's styling helpers as plain text: Michi renders no terminal colors. */
const plain = (text: unknown): string => plainText(text);
const PLAIN_THEME = Object.freeze({
    name: 'michi-plain',
    appearance: 'dark',
    colors: Object.freeze({}),
    style: plain,
    fg: (_color: unknown, text: unknown) => plainText(text),
    bg: (_color: unknown, text: unknown) => plainText(text),
    bold: plain,
    italic: plain,
    underline: plain,
    inverse: plain,
    strikethrough: plain,
    getFgAnsi: () => '',
    getBgAnsi: () => '',
    getColorMode: () => 'truecolor',
    getThinkingBorderColor: () => plain,
    getBashModeBorderColor: () => plain,
});

/** The extension's own signal and timeout dismiss its dialog; ask_user's timeout still applies. */
function dismissalOf(options: unknown): { signal?: AbortSignal; dispose(): void } {
    const { signal, timeout } = (options && typeof options === 'object' ? options : {}) as { signal?: unknown; timeout?: unknown };
    const signals: AbortSignal[] = signal instanceof AbortSignal ? [signal] : [];
    let timer: NodeJS.Timeout | undefined;
    if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) {
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), timeout);
        signals.push(controller.signal);
    }
    return { signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0], dispose: () => clearTimeout(timer) };
}

export function createPiExtensionUi(host: PiExtensionUiHost): PiExtensionUi {
    // The extension whose ctx.ui call is in progress. Set and read
    // synchronously: the SDK's prompt wrapper calls these methods at once.
    let current: string | undefined;
    const caller = () => current ?? UNATTRIBUTED;
    const reported = new Set<string>();
    /** Logs each extension's first degraded use of each method (per reason). */
    const report = (extension: string, method: string, detail: string) => {
        const key = JSON.stringify([extension, method, detail]);
        if (reported.has(key)) return;
        reported.add(key);
        logDiagnostic(extension, method, detail);
    };
    const ignored = (method: string, detail: string) => () => { report(caller(), method, detail); };
    const noticesByTurn = new WeakMap<AbortSignal, number>();

    /** One question on the running turn; undefined is Pi's cancel value. */
    async function ask(extension: string, method: string, asked: UserInputQuestion, options?: unknown): Promise<string | undefined> {
        if (!host.activeTurn()) {
            report(extension, method, 'no turn is running to ask on; returned the cancel value');
            return undefined;
        }
        const dismissal = dismissalOf(options);
        try {
            const answers = await host.requestUserInput([asked], dismissal.signal);
            return answers?.[0]?.answer;
        } finally {
            dismissal.dispose();
        }
    }

    const context: Record<string, unknown> = {
        select: async (title: unknown, options: unknown, dialog?: unknown) => {
            const extension = caller();
            const choices = [...new Set((Array.isArray(options) ? options : [])
                .filter((option): option is string => typeof option === 'string' && option.trim() !== ''))];
            if (choices.length === 0) {
                report(extension, 'select', 'called without options; returned the cancel value');
                return undefined;
            }
            const answer = await ask(extension, 'select', question(questionText(title), choices), dialog);
            if (answer === undefined || choices.includes(answer)) return answer;
            // The card always offers a typed answer; Pi's select promises one of the options.
            report(extension, 'select', 'the user typed an answer that is not one of the options; returned the cancel value');
            return undefined;
        },
        confirm: async (title: unknown, message: unknown, dialog?: unknown) =>
            await ask(caller(), 'confirm', question(questionText(title, message), [YES, NO]), dialog) === YES,
        input: (title: unknown, placeholder?: unknown, dialog?: unknown) =>
            ask(caller(), 'input', question(questionText(title, placeholder)), dialog),
        editor: (title: unknown, prefill?: unknown) => {
            const extension = caller();
            report(extension, 'editor', 'shown as a one-line text question with the prefill as its description');
            return ask(extension, 'editor', question(questionText(title, prefill)));
        },
        notify: (message: unknown, type?: unknown) => {
            const extension = caller();
            const text = clip(plainText(message).trim(), MAX_NOTICE_CHARS);
            if (!text) return;
            const turn = host.activeTurn();
            if (turn) {
                const count = noticesByTurn.get(turn) ?? 0;
                if (count >= MAX_NOTICES_PER_TURN) {
                    report(extension, 'notify', `more than ${MAX_NOTICES_PER_TURN} notices in one turn; the rest were dropped`);
                    return;
                }
                noticesByTurn.set(turn, count + 1);
            }
            const level = type === 'warning' || type === 'error' ? type : 'info';
            host.notify({ source: EXTENSION_LABEL, category: 'runtime', code: `PI_EXTENSION_${level.toUpperCase()}`, message: text });
        },
        onTerminalInput: () => {
            report(caller(), 'onTerminalInput', NEEDS_TERMINAL);
            return () => {};
        },
        setStatus: ignored('setStatus', NOT_SHOWN),
        setWorkingMessage: ignored('setWorkingMessage', NOT_SHOWN),
        setWorkingVisible: ignored('setWorkingVisible', NOT_SHOWN),
        setWorkingIndicator: ignored('setWorkingIndicator', NOT_SHOWN),
        setHiddenThinkingLabel: ignored('setHiddenThinkingLabel', NOT_SHOWN),
        setWidget: (_key: unknown, content: unknown) => {
            report(caller(), 'setWidget', typeof content === 'function' ? `a component widget ${NEEDS_TERMINAL}` : `a text widget is ${NOT_SHOWN}`);
        },
        setFooter: ignored('setFooter', NEEDS_TERMINAL),
        setHeader: ignored('setHeader', NEEDS_TERMINAL),
        setTitle: ignored('setTitle', NOT_SHOWN),
        custom: async () => {
            report(caller(), 'custom', 'custom components need a terminal; returned undefined');
            return undefined;
        },
        pasteToEditor: ignored('pasteToEditor', NO_EDITOR),
        setEditorText: ignored('setEditorText', NO_EDITOR),
        getEditorText: () => {
            report(caller(), 'getEditorText', 'Michi has no editor an extension can read; returned ""');
            return '';
        },
        addAutocompleteProvider: ignored('addAutocompleteProvider', NO_EDITOR),
        setEditorComponent: ignored('setEditorComponent', NEEDS_TERMINAL),
        getEditorComponent: () => undefined,
        get theme() { return PLAIN_THEME; },
        getAllThemes: () => [],
        getTheme: () => undefined,
        setTheme: () => {
            report(caller(), 'setTheme', 'Michi has no terminal themes; reported failure');
            return { success: false, error: 'Themes are not supported in Michi' };
        },
        getToolsExpanded: () => false,
        setToolsExpanded: ignored('setToolsExpanded', NOT_SHOWN),
    };

    const views = new WeakMap<object, Map<string, object>>();
    /** `ui` as one extension sees it: every call is attributed to that extension. */
    function attributedUi(ui: object, extension: string): object {
        let byExtension = views.get(ui);
        if (!byExtension) views.set(ui, byExtension = new Map());
        let view = byExtension.get(extension);
        if (!view) {
            view = new Proxy(ui, {
                get(target, key) {
                    const value = Reflect.get(target, key, target);
                    if (typeof value !== 'function') return value;
                    return (...args: unknown[]) => {
                        const previous = current;
                        current = extension;
                        try { return value.apply(target, args); } finally { current = previous; }
                    };
                },
            });
            byExtension.set(extension, view);
        }
        return view;
    }

    function attributedContext(ctx: unknown, extension: string): unknown {
        if (!ctx || typeof ctx !== 'object') return ctx;
        return new Proxy(ctx, {
            get(target, key) {
                const value = Reflect.get(target, key, target);
                return key === 'ui' && value && typeof value === 'object' ? attributedUi(value, extension) : value;
            },
        });
    }

    function scope(
        factory: (pi: any) => unknown,
        extension: string,
        guardTool: <T extends { name: string; execute: (...args: any[]) => unknown }>(tool: T) => T,
    ): (pi: any) => Promise<unknown> {
        /** `fn` with its `index`th argument (the SDK's ctx) attributed. */
        const withContextAt = (fn: unknown, index: number) => typeof fn !== 'function' ? fn
            : function (this: unknown, ...args: unknown[]) {
                if (index < args.length) args[index] = attributedContext(args[index], extension);
                return fn.apply(this, args);
            };
        return async (pi: any) => factory(new Proxy(pi, {
            get(target, key) {
                const value = Reflect.get(target, key, target);
                if (typeof value !== 'function') return value;
                switch (key) {
                    case 'on':
                        return (event: unknown, handler: unknown, ...rest: unknown[]) =>
                            value.call(target, event, withContextAt(handler, 1), ...rest);
                    case 'registerTool':
                        return (tool: any, ...rest: unknown[]) => value.call(target,
                            tool && typeof tool === 'object' && typeof tool.execute === 'function'
                                ? guardTool(new Proxy(tool, {
                                    get: (definition, field, receiver) => field === 'execute'
                                        ? withContextAt(definition.execute, 4) : Reflect.get(definition, field, receiver),
                                }))
                                : tool,
                            ...rest);
                    case 'registerCommand':
                        return (name: unknown, options: any, ...rest: unknown[]) => value.call(target, name,
                            options && typeof options.handler === 'function' ? { ...options, handler: withContextAt(options.handler, 1) } : options,
                            ...rest);
                    case 'registerShortcut':
                        return (shortcut: unknown, options: any, ...rest: unknown[]) => value.call(target, shortcut,
                            options && typeof options.handler === 'function' ? { ...options, handler: withContextAt(options.handler, 0) } : options,
                            ...rest);
                    default:
                        return value;
                }
            },
        }));
    }

    return { context, scope };
}
