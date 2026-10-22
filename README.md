# Mideumi Serial Terminal

Small serial debug viewer for the cell cycler. Tauri 2 + Rust backend, plain HTML/CSS/JS frontend (no npm, no build step).

The application and window name is **Mideumi Serial Terminal**; the Rust package
and executable name is `mideumi-serial-terminal`. macOS display metadata is also
provided in `Info.plist` for the Dock and packaged app. Restart a rebuilt app to
see name changes; an already running executable retains its previous name.

## Run

```
cargo run            # debug build, opens the window
cargo run --release  # faster, no console window
```

Building an installer needs the Tauri CLI once: `cargo install tauri-cli --version "^2"`, then `cargo tauri build`.
The app icon source is `icons/icon.png`, with PNG, Windows ICO, and macOS ICNS variants in `icons/`. Regenerate with `cargo tauri icon icons/icon.png`.

## Portable Windows executable

Build a release executable without installing the Tauri CLI or creating an installer:

```powershell
cargo build --release
```

The portable app is `target\release\mideumi-serial-terminal.exe`. Copy that file
to the destination PC and run it directly; the UI is embedded, so no source files,
Rust installation, or `ui` folder are needed there. `cargo run --release` and
`cargo tauri build` also produce the executable in that location when building
for the default target. Explicit cross-compilation targets use
`target\<target-triple>\release\` instead.

The manual **Build release** GitHub Actions workflow also uploads
`Mideumi.Serial.Terminal_<version>_x64-portable.exe` to the draft GitHub Release,
alongside the Windows installers. Publish the draft when the builds are ready.

The destination PC needs the Microsoft Edge WebView2 Runtime. An installer can
set this up automatically; the portable executable requires it to be present.
See [Tauri's WebView runtime documentation](https://v2.tauri.app/reference/webview-versions/).

Portable distribution skips installation but does not sign the executable.
SmartScreen or company security policies may still warn or block it. Signing is
a separate step; see [Windows code signing](https://v2.tauri.app/distribute/sign/windows/).

## Windows installer location

Run the `x64-setup.exe` installer interactively and use **Browse** on the
**Choose Install Location** page to select the destination folder. The `.msi`
installer also includes a destination-folder page. These use Tauri's standard
[NSIS directory page](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)
and [WiX directory dialog](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/msi/main.wxs).
Silent/passive installs skip the interactive folder selection, and upgrades can
reuse the existing installation directory.

Changing the installation folder does not change the current user's saved
settings location. The portable executable can simply be placed in the desired
folder without running an installer.

## Saved settings

Font family and size, buffer capacity, baud rate, timestamps, wrapping, and send
line ending are saved when changed and restored on the next run. The serial
port is saved when connecting. Window size and position are also remembered.

Preferences use the app's WebView local storage, and window state uses the
window-state plugin's app configuration file. Both live in the current user's
app data, rather than next to the executable. Running a replacement portable
executable under the same Windows account retains these settings as long as
the app identifier stays the same and its app data is not cleared. Moving the
executable to another PC or account does not transfer the settings.

The log contents, send history, active filter, and auto-scroll state are kept
only for the current session. Saving the buffer capacity does not save the log;
use Save to export messages you want to keep.

## Layout

- `src/serial.rs`: port listing, connect/disconnect, send, and the reader thread. It splits input into lines, timestamps them, and pushes them to the UI in ~30 ms batches over a Tauri channel.
- `ui/main.js`: line buffer (ring, size adjustable), virtualized view (only visible rows exist in the DOM), filter, highlighting, settings saved to localStorage.
- `ui/style.css`: theme colours (dark/light follow the OS).

## Features

- Connect/disconnect, port refresh, any baud rate
- Clear (Cmd+L on macOS, Ctrl+L on Windows/Linux), save buffer to file (respects the filter and timestamp setting)
- Buffer size (1k to 1M lines), font family/size (Cmd+wheel on macOS, Ctrl+wheel on Windows/Linux to zoom)
- PC-side timestamps, regex filter with matching text highlighted, keyword highlighting (`HIGHLIGHTS` in `ui/main.js`)
- Auto-scroll that pauses when you scroll up and resumes at the bottom
- Send bar with line-ending choice and Up/Down history
- Window position and size remembered between runs

## Platform behavior

- On macOS, paired `/dev/tty.*` and `/dev/cu.*` entries appear once, using the callout (`cu`) path. Unpaired `tty` entries remain available. Windows and Linux port lists are unchanged.
- New settings use the system monospace font. The font menu checks common macOS, Windows, and Linux fonts using local text measurements and hides unavailable choices. If a saved font is unavailable, the session uses system monospace. Detection is best effort; if canvas measurement is unavailable, all choices remain visible. The rest of the interface uses the native system UI font.
- Interface labels and buttons cannot be selected or dragged. Log messages and editable fields remain selectable; timestamps stay outside text selection.

## Shortcuts

Use Command (Cmd) for app shortcuts on macOS; use Control
(Ctrl) on Windows and Linux. Font wheel zoom uses Cmd on macOS and Ctrl on Windows/Linux.

| Shortcut | Action |
| --- | --- |
| Cmd+O (macOS), Ctrl+O (Windows/Linux) | Connect to the selected device |
| Cmd+D (macOS), Ctrl+D (Windows/Linux) | Disconnect |
| Cmd+S (macOS), Ctrl+S (Windows/Linux) | Save the log |
| Cmd+F (macOS), Ctrl+F (Windows/Linux) | Focus the filter field and select its text |
| Cmd+L (macOS), Ctrl+L (Windows/Linux) | Clear the log |
| Cmd+wheel (macOS), Ctrl+wheel (Windows/Linux), over the log | Change log font size |
| Cmd/Ctrl + `+` or `=` | Increase log font size by 0.5 pt |
| Cmd/Ctrl + `-` | Decrease log font size by 0.5 pt |
| Cmd/Ctrl + `0` | Reset log font size to 10 pt |
| Enter in the send field | Send the message |
| Up/Down in the send field | Navigate sent-message history |
| Escape in the filter field | Clear the filter |
| Escape | Close popup menus |
| Up/Down in the font-size field | Adjust font size by 0.5 pt |
| Enter in font-size, baud-rate, or buffer-size fields | Finish editing |
| Up, Page Up, or Home outside input/select/textarea fields | Pause auto-scroll |

Refresh has no app-defined shortcut. Connect does nothing while connected;
Disconnect does nothing while disconnected. Repeated requests are ignored while
connecting, disconnecting, or saving.

The macOS menu bar groups Connect, Disconnect and Save Log under File;
Find, Clear Log and Refresh Devices under Terminal. Edit retains native editing
commands. View contains Increase Font Size (Cmd++), Decrease Font Size (Cmd+-),
Reset Font Size (Cmd+0), and Full Screen; Window retains standard window actions.
Cmd+= also increases font size. macOS keyboard shortcuts activate their menu
items, including the usual menu-bar highlight.

## Buffer size

The default is 100,000 lines. Only visible log rows are rendered, including search
match highlights. Buffer capacity still affects memory, filtering and trimming
costs; it is a line limit, not a memory limit. At 100 characters per line, 100,000
lines contain about 10 million characters before JavaScript object, array and
layout overhead. Very long lines can require substantially more memory.

Keep 100,000 as a starting point for ordinary logs, or use 20,000–50,000 on a
memory-constrained device such as a Raspberry Pi. For retention planning,
100,000 lines represent about 16.7 minutes at 100 lines/second or 2.8 hours at
10 lines/second. Filtering scans retained lines, and complex regular expressions
can be slow. No fixed line count guarantees responsiveness for every workload.

On macOS, the title is centered in a custom draggable title area while retaining
the native window buttons. Windows and Linux keep their native title bars.
