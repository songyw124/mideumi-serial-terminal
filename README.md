# UART Viewer

Small serial debug viewer for the cell cycler. Tauri 2 + Rust backend, plain HTML/CSS/JS frontend (no npm, no build step).

## Run

```
cargo run            # debug build, opens the window
cargo run --release  # faster, no console window
```

Building an installer needs the Tauri CLI once: `cargo install tauri-cli --version "^2"`, then `cargo tauri build`.
The UART Viewer icon source is `icons/icon.png`, with PNG, Windows ICO, and macOS ICNS variants in `icons/`. Regenerate with `cargo tauri icon icons/icon.png`.

## Layout

- `src/serial.rs`: port listing, connect/disconnect, send, and the reader thread. It splits input into lines, timestamps them, and pushes them to the UI in ~30 ms batches over a Tauri channel.
- `ui/main.js`: line buffer (ring, size adjustable), virtualized view (only visible rows exist in the DOM), filter, highlighting, settings saved to localStorage.
- `ui/style.css`: theme colours (dark/light follow the OS).

## Features

- Connect/disconnect, port refresh, any baud rate
- Clear (Ctrl+L), save buffer to file (respects the filter and timestamp setting)
- Buffer size (1k to 1M lines), font family/size (Ctrl+wheel to zoom)
- PC-side timestamps, regex filter, keyword highlighting (`HIGHLIGHTS` in `ui/main.js`)
- Auto-scroll that pauses when you scroll up and resumes at the bottom
- Send bar with line-ending choice and Up/Down history
- Window position and size remembered between runs

## Platform behavior

- On macOS, paired `/dev/tty.*` and `/dev/cu.*` entries appear once, using the callout (`cu`) path. Unpaired `tty` entries remain available. Windows and Linux port lists are unchanged.
- New settings use the system monospace font. The font menu checks common macOS, Windows, and Linux fonts using local text measurements and hides unavailable choices. If a saved font is unavailable, the session uses system monospace. Detection is best effort; if canvas measurement is unavailable, all choices remain visible. The rest of the interface uses the native system UI font.
- Interface labels and buttons cannot be selected or dragged. Log messages and editable fields remain selectable; timestamps stay outside text selection.

## Shortcuts

These app-defined bindings are the same on Windows, macOS, and Linux. On macOS,
Ctrl means the Control key; Command equivalents are not currently assigned.

| Shortcut | Action |
| --- | --- |
| Ctrl+L | Clear the log |
| Ctrl+mouse wheel over the log | Change log font size |
| Enter in the send field | Send the message |
| Up/Down in the send field | Navigate sent-message history |
| Escape in the filter field | Clear the filter |
| Escape | Close popup menus |
| Up/Down in the font-size field | Adjust font size by 0.5 pt |
| Enter in font-size, baud-rate, or buffer-size fields | Finish editing |
| Up, Page Up, or Home outside input/select/textarea fields | Pause auto-scroll |

Connect/disconnect, refresh, and save have no app-defined shortcuts.
