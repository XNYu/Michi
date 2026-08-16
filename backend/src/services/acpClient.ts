/**
 * Compatibility surface for the shared ACP client.
 *
 * The Kiro-hardcoded implementation used to live in this file. Transport now
 * lives in `./acp/client.ts`; Kiro is a profile (`./acp/profiles/kiro.ts`).
 * Existing imports (`AcpClient`, `findKiroCli`, `ACPError`, …) keep working.
 * `new AcpClient(binary, cwd, model)` still constructs a Kiro client.
 */
export {
    AcpClient,
    ACPError,
    ACPNotRunningError,
    ACPProcessExitedError,
} from "./acp/client";
export type { AcpPromptBlock, ACPErrorDetails, AcpUpdate } from "./acp/client";
export type { AcpInitializeResult } from "./acp/types";
export { findKiroCli } from "./acp/profiles/kiro";
