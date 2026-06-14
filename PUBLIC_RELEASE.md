# Public Release Workflow

This repository is prepared as the public-facing copy of Michi. Keep private
company-specific setup, registry configuration, commit metadata, and private
package names out of this copy. Kiro runtime support is intentionally allowed.

## Before Publishing

Run these checks from the public checkout:

```bash
rg -n --hidden --glob '!node_modules/**' --glob '!backend/dist/**' --glob '!frontend/build/**' --glob '!dist-electron/**' --glob '!.git/**' "$PRIVATE_MARKER_REGEX"
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' "$PRIVATE_EMAIL_REGEX"
npm install --package-lock-only --registry=https://registry.npmjs.org/
npm run build
cd backend && npm test
cd ../frontend && npm test
```

The source tree is only half of the problem. Git history can still expose old
commit messages, author emails, deleted files, and old package names. For the
first public publication, create a fresh snapshot branch instead of pushing the
private branch history:

```bash
git switch --orphan public-main
git add -A
git commit -m "chore: initial public release"
```

Review that orphan commit locally before adding a public remote or pushing it.

## Two-Repository Development

Use two separate local clones:

```text
~/work/michi-private
~/work/michi-public
```

Do normal development in the private clone. Before moving work to the public
clone, split changes into small commits and scrub each commit message. Do not
copy private config files, lockfiles pinned to private registries, or generated
artifacts that embed local paths.

In the public clone, keep a branch for incoming work:

```bash
git switch public-main
git switch -c public/import-YYYY-MM-DD
```

Apply private changes as patches, then run the scrub scan and tests before
committing or publishing.

## Moving Commits

For one or more commits, `format-patch` is the least surprising transfer path
because it works even when the public repo uses an orphan history:

```bash
cd ~/work/michi-private
git format-patch --stdout <base>..HEAD > /tmp/michi-public.patch

cd ~/work/michi-public
git switch -c public/import-YYYY-MM-DD
git am /tmp/michi-public.patch
```

Then inspect and edit before finalizing:

```bash
git log --oneline --decorate -5
git diff public-main..HEAD
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' "$PRIVATE_MARKER_REGEX"
npm install --package-lock-only --registry=https://registry.npmjs.org/
npm run build
```

If a patch contains private-only changes, abort and re-create a narrower patch:

```bash
git am --abort
```

For a single clean commit and related histories, cherry-pick is also fine:

```bash
git remote add private ~/work/michi-private
git fetch private
git cherry-pick <commit-sha>
```

After either path, rewrite the public commit message locally if needed:

```bash
git commit --amend
```

Only push from the public clone after the scrub scan and tests pass and the
diff has been reviewed.
