// 不具合調査用の簡易ログ（設定ファイルと同じフォルダの mouse-on-rails.log）
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// これを超えたら古いログを捨てる
const MAX_BYTES: u64 = 512 * 1024;

static PATH: OnceLock<PathBuf> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::new(());

pub fn init(path: PathBuf) {
    if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = fs::remove_file(&path);
    }
    let _ = PATH.set(path);
    write(&format!("起動 v{}", env!("CARGO_PKG_VERSION")));
}

pub fn write(message: &str) {
    let Some(path) = PATH.get() else { return };
    let _guard = LOCK.lock();
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{secs:.3}] {message}");
    }
}
