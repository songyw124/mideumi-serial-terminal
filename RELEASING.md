# Releases through the GitHub website

The app version is `[package].version` in `Cargo.toml`. Keep the matching root
package entry in `Cargo.lock` at the same version. `tauri.conf.json` inherits it.

## First release: v0.1.0

1. Commit all app changes and `.github/workflows/release.yml` to the default
   branch. On GitHub, use **Add file → Create new file**, enter that exact path,
   and paste the workflow contents. This preserves the hidden `.github` folder.
2. Open **Actions → Build release → Run workflow**. Select the branch containing
   the code to release, then click **Run workflow**.
3. Wait for the preparation job and all five build jobs to succeed.
4. Open **Releases**. The workflow creates a draft named
   **Mideumi Serial Terminal v0.1.0**, tied to the exact commit that was built.
5. Confirm the draft has Windows x64 installers (`.exe`, `.msi`), macOS Apple
   Silicon and Intel downloads (`.dmg` and app archives), and Linux x64 packages
   (`.deb`, `.AppImage`), plus the Linux ARM64 `.deb` for Raspberry Pi.
   Download and test the relevant installers.
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

The workflow runs only through **Actions → Build release → Run workflow**.
Publishing the draft and creating its version tag do not trigger another build.
Do not publish an empty release first; let the manual workflow create the draft.

## Signing

These initial Windows installers are unsigned. macOS builds use ad-hoc signing
and are not notarized. OS trust prompts may appear; metadata such as publisher
name does not replace a signing certificate. Developer ID signing/notarization
and Windows certificate signing can be configured later using repository secrets.

Automatic in-app updates are not enabled by this workflow.

## Recovering from a workflow configuration error

Cancel the failed run before starting a replacement. Commit the workflow fix to
the default branch, delete the incomplete draft release, and delete its version
tag if one exists. Keep the version at `0.1.0` if it has never been published.
Then use **Actions → Build release → Run workflow** on the updated branch.
Do not use **Re-run jobs** on the old run: that uses the old commit and workflow.

Tauri build arguments must put Cargo options after the `--` separator, for example
`--target x86_64-pc-windows-msvc --bundles nsis,msi -- --locked`. The separate
`cargo test --locked` command already uses Cargo directly and needs no separator.

## Raspberry Pi / Linux ARM64

The Linux ARM64 job builds natively on `ubuntu-22.04-arm`, targeting
`aarch64-unknown-linux-gnu`. It uploads an ARM64 `.deb` alongside the existing
platform downloads. Choose the filename containing `arm64`, not `amd64`.

This targets a compatible 64-bit Raspberry Pi desktop OS with GTK and
WebKitGTK 4.1 runtime packages available. It does not support 32-bit Raspberry
Pi OS or the Raspberry Pi Pico. Install the package with a dependency-aware
package manager and test the GUI and serial-port permissions on the intended
Pi OS before claiming support. Building on GitHub is not a hardware test.

The first ARM64 package is a `.deb`; this job does not generate an AppImage.
