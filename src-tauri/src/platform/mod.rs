// OS 依存処理の境界。
// 各 OS 向けモジュールは同じ関数群を公開する:
//   cursor_pos / set_cursor_pos / set_input_blocked / take_blocked_input_count / reveal_in_file_manager

#[cfg(windows)]
mod win32;
#[cfg(windows)]
pub use win32::*;

// macOS 等は未対応。ビルドは通るよう何もしない実装を置く
#[cfg(not(windows))]
mod unsupported;
#[cfg(not(windows))]
pub use unsupported::*;
