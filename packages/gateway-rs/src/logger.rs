//! JSON-line 结构化日志（与 Bun 版 pino 风格输出对齐）

use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};

static REQUEST_LOG: AtomicBool = AtomicBool::new(false);
static WS_LOG: AtomicBool = AtomicBool::new(false);

/// 初始化日志开关（来自配置 logging 节）
pub fn init(enable_request_log: bool, enable_websocket_log: bool) {
    REQUEST_LOG.store(enable_request_log, Ordering::Relaxed);
    WS_LOG.store(enable_websocket_log, Ordering::Relaxed);
}

/// 请求日志是否启用
pub fn request_log_enabled() -> bool {
    REQUEST_LOG.load(Ordering::Relaxed)
}

/// WebSocket 日志是否启用
pub fn ws_log_enabled() -> bool {
    WS_LOG.load(Ordering::Relaxed)
}

fn now_iso() -> String {
    // 无 chrono 依赖：用 unix 毫秒时间戳，保留 pino time 字段语义
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{ms}")
}

fn emit(level: &str, msg: &str, error: Option<&str>) {
    let mut line = json!({ "level": level, "time": now_iso(), "msg": msg });
    if let Some(e) = error {
        line["error"] = json!(e);
    }
    if level == "error" {
        eprintln!("{line}");
    } else {
        println!("{line}");
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
