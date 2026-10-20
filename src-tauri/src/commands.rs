// フロントエンドから呼び出すコマンド
use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};

use crate::overlay::{self, OverlayState};
use crate::platform;
use crate::storage::{Progress, Settings, Store};

#[derive(Serialize)]
pub struct Bootstrap {
    settings: Settings,
    progress: Progress,
}

#[tauri::command]
pub fn get_bootstrap(store: State<Store>) -> Bootstrap {
    Bootstrap { settings: store.settings().clone(), progress: store.progress() }
}

#[tauri::command]
pub fn hide_overlay(app: AppHandle) {
    overlay::hide(&app);
}

/// true の間、オーバーレイへのマウス操作を背後のウィンドウへ透過させる
#[tauri::command]
pub fn set_ignore_cursor(window: WebviewWindow, ignore: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())
}

/// OS のカーソルを移動する（ウィンドウ内 CSS 座標）。走行中のハートビートも兼ねる
#[tauri::command]
pub fn set_cursor(state: State<OverlayState>, x: f64, y: f64) {
    if !state.is_visible() {
        return;
    }
    state.heartbeat();
    let (sx, sy) = state.to_screen(x, y);
    platform::set_cursor_pos(sx, sy);
}

#[tauri::command]
pub fn lock_cursor(state: State<OverlayState>, locked: bool) {
    state.set_locked(locked);
}

/// 乗車中かどうか（乗車中は Esc で緊急脱出できる）
#[tauri::command]
pub fn set_riding(state: State<OverlayState>, riding: bool) {
    state.set_riding(riding);
}

/// 乗車1回を記録する
#[tauri::command]
pub fn record_ride(store: State<Store>) -> Result<Progress, String> {
    store.update_progress(|p| p.total_rides += 1)
}

#[tauri::command]
pub fn unlock_lines(store: State<Store>, ids: Vec<String>) -> Result<Progress, String> {
    store.update_progress(|p| {
        for id in ids {
            if !p.unlocked_lines.contains(&id) {
                p.unlocked_lines.push(id);
            }
        }
    })
}
