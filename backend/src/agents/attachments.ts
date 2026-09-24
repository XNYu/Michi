import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTurnInput } from "./types";

/**
 * Attachment fan-out shared by every runtime.
 *
 * Each runtime sends images as native content blocks (ACP `image`, Claude
 * stream-json image blocks, Codex `localImage`). Nothing else has a native
 * representation, so before this module every non-image attachment — PDFs,
 * .txt, .csv, source files, archives — was filtered out and dropped in
 * silence: no stream event, no note in the prompt, and a visible attachment
 * pill in the composer for content the model never received.
 *
 * All four runtimes can read files from disk (Kiro/Claude/Codex bring their own
 * read tools, Pi gets Michi's). So the honest and useful fallback is to tell the
 * agent the attachment exists and where it is, and let it open the file if it
 * needs to. That converts a silent data-loss bug into a one-line prompt note.
 */

/** Extensions every runtime can inline as a native image block. */
export const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** Mime type for a supported image path, or undefined when unsupported. */
export function imageMimeType(absPath: string): string | undefined {
  return IMAGE_MIME_TYPES[path.extname(absPath).toLowerCase()];
}

export interface ResolvedAttachment {
  name: string;
  absPath: string;
}

export interface PartitionedAttachments {
  /** Absolute paths that exist on disk and can be sent as native image blocks. */
  images: ResolvedAttachment[];
  /** Readable non-image files, surfaced to the model as paths. */
  others: ResolvedAttachment[];
  /** Attachments we could not resolve at all (missing, unreadable, relative). */
  unreadable: ResolvedAttachment[];
}

function isReadableFile(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Split a turn's attachments into native-image / path-referenced / unreadable
 * buckets. Relative paths are treated as unreadable: every runtime resolves
 * attachments against its own cwd, and guessing here would silently read the
 * wrong file.
 */
export function partitionAttachments(
  attachments: AgentTurnInput["attachments"],
): PartitionedAttachments {
  const images: ResolvedAttachment[] = [];
  const others: ResolvedAttachment[] = [];
  const unreadable: ResolvedAttachment[] = [];
  const seen = new Set<string>();

  for (const att of attachments ?? []) {
    const absPath = att?.absPath;
    if (typeof absPath !== "string" || !absPath || !path.isAbsolute(absPath)) {
      if (att) unreadable.push({ name: att.name, absPath: String(att.absPath ?? "") });
      continue;
    }
    if (seen.has(absPath)) continue;
    seen.add(absPath);
    const resolved: ResolvedAttachment = { name: att.name, absPath };
    if (!isReadableFile(absPath)) {
      unreadable.push(resolved);
      continue;
    }
    if (IMAGE_EXTENSIONS.has(path.extname(absPath).toLowerCase())) {
      images.push(resolved);
    } else {
      others.push(resolved);
    }
  }

  return { images, others, unreadable };
}

/**
 * Build the prompt note describing attachments that were not sent as images.
 * Returns an empty string when there is nothing to say, so callers can append
 * unconditionally. The note is appended to the *model-facing* text only —
 * callers must not write it into Michi's stored history, or it would be
 * duplicated on every resume and leak into forked transcripts.
 */
export function describeNonImageAttachments(
  partition: Pick<PartitionedAttachments, "others" | "unreadable">,
): string {
  const lines: string[] = [];
  for (const att of partition.others) {
    lines.push(`- ${att.name} → ${att.absPath}`);
  }
  for (const att of partition.unreadable) {
    lines.push(`- ${att.name} (could not be read at ${att.absPath || "an unknown path"})`);
  }
  if (lines.length === 0) return "";
  return [
    "",
    "[Attachments]",
    "The user attached the following non-image files. They are not inlined in this",
    "message — read them from disk if they are relevant:",
    ...lines,
  ].join("\n");
}

/**
 * Convenience wrapper: partition once, and return both the image list and the
 * text suffix to append to the outgoing prompt.
 */
export function prepareAttachments(attachments: AgentTurnInput["attachments"]): {
  images: ResolvedAttachment[];
  promptNote: string;
} {
  const partition = partitionAttachments(attachments);
  return { images: partition.images, promptNote: describeNonImageAttachments(partition) };
}
