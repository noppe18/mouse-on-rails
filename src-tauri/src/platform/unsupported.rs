use std::path::Path;

pub fn cursor_pos() -> Option<(i32, i32)> {
    None
}

pub fn set_cursor_pos(_x: i32, _y: i32) {}

pub fn set_input_blocked(_blocked: bool) {}

pub fn take_blocked_input_count() -> u32 {
    0
}

pub fn reveal_in_file_manager(_path: &Path) {}
