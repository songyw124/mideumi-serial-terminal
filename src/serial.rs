use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serialport::{SerialPort, SerialPortType};
use tauri::ipc::Channel;
use tauri::State;

/// Read timeout; also bounds how long disconnect waits for the reader thread
const READ_TIMEOUT: Duration = Duration::from_millis(50);
/// Received lines are pushed to the UI in batches at this interval, so high baud rates don't flood the webview
const FLUSH_INTERVAL: Duration = Duration::from_millis(30);
/// Text without a trailing newline (e.g. a prompt) is shown once the port has been idle this long
const PARTIAL_LINE_TIMEOUT: Duration = Duration::from_millis(200);
/// Lines longer than this are split, so binary garbage without newlines can't grow a line forever
const MAX_LINE_BYTES: usize = 4096;

#[derive(Serialize)]
pub struct PortInfo {
    name: String,
    description: String,
}

#[derive(Serialize)]
pub struct Line {
    /// Unix time in ms when the first byte of the line arrived
    ts: u64,
    text: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SerialEvent {
    Lines { lines: Vec<Line>, bytes: usize },
    Closed { error: Option<String> },
}

struct Connection {
    writer: Box<dyn SerialPort>,
    stop: Arc<AtomicBool>,
    reader: JoinHandle<()>,
}

impl Connection {
    fn close(self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.reader.join();
    }
}

#[derive(Default)]
pub struct SerialState(Mutex<Option<Connection>>);

#[tauri::command]
pub fn list_ports() -> Result<Vec<PortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports
        .into_iter()
        .map(|p| {
            let description = match p.port_type {
                SerialPortType::UsbPort(usb) => usb
                    .product
                    .unwrap_or_else(|| format!("USB {:04X}:{:04X}", usb.vid, usb.pid)),
                SerialPortType::BluetoothPort => "Bluetooth".into(),
                _ => String::new(),
            };
            PortInfo { name: p.port_name, description }
        })
        .collect())
}

#[tauri::command]
pub async fn connect(
    state: State<'_, SerialState>,
    port: String,
    baud: u32,
    on_event: Channel<SerialEvent>,
) -> Result<(), String> {
    let mut conn = state.0.lock().unwrap();
    if let Some(old) = conn.take() {
        old.close();
    }

    let reader_port = serialport::new(&port, baud)
        .timeout(READ_TIMEOUT)
        .open()
        .map_err(|e| format!("{port}: {e}"))?;
    let writer = reader_port.try_clone().map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let reader = {
        let stop = stop.clone();
        std::thread::spawn(move || read_loop(reader_port, stop, on_event))
    };

    *conn = Some(Connection { writer, stop, reader });
    Ok(())
}

#[tauri::command]
pub async fn disconnect(state: State<'_, SerialState>) -> Result<(), String> {
    if let Some(conn) = state.0.lock().unwrap().take() {
        conn.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn send(state: State<'_, SerialState>, data: String) -> Result<(), String> {
    let mut conn = state.0.lock().unwrap();
    let conn = conn.as_mut().ok_or_else(|| "Not connected".to_string())?;
    conn.writer
        .write_all(data.as_bytes())
        .and_then(|_| conn.writer.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_text(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

fn read_loop(mut port: Box<dyn SerialPort>, stop: Arc<AtomicBool>, on_event: Channel<SerialEvent>) {
    let mut buf = [0u8; 4096];
    let mut partial: Vec<u8> = Vec::new();
    let mut partial_ts = 0;
    let mut last_rx = Instant::now();
    let mut pending: Vec<Line> = Vec::new();
    let mut pending_bytes = 0;
    let mut last_flush = Instant::now();

    let error = loop {
        if stop.load(Ordering::Relaxed) {
            break None;
        }

        match port.read(&mut buf) {
            Ok(0) => {}
            Ok(n) => {
                let now = now_ms();
                last_rx = Instant::now();
                pending_bytes += n;
                for &b in &buf[..n] {
                    if partial.is_empty() {
                        partial_ts = now;
                    }
                    if b == b'\n' {
                        pending.push(make_line(partial_ts, &mut partial));
                    } else {
                        partial.push(b);
                        if partial.len() >= MAX_LINE_BYTES {
                            pending.push(make_line(partial_ts, &mut partial));
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            // Typically the USB-UART was unplugged or the board reset its USB device
            Err(e) => break Some(e.to_string()),
        }

        if !partial.is_empty() && last_rx.elapsed() >= PARTIAL_LINE_TIMEOUT {
            pending.push(make_line(partial_ts, &mut partial));
        }

        if pending_bytes > 0 && last_flush.elapsed() >= FLUSH_INTERVAL {
            let lines = std::mem::take(&mut pending);
            let bytes = std::mem::take(&mut pending_bytes);
            if on_event.send(SerialEvent::Lines { lines, bytes }).is_err() {
                break None; // window is gone
            }
            last_flush = Instant::now();
        }
    };

    if !partial.is_empty() {
        pending.push(make_line(partial_ts, &mut partial));
    }
    if !pending.is_empty() {
        let _ = on_event.send(SerialEvent::Lines { lines: pending, bytes: pending_bytes });
    }
    let _ = on_event.send(SerialEvent::Closed { error });
}

/// Turns the collected bytes into a line (dropping a trailing '\r') and clears the buffer
fn make_line(ts: u64, partial: &mut Vec<u8>) -> Line {
    if partial.last() == Some(&b'\r') {
        partial.pop();
    }
    let text = String::from_utf8_lossy(partial).into_owned();
    partial.clear();
    Line { ts, text }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
