// オーバーレイウィンドウの表示制御、座標変換、カーソル監視
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::platform;

const WINDOW_LABEL: &str = "overlay";
const POLL_INTERVAL: Duration = Duration::from_millis(16);
/// フロントエンドからのハートビートがこの時間途絶えたら拘束を自動解除する
const HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(1500);

/// オーバーレイが覆っているモニターの物理座標と拡大率
#[derive(Clone, Copy)]
struct Geometry {
    origin_x: i32,
    origin_y: i32,
    scale: f64,
}

pub struct OverlayState {
    visible: AtomicBool,
    locked: AtomicBool,
    geometry: Mutex<Geometry>,
    heartbeat: Mutex<Instant>,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            visible: AtomicBool::new(false),
            locked: AtomicBool::new(false),
            geometry: Mutex::new(Geometry { origin_x: 0, origin_y: 0, scale: 1.0 }),
            heartbeat: Mutex::new(Instant::now()),
        }
    }
}

impl OverlayState {
    pub fn is_visible(&self) -> bool {
        self.visible.load(Ordering::SeqCst)
    }

    pub fn heartbeat(&self) {
        *self.heartbeat.lock().unwrap() = Instant::now();
    }

    /// 物理マウス入力によるカーソル移動を禁止／許可する
    pub fn set_locked(&self, locked: bool) {
        // 非表示中に拘束することはない
        let locked = locked && self.is_visible();
        if locked {
            self.heartbeat();
        }
        self.locked.store(locked, Ordering::SeqCst);
        platform::set_input_blocked(locked);
    }

    pub fn is_locked(&self) -> bool {
        self.locked.load(Ordering::SeqCst)
    }

    /// ウィンドウ内の CSS 座標 → 画面の物理座標
    pub fn to_screen(&self, x: f64, y: f64) -> (i32, i32) {
        let g = *self.geometry.lock().unwrap();
        (g.origin_x + (x * g.scale).round() as i32, g.origin_y + (y * g.scale).round() as i32)
    }

    fn to_client(&self, x: i32, y: i32) -> CursorPayload {
        let g = *self.geometry.lock().unwrap();
        CursorPayload { x: (x - g.origin_x) as f64 / g.scale, y: (y - g.origin_y) as f64 / g.scale }
    }
}

#[derive(Clone, Copy, Serialize, PartialEq)]
struct CursorPayload {
    x: f64,
    y: f64,
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

/// カーソルのあるモニター全体を覆うようにオーバーレイを表示する
pub fn show(app: &AppHandle) {
    let Some(win) = window(app) else { return };
    let state = app.state::<OverlayState>();

    let cursor = platform::cursor_pos();
    let monitors = win.available_monitors().unwrap_or_default();
    let monitor = cursor
        .and_then(|(cx, cy)| {
            monitors.iter().find(|m| {
                let (p, s) = (m.position(), m.size());
                cx >= p.x && cy >= p.y && cx < p.x + s.width as i32 && cy < p.y + s.height as i32
            })
        })
        .cloned()
        .or_else(|| win.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned());

    if let Some(m) = monitor {
        let (p, s) = (*m.position(), *m.size());
        *state.geometry.lock().unwrap() = Geometry { origin_x: p.x, origin_y: p.y, scale: m.scale_factor() };
        let _ = win.set_position(PhysicalPosition::new(p.x, p.y));
        let _ = win.set_size(PhysicalSize::new(s.width, s.height));
    }

    state.visible.store(true, Ordering::SeqCst);
    let _ = win.set_ignore_cursor_events(true);
    let _ = win.show();
    let _ = win.set_always_on_top(true);
    let _ = win.set_focus();
    let _ = app.emit("overlay-shown", ());
}

/// オーバーレイを閉じる。走行中であれば拘束を解除する（緊急停止）
pub fn hide(app: &AppHandle) {
    let state = app.state::<OverlayState>();
    state.visible.store(false, Ordering::SeqCst);
    state.set_locked(false);
    if let Some(win) = window(app) {
        let _ = win.hide();
    }
    let _ = app.emit("overlay-hidden", ());
}

pub fn toggle(app: &AppHandle) {
    if app.state::<OverlayState>().is_visible() {
        hide(app);
    } else {
        show(app);
    }
}

/// カーソル位置の通知、抑止したマウス入力の通知、拘束のウォッチドッグを行う
pub fn spawn_poller(app: AppHandle) {
    thread::spawn(move || {
        let mut last: Option<CursorPayload> = None;
        loop {
            thread::sleep(POLL_INTERVAL);
            let state = app.state::<OverlayState>();

            if state.is_locked() && state.heartbeat.lock().unwrap().elapsed() > HEARTBEAT_TIMEOUT {
                // フロントエンドが応答しない場合でも操作不能にしない
                state.set_locked(false);
                let _ = app.emit("lock-released", ());
            }

            let blocked = platform::take_blocked_input_count();
            if blocked > 0 && state.is_locked() {
                let _ = app.emit("mouse-blocked", blocked);
            }

            if !state.is_visible() {
                last = None;
                continue;
            }
            if let Some((x, y)) = platform::cursor_pos() {
                let p = state.to_client(x, y);
                if last != Some(p) {
                    last = Some(p);
                    let _ = app.emit("cursor", p);
                }
            }
        }
    });
}
