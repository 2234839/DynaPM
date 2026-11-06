//! 命令行友好日志：TTY 下彩色简洁行，重定向/文件时纯文本行 + 时间前缀

use std::sync::atomic::{AtomicBool, Ordering};

static REQUEST_LOG: AtomicBool = AtomicBool::new(false);
static WS_LOG: AtomicBool = AtomicBool::new(false);

#[repr(C)]
struct libc_tm {
    tm_sec: i32,
    tm_min: i32,
    tm_hour: i32,
    tm_mday: i32,
    tm_mon: i32,
    tm_year: i32,
    tm_wday: i32,
    tm_yday: i32,
    tm_isdst: i32,
    tm_gmtoff: i64,
    tm_zone: *const std::ffi::c_char,
}

extern "C" {
    fn isatty(fd: i32) -> i32;
    fn localtime_r(time: *const i64, result: *mut libc_tm) -> *mut libc_tm;
}

/** 初始化日志开关（来自配置 logging 节） */
pub fn init(enable_request_log: bool, enable_websocket_log: bool) {
    REQUEST_LOG.store(enable_request_log, Ordering::Relaxed);
    WS_LOG.store(enable_websocket_log, Ordering::Relaxed);
}

/** 请求日志是否启用 */
pub fn request_log_enabled() -> bool {
    REQUEST_LOG.load(Ordering::Relaxed)
}

/** WebSocket 日志是否启用 */
pub fn ws_log_enabled() -> bool {
    WS_LOG.load(Ordering::Relaxed)
}

/** 标准错误是否为终端（决定是否着色；进程内只探测一次） */
fn is_tty() -> bool {
    use std::sync::OnceLock;
    static TTY: OnceLock<bool> = OnceLock::new();
    *TTY.get_or_init(|| unsafe { isatty(2) == 1 })
}

fn now_compact() -> String {
    // 无 chrono 依赖：HH:MM:SS（本地时区）
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    unsafe {
        let mut tm: libc_tm = std::mem::zeroed();
        if localtime_r(&secs, &mut tm).is_null() {
            return String::new();
        }
        format!("{:02}:{:02}:{:02}", tm.tm_hour, tm.tm_min, tm.tm_sec)
    }
}

/** 级别标签与 ANSI 颜色 */
fn level_style(level: &str) -> (&'static str, &'static str) {
    match level {
        "error" => ("\x1b[31m", "ERROR"),
        "warn" => ("\x1b[33m", "WARN "),
        _ => ("\x1b[36m", "INFO "),
    }
}

fn emit(level: &str, msg: &str, error: Option<&str>) {
    let (color, tag) = level_style(level);
    let line = match error {
        Some(e) => format!("{msg}: {e}"),
        None => msg.to_string(),
    };
    if is_tty() {
        // 终端：灰色时间 + 着色级别 + 消息原文（emoji 已在 msg 内）
        eprintln!("\x1b[90m{}\x1b[0m {color}{tag}\x1b[0m {line}", now_compact());
    } else {
        // 文件/管道：无转义序列，便于 grep
        eprintln!("{} {} {}", now_compact(), tag, line.trim());
    }
}

/// 记录 info 日志
pub fn info(msg: &str) {
    emit("info", msg, None);
}

/// 记录 warn 日志
pub fn warn(msg: &str) {
    emit("warn", msg, None);
}

/// 记录 error 日志
pub fn error(msg: &str, err: Option<&str>) {
    emit("error", msg, err);
}
