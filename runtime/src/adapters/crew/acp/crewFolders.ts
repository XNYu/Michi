/**
 * Where new Crew sessions go in the Crew sidebar: a "Michi Crew" folder this
 * App owns, then one subfolder per Michi workspace. Folders are matched by
 * name, so a renamed workspace gets a new subfolder and its old sessions stay
 * where they are. Filing is best effort: a failure is logged and the session
 * is created at the top level.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { errorMessage } from './crewFrames';
import type { CrewFolder, CrewGateway } from './gatewayTypes';

/** Top folder of the sessions Michi opens. */
export const MICHI_CREW_FOLDER = 'Michi Crew';

/** Crew keeps the first 100 characters of a trimmed folder name. */
const MAX_FOLDER_NAME = 100;

function folderName(name: string): string {
    return Array.from(name.trim()).slice(0, MAX_FOLDER_NAME).join('').trim();
}

function sameName(a: string, b: string): boolean {
    return folderName(a).toLowerCase() === folderName(b).toLowerCase();
}

/** The earliest of same-named folders, so adapters that raced to create one settle on the same folder. */
function earliest(rows: CrewFolder[]): CrewFolder | undefined {
    return [...rows].sort((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity) || a.id.localeCompare(b.id))[0];
}

function realpath(dir: string): string {
    try { return fs.realpathSync(dir); } catch { return dir; }
}

/** Live tests run in temporary directories; their sessions are left unfiled rather than adding folders. */
export function isTemporaryProject(cwd: string): boolean {
    const target = realpath(path.resolve(cwd));
    return ['/tmp', os.tmpdir()].flatMap((dir) => [dir, realpath(dir)]).some((root) => {
        const rel = path.relative(root, target);
        return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    });
}

export class CrewFolders {
    /** Folder id per workspace name, for the life of this process. */
    private readonly byWorkspace = new Map<string, Promise<string | undefined>>();
    private root?: Promise<string>;

    constructor(private readonly gateway: CrewGateway, private readonly log: (msg: string) => void) {}

    /** The folder for a workspace's new sessions, or undefined (logged, never thrown) when there is none. */
    folderFor(workspace: string): Promise<string | undefined> {
        const name = folderName(workspace);
        if (!name || !this.gateway.listFolders || !this.gateway.createFolder) return Promise.resolve(undefined);
        const key = name.toLowerCase();
        let pending = this.byWorkspace.get(key);
        if (!pending) {
            pending = this.resolve(name).catch((error: unknown) => {
                if (this.byWorkspace.get(key) === pending) this.byWorkspace.delete(key);
                this.log(`Could not file the session in a Crew folder: ${errorMessage(error)}`);
                return undefined;
            });
            this.byWorkspace.set(key, pending);
        }
        return pending;
    }

    /** Drops every remembered id, after Crew refused one, so the next session looks them up again. */
    forget(): void {
        this.byWorkspace.clear();
        this.root = undefined;
    }

    private async resolve(name: string): Promise<string> {
        const root = await this.rootFolder();
        return this.ensure(name, (rows) => rows.filter((row) => row.parentId === root), root);
    }

    /**
     * Found wherever the person moved it, but never one nested in another of
     * this App's folders, which would be a workspace that happens to share
     * the name.
     */
    private rootFolder(): Promise<string> {
        if (!this.root) {
            const pending = this.ensure(MICHI_CREW_FOLDER, (rows) => {
                const own = new Set(rows.filter((row) => row.own).map((row) => row.id));
                return rows.filter((row) => row.own && !own.has(row.parentId));
            }).catch((error: unknown) => {
                if (this.root === pending) this.root = undefined;
                throw error;
            });
            this.root = pending;
        }
        return this.root;
    }

    /**
     * The earliest candidate of this name, else a new folder. Another adapter
     * process can create the same folder at the same time, so the list is
     * read again after creating; a newer duplicate of ours is hidden, since an
     * App cannot delete folders.
     */
    private async ensure(name: string, candidates: (rows: CrewFolder[]) => CrewFolder[], parentId?: string): Promise<string> {
        const match = (rows: CrewFolder[]) => earliest(candidates(rows).filter((row) => sameName(row.name, name)));
        const found = match(await this.gateway.listFolders!());
        if (found) return found.id;
        const made = await this.gateway.createFolder!(name, parentId);
        const winner = match(await this.gateway.listFolders!()) ?? made;
        if (winner.id !== made.id) {
            await this.gateway.hideFolder?.(made.id).catch((error: unknown) =>
                this.log(`Could not hide duplicate Crew folder ${made.id}: ${errorMessage(error)}`));
        }
        return winner.id;
    }
}
