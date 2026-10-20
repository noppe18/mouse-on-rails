// Windows 実装。
// 走行中の物理マウス入力は低レベルマウスフック (WH_MOUSE_LL) で破棄し、
// カーソルは SetCursorPos で車両に追従させる。
// SetCursorPos 等の合成入力 (LLMHF_INJECTED) は通すため、アプリ自身の移動は妨げない。
// 乗車中は低レベルキーボードフック (WH_KEYBOARD_LL) で Esc を監視し、緊急脱出に使う。
use std::path::Path;
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;

use windows_sys::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetCursorPos, GetMessageW, PeekMessageW, PostThreadMessageW,
    SetCursorPos, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT,
    LLKHF_INJECTED, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, WH_KEYBOARD_LL, WH_MOUSE_LL,
    WM_KEYDOWN, WM_QUIT, WM_SYSKEYDOWN, WM_USER,
};

static BLOCKING: AtomicBool = AtomicBool::new(false);
static ESCAPE_ARMED: AtomicBool = AtomicBool::new(false);
static ESCAPE_PRESSED: AtomicBool = AtomicBool::new(false);
static BLOCKED_COUNT: AtomicU32 = AtomicU32::new(0);
/// フックを保持しているスレッドの ID
static HOOK_THREAD: Mutex<Option<u32>> = Mutex::new(None);

pub fn cursor_pos() -> Option<(i32, i32)> {
    let mut p = POINT { x: 0, y: 0 };
    // SAFETY: 有効な POINT へのポインタを渡している
    (unsafe { GetCursorPos(&mut p) } != 0).then_some((p.x, p.y))
}

pub fn set_cursor_pos(x: i32, y: i32) {
    // SAFETY: 引数は単なる座標
    unsafe { SetCursorPos(x, y) };
}

/// 物理マウス入力の破棄を開始／終了する
pub fn set_input_blocked(blocked: bool) {
    BLOCKING.store(blocked, Ordering::SeqCst);
    update_hook_thread();
}

/// Esc キーによる緊急脱出の監視を開始／終了する（乗車中だけ有効にする）
pub fn set_escape_armed(armed: bool) {
    ESCAPE_ARMED.store(armed, Ordering::SeqCst);
    if !armed {
        ESCAPE_PRESSED.store(false, Ordering::SeqCst);
    }
    update_hook_thread();
}

/// 前回呼び出し以降に Esc による緊急脱出が要求されたか
pub fn take_escape_pressed() -> bool {
    ESCAPE_PRESSED.swap(false, Ordering::SeqCst)
}

/// 前回呼び出し以降に破棄した物理マウス入力の数
pub fn take_blocked_input_count() -> u32 {
    BLOCKED_COUNT.swap(0, Ordering::SeqCst)
}

pub fn reveal_in_file_manager(path: &Path) {
    let _ = std::process::Command::new("explorer.exe").arg("/select,").arg(path).spawn();
}

/// フックは必要な間だけ専用スレッドに設置し、不要になったら取り外す
fn update_hook_thread() {
    let needed = BLOCKING.load(Ordering::SeqCst) || ESCAPE_ARMED.load(Ordering::SeqCst);
    let mut thread_id = HOOK_THREAD.lock().unwrap();
    if needed && thread_id.is_none() {
        *thread_id = spawn_hook_thread();
    } else if !needed {
        if let Some(id) = thread_id.take() {
            // SAFETY: フックスレッドのメッセージループを終了させる
            unsafe { PostThreadMessageW(id, WM_QUIT, 0, 0) };
        }
    }
}

fn spawn_hook_thread() -> Option<u32> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || unsafe {
        let mut msg: MSG = std::mem::zeroed();
        // PostThreadMessageW を受け取れるよう、先にメッセージキューを作る
        PeekMessageW(&mut msg, null_mut(), WM_USER, WM_USER, PM_NOREMOVE);
        let module = GetModuleHandleW(null_mut());
        let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), module, 0);
        let keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), module, 0);
        if mouse.is_null() && keyboard.is_null() {
            let _ = tx.send(None);
            return;
        }
        let _ = tx.send(Some(GetCurrentThreadId()));
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if !mouse.is_null() {
            UnhookWindowsHookEx(mouse);
        }
        if !keyboard.is_null() {
            UnhookWindowsHookEx(keyboard);
        }
    });
    rx.recv().ok().flatten()
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && BLOCKING.load(Ordering::Relaxed) {
        let info = &*(lparam as *const MSLLHOOKSTRUCT);
        if info.flags & LLMHF_INJECTED == 0 {
            BLOCKED_COUNT.fetch_add(1, Ordering::Relaxed);
            // 非ゼロを返すと入力はシステムに渡らない
            return 1;
        }
    }
    CallNextHookEx(null_mut(), code, wparam, lparam)
}

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32
        && ESCAPE_ARMED.load(Ordering::Relaxed)
        && (wparam == WM_KEYDOWN as WPARAM || wparam == WM_SYSKEYDOWN as WPARAM)
    {
        let info = &*(lparam as *const KBDLLHOOKSTRUCT);
        if info.vkCode == VK_ESCAPE as u32 && info.flags & LLKHF_INJECTED == 0 {
            // アプリ本体が応答しなくても即座にマウスを解放する
            BLOCKING.store(false, Ordering::SeqCst);
            ESCAPE_PRESSED.store(true, Ordering::SeqCst);
            // 背後のアプリに Esc が届かないよう握りつぶす
            return 1;
        }
    }
    CallNextHookEx(null_mut(), code, wparam, lparam)
}
