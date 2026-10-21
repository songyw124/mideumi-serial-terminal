# Releases through the GitHub website

The app version is `[package].version` in `Cargo.toml`. Keep the matching root
package entry in `Cargo.lock` at the same version. `tauri.conf.json` inherits it.

## First release: v0.1.0

1. Commit all app changes and `.github/workflows/release.yml` to the default
   branch. On GitHub, use **Add file → Create new file**, enter that exact path,
   and paste the workflow contents. This preserves the hidden `.github` folder.
2. Open **Actions → Build release → Run workflow**. Select the branch containing
   the code to release, then click **Run workflow**.
3. Wait for the preparation job and all four build jobs to succeed.
4. Open **Releases**. The workflow creates a draft named
   **Mideumi Serial Terminal v0.1.0**, tied to the exact commit that was built.
5. Confirm the draft has Windows x64 installers (`.exe`, `.msi`), macOS Apple
   Silicon and Intel downloads (`.dmg` and app archives), and Linux x64 packages
   (`.deb`, `.AppImage`). Download and test the relevant installers.
6. Edit the draft, write release notes, then click **Publish release**. The
   matching `v0.1.0` tag identifies this source version. No Git commands needed.

The workflow uses GitHub's automatic `GITHUB_TOKEN`; no personal access token
is needed. GitHub Actions must be enabled for the repository.

## Later releases

Update the version in `Cargo.toml` and the root package entry in `Cargo.lock`,
commit the changes, and run the workflow again. For example, version `0.1.1`
produces tag `v0.1.1`. Published releases are protected from workflow overwrites.
An existing draft can be retried from the same commit if a build fails. If the
code changes, delete the failed draft and its tag before retrying that version,
or increment the version. Only publish once all build jobs succeed.

The workflow also supports pushes of existing version tags (`v*`), checking that
the tag matches the version in `Cargo.toml`. The manual Actions button is the
recommended website-only route; do not publish an empty release first.

## Signing

These initial Windows installers are unsigned. macOS builds use ad-hoc signing
and are not notarized. OS trust prompts may appear; metadata such as publisher
name does not replace a signing certificate. Developer ID signing/notarization
and Windows certificate signing can be configured later using repository secrets.

Automatic in-app updates are not enabled by this workflow.
