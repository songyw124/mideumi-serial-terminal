# UART Viewer

Small serial debug viewer for the cell cycler. Tauri 2 + Rust backend, plain HTML/CSS/JS frontend (no npm, no build step).

## Run

```
cargo run            # debug build, opens the window
cargo run --release  # faster, no console window
```

Building an installer needs the Tauri CLI once: `cargo install tauri-cli --version "^2"`, then `cargo tauri build`.
The icons in `icons/` are placeholders copied from channel-calibration. Regenerate with `cargo tauri icon <image.png>`.

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
