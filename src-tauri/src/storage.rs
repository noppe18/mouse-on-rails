// 設定と乗車記録のローカル永続化
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 設定ファイルの形式のバージョン。既定値を見直したら上げる
const SETTINGS_VERSION: u32 = 2;

fn legacy_version() -> u32 {
    1
}

/// ユーザーが編集できる設定（settings.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// 設定ファイルの形式のバージョン（省略時は最初の版とみなす）
    #[serde(default = "legacy_version")]
    pub version: u32,
    /// 路線図を表示するグローバルホットキー
    pub hotkey: String,
    /// 乗車してから発車するまでの時間 [秒]
    pub boarding_sec: f64,
    /// 各駅の停車時間 [秒]
    pub dwell_sec: f64,
    /// 発車前に遅延が発生する確率 (0〜1)
    pub delay_probability: f64,
    pub delay_min_sec: f64,
    pub delay_max_sec: f64,
    /// 走行速度 [論理ピクセル/秒]
    pub speed_px_per_sec: f64,
    pub min_segment_sec: f64,
    pub max_segment_sec: f64,
    /// 音量 (0〜1)
    pub volume: f64,
    /// 音声ファイルが無いアナウンスを OS の音声合成で読み上げるか
    pub speech_fallback: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            hotkey: "Ctrl+Alt+M".into(),
            boarding_sec: 1.5,
            dwell_sec: 1.0,
            delay_probability: 0.15,
            delay_min_sec: 4.0,
            delay_max_sec: 10.0,
            speed_px_per_sec: 200.0,
            min_segment_sec: 3.0,
            max_segment_sec: 10.5,
            volume: 0.9,
            speech_fallback: true,
        }
    }
}

impl Settings {
    /// 古い版の設定ファイルは、見直した走行速度と停車時間を新しい既定値にする
    fn migrated(mut self) -> Self {
        if self.version < 2 {
            let d = Settings::default();
            self.dwell_sec = d.dwell_sec;
            self.speed_px_per_sec = d.speed_px_per_sec;
            self.min_segment_sec = d.min_segment_sec;
            self.max_segment_sec = d.max_segment_sec;
        }
        self.version = SETTINGS_VERSION;
        self
    }

    /// 不正な値や、ユーザーが長時間操作不能になる値を丸める
    fn sanitized(mut self) -> Self {
        let d = Settings::default();
        let fix = |v: f64, lo: f64, hi: f64, def: f64| if v.is_finite() { v.clamp(lo, hi) } else { def };
        self.boarding_sec = fix(self.boarding_sec, 0.3, 10.0, d.boarding_sec);
        self.dwell_sec = fix(self.dwell_sec, 0.5, 15.0, d.dwell_sec);
        self.delay_probability = fix(self.delay_probability, 0.0, 1.0, d.delay_probability);
        self.delay_min_sec = fix(self.delay_min_sec, 0.0, 60.0, d.delay_min_sec);
        self.delay_max_sec = fix(self.delay_max_sec, self.delay_min_sec, 60.0, d.delay_max_sec);
        self.speed_px_per_sec = fix(self.speed_px_per_sec, 50.0, 5000.0, d.speed_px_per_sec);
        self.min_segment_sec = fix(self.min_segment_sec, 0.2, 30.0, d.min_segment_sec);
        self.max_segment_sec = fix(self.max_segment_sec, self.min_segment_sec, 60.0, d.max_segment_sec);
        self.volume = fix(self.volume, 0.0, 1.0, d.volume);
        if self.hotkey.trim().is_empty() {
            self.hotkey = d.hotkey;
        }
        self
    }
}

/// 乗車記録（progress.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Progress {
    pub total_rides: u64,
    pub unlocked_lines: Vec<String>,
}

impl Default for Progress {
    fn default() -> Self {
        Self { total_rides: 0, unlocked_lines: vec!["yamanote".into()] }
    }
}

pub struct Store {
    settings: Settings,
    settings_path: PathBuf,
    progress: Mutex<Progress>,
    progress_path: PathBuf,
}

impl Store {
    pub fn load(app: &AppHandle) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("mouse-on-rails"));
        let _ = fs::create_dir_all(&dir);
        let settings_path = dir.join("settings.json");
        let progress_path = dir.join("progress.json");

        let loaded = read_json::<Settings>(&settings_path);
        // 書き損じで読めないファイルは上書きしない
        let outdated = !settings_path.exists() || loaded.as_ref().is_some_and(|s| s.version < SETTINGS_VERSION);
        let settings = loaded.unwrap_or_default().migrated().sanitized();
        // 設定ファイルが無いか古ければ、編集の手がかりとして書き出す
        if outdated {
            let _ = write_json(&settings_path, &settings);
        }
        let progress = read_json::<Progress>(&progress_path).unwrap_or_default();
        Self { settings, settings_path, progress: Mutex::new(progress), progress_path }
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn settings_path(&self) -> PathBuf {
        self.settings_path.clone()
    }

    pub fn log_path(&self) -> PathBuf {
        self.settings_path.with_file_name("mouse-on-rails.log")
    }

    pub fn progress(&self) -> Progress {
        self.progress.lock().unwrap().clone()
    }

    pub fn update_progress(&self, f: impl FnOnce(&mut Progress)) -> Result<Progress, String> {
        let mut p = self.progress.lock().unwrap();
        f(&mut p);
        write_json(&self.progress_path, &*p).map_err(|e| e.to_string())?;
        Ok(p.clone())
    }
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!("{} を読み込めません: {e}", path.display());
            None
        }
    }
}

/// 一時ファイルに書いてから置き換え、書き込み途中の破損を防ぐ
fn write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(value)?)?;
    fs::rename(&tmp, path)
}
