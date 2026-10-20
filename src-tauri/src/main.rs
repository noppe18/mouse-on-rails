// リリースビルドではコンソールウィンドウを出さない
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod overlay;
mod platform;
mod storage;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use overlay::OverlayState;
use storage::Store;

const DEFAULT_HOTKEY: &str = "Ctrl+Alt+M";

fn main() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        overlay::toggle(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap,
            commands::hide_overlay,
            commands::set_ignore_cursor,
            commands::set_cursor,
            commands::lock_cursor,
            commands::record_ride,
            commands::unlock_lines,
        ])
        .setup(|app| {
            let store = Store::load(app.handle());
            let hotkey = store.settings().hotkey.clone();
            app.manage(store);
            app.manage(OverlayState::default());

            register_hotkey(app.handle(), &hotkey);
            build_tray(app)?;
            overlay::spawn_poller(app.handle().clone());

            // 初回は使い方が分かるよう路線図を表示しておく
            overlay::show(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Alt+F4 等ではアプリを終了せず、オーバーレイを閉じるだけにする
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                overlay::hide(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Mouse on Rails");

    app.run(|_app, event| {
        if let RunEvent::Exit = event {
            // 終了時は必ずマウス拘束を解除する
            platform::set_input_blocked(false);
        }
    });
}

fn register_hotkey(app: &tauri::AppHandle, hotkey: &str) {
    let shortcut = hotkey.parse::<Shortcut>().unwrap_or_else(|e| {
        eprintln!("ホットキー {hotkey:?} を解釈できません ({e})。{DEFAULT_HOTKEY} を使用します");
        DEFAULT_HOTKEY.parse().expect("default hotkey")
    });
    if let Err(e) = app.global_shortcut().register(shortcut) {
        eprintln!("ホットキーを登録できません: {e}");
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let hotkey = app.state::<Store>().settings().hotkey.clone();
    let show = MenuItem::with_id(app, "show", format!("路線図を表示 ({hotkey})"), true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "設定ファイルの場所を表示", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &settings, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Mouse on Rails")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => overlay::show(app),
            "settings" => {
                let path = app.state::<Store>().settings_path();
                platform::reveal_in_file_manager(&path);
            }
            "quit" => {
                platform::set_input_blocked(false);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                overlay::toggle(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
