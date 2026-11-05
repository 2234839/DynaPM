//! 管理 API（路径与响应结构与 Bun 版 admin-api.ts 对齐）
//!
//! - GET    /_dynapm/api/services         服务列表
//! - GET    /_dynapm/api/services/:name   服务详情
//! - POST   /_dynapm/api/services/:name/stop
//! - POST   /_dynapm/api/services/:name/start
//! - GET    /_dynapm/api/events           SSE 事件流

use crate::gateway::Gateway;
use crate::logger;
use crate::state::{health_check_type_name, ServiceRuntime, Status};
use axum::body::Body;
use axum::extract::Path;
use axum::response::IntoResponse;
use futures_util::Stream;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// 认证校验：配置了 authToken 时要求 Bearer 头或 ?token= 查询参数匹配
/// （query 方式供 EventSource SSE 使用——无法自定义请求头；全链路 HTTPS 下中间服务器只见密文）
fn is_authorized(uri: &axum::http::Uri, headers: &axum::http::HeaderMap, token: Option<&String>) -> bool {
    match token {
        None => true,
        Some(t) => {
            let bearer_ok = headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .map(|h| h.trim_start_matches("Bearer ").trim() == t.trim())
                .unwrap_or(false);
            if bearer_ok {
                return true;
            }
            uri.query()
                .and_then(|q| {
                    q.split('&').find_map(|kv| {
                        let (k, v) = kv.split_once('=')?;
                        (k == "token").then(|| v.to_string())
                    })
                })
                .map(|v| v == t.trim())
                .unwrap_or(false)
        }
    }
}

/// 通用鉴权入口（不匹配返回 Some(错误响应)）
fn auth_check(uri: &axum::http::Uri, headers: &axum::http::HeaderMap, gw: &Gateway) -> Option<axum::response::Response> {
    let token = gw.admin_auth_token();
    if !is_authorized(uri, headers, token) {
        return Some(
            axum::response::Response::builder()
                .status(axum::http::StatusCode::UNAUTHORIZED)
                .header("WWW-Authenticate", "Bearer")
                .body(Body::from("Unauthorized"))
                .unwrap(),
        );
    }
    None
}

/// GET /_dynapm/api/services
pub async fn list_services(
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    axum::Extension(gw): axum::Extension<Arc<Gateway>>,
) -> axum::response::Response {
    if let Some(resp) = auth_check(&uri, &headers, &gw) {
        return resp;
    }
    let mut services = Vec::new();
    // 收集各服务的域名路由（供面板生成跳转链接）
    let mut hosts_by_service: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for rt in gw.all_runtimes() {
        hosts_by_service.entry(rt.config.name.clone()).or_default();
    }
    for (host, mapping) in gw.hostname_routes.lock().unwrap().iter() {
        hosts_by_service
            .entry(mapping.service.config.name.clone())
            .or_default()
            .push(host.clone());
    }
    for rt in gw.all_runtimes() {
        let hosts = hosts_by_service.get(&rt.config.name).cloned().unwrap_or_default();
        // 闲置回收倒计时（ms）：online 且无活跃连接时 = 阈值 - (now - lastAccess)，其余 null
        let idle_remaining_ms = {
            let threshold = if rt.config.keep_warm { rt.config.warm_idle_timeout } else { rt.config.idle_timeout };
            let conns = rt.active_connections.load(Ordering::Relaxed);
            let elapsed = crate::state::now_ms() as i64 - rt.last_access_ms.load(Ordering::Relaxed) as i64;
            (rt.status() == Status::Online && conns == 0 && !rt.config.proxy_only)
                .then(|| (threshold as i64 - elapsed).max(0))
        };
        services.push(serde_json::json!({
            "name": rt.config.name,
            "base": rt.config.base,
            "hosts": hosts,
            "status": rt.status().as_str(),
            "uptime": rt.session_uptime_ms(),
            "lastAccessTime": rt.last_access_ms.load(Ordering::Relaxed),
            "activeConnections": rt.active_connections.load(Ordering::Relaxed),
            "idleTimeout": rt.config.idle_timeout,
            "proxyOnly": rt.config.proxy_only,
            "pid": *rt.pid.lock().unwrap(),
            "paused": rt.paused.load(Ordering::Relaxed),
            "requestCount": rt.request_count.load(Ordering::Relaxed),
            "totalRequestMs": rt.total_request_ms.load(Ordering::Relaxed),
            "startCount": rt.start_count.load(Ordering::Relaxed),
            "totalUptime": rt.uptime_ms(),
            "idleRemainingMs": idle_remaining_ms,
            "lastStartDurationMs": rt.last_start_duration_ms.load(Ordering::Relaxed),
        }));
    }
    json_response(axum::http::StatusCode::OK, &serde_json::json!({ "services": services }))
}

/// 解析 /proc/<pid>/stat：返回 (pgid, utime+stime jiffies)（从最后一个 ')' 后按字段定位）
fn parse_stat(stat: &str) -> Option<(u64, u64)> {
    let after = stat.rsplit_once(')')?.1;
    let fields: Vec<&str> = after.split_whitespace().collect();
    // after 的字段 1 = state（原字段 3）：pgrp=fields[2]（原 5），utime=fields[11]，stime=fields[12]
    let pgid: u64 = fields.get(2)?.parse().ok()?;
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    Some((pgid, utime + stime))
}

/// 按进程组聚合资源：扫描 /proc 取 PGID==pgid 的所有存活成员，返回 (CPU jiffies 总和, RSS KB 总和)
/// （组长是已退出的启动 shell，真实服务进程以 pgid 归组，泵/bash 均计入）
fn read_pgid_group(pgid: u64) -> Option<(u64, u64)> {
    let mut total_jiffies: u64 = 0;
    let mut total_rss: u64 = 0;
    let mut found = false;
    let dir = std::fs::read_dir("/proc").ok()?;
    for entry in dir.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|s| s.parse::<u64>().ok()) else { continue };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
        let Some((pgrp, jiffies)) = parse_stat(&stat) else { continue };
        if pgrp != pgid { continue }
        found = true;
        total_jiffies += jiffies;
        if let Ok(status) = std::fs::read_to_string(format!("/proc/{pid}/status")) {
            if let Some(kb) = status.lines().find_map(|l| {
                l.strip_prefix("VmRSS:")?.trim_start().split_whitespace().next().and_then(|v| v.parse::<u64>().ok())
            }) {
                total_rss += kb;
            }
        }
    }
    found.then_some((total_jiffies, total_rss))
}

/** CLOCK_TICKS 固定 100（Linux 用户态 ABI 约定） */
const CLOCK_TICKS: f64 = 100.0;

/// 计算服务进程资源指标：cpuPercent（基于上次采样差值）、rssMb、cpuSeconds（累计）；无进程返回 null
fn proc_metrics(rt: &ServiceRuntime) -> serde_json::Value {
    let pgid = *rt.start_pgid.lock().unwrap();
    let Some(pgid) = pgid.filter(|g| *g > 0) else { return serde_json::Value::Null };
    let Some((jiffies, rss_kb)) = read_pgid_group(pgid as u64) else { return serde_json::Value::Null };
    let now = crate::state::now_ms() as u64;
    let mut last = rt.proc_cpu_last.lock().unwrap();
    let cpu_percent = match *last {
        Some((prev_j, prev_ms)) if now > prev_ms => {
            let dt_s = (now - prev_ms) as f64 / 1000.0;
            ((jiffies - prev_j) as f64 / CLOCK_TICKS / dt_s) * 100.0
        }
        _ => 0.0,
    };
    *last = Some((jiffies, now));
    serde_json::json!({
        "pid": pgid,
        "cpuPercent": (cpu_percent * 10.0).round() / 10.0,
        "cpuSeconds": (jiffies as f64 / CLOCK_TICKS).round() as u64,
        "rssMb": (rss_kb as f64 / 1024.0 * 10.0).round() / 10.0,
    })
}

/// authToken 脱敏占位值（GET 返回、PUT 保存时还原为真实值）
const TOKEN_REDACTED: &str = "***";

/// 配置文件路径（DYNAPM_CONFIG 或默认）
fn config_path() -> String {
    std::env::var("DYNAPM_CONFIG").unwrap_or_else(|_| "dynapm.config.json".to_string())
}

/// GET /_dynapm/api/config：返回配置文件 JSON（adminApi.authToken 脱敏）
pub async fn get_config(
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    axum::Extension(gw): axum::Extension<Arc<Gateway>>,
) -> axum::response::Response {
    if let Some(resp) = auth_check(&uri, &headers, &gw) {
        return resp;
    }
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(config_path()).unwrap_or_default()) else {
        return json_response(axum::http::StatusCode::INTERNAL_SERVER_ERROR, &serde_json::json!({ "error": "读取配置文件失败" }));
    };
    if v.get("adminApi").and_then(|a| a.get("authToken")).is_some() {
        v["adminApi"]["authToken"] = serde_json::json!(TOKEN_REDACTED);
    }
    // 附带文件 mtime：面板用它检测外部修改，避免保存时覆盖磁盘上的新变更
    let mtime = std::fs::metadata(config_path())
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if let Some(obj) = v.as_object_mut() {
        obj.insert("_mtime".into(), serde_json::json!(mtime));
    }
    json_response(axum::http::StatusCode::OK, &v)
}

/// PUT /_dynapm/api/config：校验并写回配置文件，然后网关自重启（systemd 拉起）
/// body：完整配置 JSON（authToken 为脱敏占位时回填原值）
pub async fn put_config(
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    axum::Extension(gw): axum::Extension<Arc<Gateway>>,
    body: String,
) -> axum::response::Response {
    if let Some(resp) = auth_check(&uri, &headers, &gw) {
        return resp;
    }
    // 解析 + 脱敏还原
    let mut v: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return json_response(axum::http::StatusCode::BAD_REQUEST, &serde_json::json!({ "error": format!("JSON 解析失败: {e}") })),
    };
    if v.get("adminApi").and_then(|a| a.get("authToken")) == Some(&serde_json::json!(TOKEN_REDACTED)) {
        match gw.admin_auth_token() {
            Some(t) => v["adminApi"]["authToken"] = serde_json::json!(t),
            None => {
                let mut a = v["adminApi"].as_object().cloned().unwrap_or_default();
                a.remove("authToken");
                v["adminApi"] = serde_json::Value::Object(a);
            }
        }
    }
    // 外部修改检测：body 携带加载时的 _mtime，与磁盘不一致返回 409（客户端可重新拉取合并）
    let loaded_mtime = v.get("_mtime").and_then(|m| m.as_u64()).unwrap_or(0);
    if let Some(obj) = v.as_object_mut() {
        obj.remove("_mtime");
    }
    let disk_mtime = std::fs::metadata(config_path())
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if loaded_mtime > 0 && disk_mtime > 0 && loaded_mtime != disk_mtime {
        return json_response(
            axum::http::StatusCode::CONFLICT,
            &serde_json::json!({ "error": "配置文件已被外部修改（mtime 不一致），请重新加载后再保存", "mtime": disk_mtime }),
        );
    }
    let content = serde_json::to_string_pretty(&v).unwrap_or_default();
    // 语义校验：必须能通过 loader 规范化，防止写入坏配置导致重启失败循环
    if let Err(e) = crate::config::load_config_from_str(&content) {
        return json_response(axum::http::StatusCode::BAD_REQUEST, &serde_json::json!({ "error": format!("配置校验失败: {e}") }));
    }
    // 原子写回：tmp + rename（文件 IO 放阻塞线程池）
    let path = config_path();
    let tmp = format!("{path}.tmp");
    let write_result = tokio::task::spawn_blocking(move || {
        std::fs::write(&tmp, &content).and_then(|_| std::fs::rename(&tmp, &path))
    })
    .await
    .unwrap_or_else(|e| Err(std::io::Error::other(e.to_string())));
    if let Err(e) = write_result {
        return json_response(axum::http::StatusCode::INTERNAL_SERVER_ERROR, &serde_json::json!({ "error": format!("写入配置失败: {e}") }));
    }
    // 延迟自重启：等响应先发出去（systemd Restart 拉起新进程加载新配置）
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        logger::info("📝 配置已更新，网关自重启加载新配置...");
        let under_systemd = std::path::Path::new("/run/systemd/system").exists();
        if under_systemd {
            // fork+exec 放阻塞线程池，避免在 async 上下文直接 fork
            let _ = tokio::task::spawn_blocking(|| {
                std::process::Command::new("systemctl").arg("restart").arg("dynapm").spawn()
            })
            .await;
        } else {
            std::process::exit(0);
        }
    });
    json_response(axum::http::StatusCode::OK, &serde_json::json!({ "ok": true, "restarting": true }))
}

/// GET /_dynapm/api/stats：各服务历史统计（分钟请求桶 + 存活区间 + 进程资源），供面板图表
pub async fn stats(
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    axum::Extension(gw): axum::Extension<Arc<Gateway>>,
) -> axum::response::Response {
    if let Some(resp) = auth_check(&uri, &headers, &gw) {
        return resp;
    }
    let mut services = Vec::new();
    // 请求桶只返回最近 8 天（面板热力图 7 天 + 余量），减小响应体
    let since_min = crate::state::now_ms() / 60_000 - 8 * 24 * 60;
    for rt in gw.all_runtimes() {
        let (req_buckets, alive_spans) = match &rt.stats {
            Some(st) => (
                st.buckets_since(since_min),
                st.alive_spans(),
            ),
            None => (Vec::new(), Vec::new()),
        };
        // /proc 扫描是同步文件 IO（数百次 open+read），必须放阻塞线程池，
        // 面板轮询期间跑在 worker 上会钉死线程
        let proc = {
            let rt2 = Arc::clone(&rt);
            tokio::task::spawn_blocking(move || proc_metrics(&rt2))
                .await
                .unwrap_or(serde_json::Value::Null)
        };
        services.push(serde_json::json!({
            "name": rt.config.name,
            "reqBuckets": req_buckets.iter().map(|(m, c)| [*m, *c as u64]).collect::<Vec<[u64; 2]>>(),
            "aliveSpans": alive_spans.iter().map(|(s, e)| [*s as i64, (*e as i64).min(i64::MAX)]).collect::<Vec<_>>(),
            "proc": proc,
        }));
    }
    json_response(axum::http::StatusCode::OK, &serde_json::json!({ "services": services }))
}

/// GET /_dynapm/api/services/:name
pub async fn service_detail(
    Path(name): Path<String>,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    axum::Extension(gw): axum::Extension<Arc<Gateway>>,
) -> axum::response::Response {
    if let Some(resp) = auth_check(&uri, &headers, &gw) {
        return resp;
    }
    let rt = match gw.runtime(&name) {
        Some(r) => r,
        None => {
            logger::info(&format!("🔍 [Admin API] 查找服务: {name}, 找到: null"));
            return json_response(
                axum::http::StatusCode::NOT_FOUND,
                &serde_json::json!({ "error": "Service not found" }),
            );
        }
    };
    let detail = serde_json::json!({
        "name": rt.config.name,
        "base": rt.config.base,
        "status": rt.status().as_str(),
        "uptime": rt.session_uptime_ms(),
        "lastAccessTime": rt.last_access_ms.load(Ordering::Relaxed),
        "activeConnections": rt.active_connections.load(Ordering::Relaxed),
        "idleTimeout": rt.config.idle_timeout,
        "startTimeout": rt.config.start_timeout,
        "proxyOnly": rt.config.proxy_only,
        "netns": rt.config.netns,
        "keepWarm": rt.config.keep_warm,
        "pid": *rt.pid.lock().unwrap(),
        "healthCheck": { "type": health_check_type_name(&rt.config.health_check) },
        "startCommand": rt.config.commands.start,
        "stopCommand": rt.config.commands.stop.as_deref().unwrap_or(""),
        "startCount": rt.start_count.load(Ordering::Relaxed),
        "totalUptime": rt.uptime_ms(),
        "paused": rt.paused.load(Ordering::Relaxed),
        "requestCount": rt.request_count.load(Ordering::Relaxed),
        "totalRequestMs": rt.total_request_ms.load(Ordering::Relaxed),
        "lastStartError": rt.last_start_error.lock().unwrap().clone(),
    });
    json_response(axum::http::StatusCode::OK, &detail)
}

/// POST /_dynapm/api/services/:name/stop
pub async fn stop_service(
    Path(name): Path<String>,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    axum::Extension(gw): axum::Extension<Arc<Gateway>>,
) -> axum::response::Response {
    if let Some(resp) = auth_check(&uri, &headers, &gw) {
        return resp;
    }
    let rt = match gw.runtime(&name) {
        Some(r) => r,
        None => {
            return json_response(
                axum::http::StatusCode::NOT_FOUND,
                &serde_json::json!({ "error": "Service not found" }),
            );
        }
    };
    match gw.stop_service(rt).await {
        Ok(()) => json_response(axum::http::StatusCode::OK, &serde_json::json!({ "success": true })),
        Err(e) => json_response(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            &serde_json::json!({ "error": e }),
        ),
    }
}

/// POST /_dynapm/api/services/:name/start
pub async fn start_service(
    Path(name): Path<String>,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    axum::Extension(gw): axum::Extension<Arc<Gateway>>,
) -> axum::response::Response {
    if let Some(resp) = auth_check(&uri, &headers, &gw) {
        return resp;
    }
    let rt = match gw.runtime(&name) {
        Some(r) => r,
        None => {
            return json_response(
                axum::http::StatusCode::NOT_FOUND,
                &serde_json::json!({ "error": "Service not found" }),
            );
        }
    };
    // 彻底关停状态下拒绝手动启动，需先 enable
    if rt.paused.load(Ordering::Relaxed) {
        return json_response(
            axum::http::StatusCode::CONFLICT,
            &serde_json::json!({ "error": "Service is disabled; enable it first" }),
        );
    }
    match gw.start_by_name(&rt).await {
        Ok(()) => json_response(axum::http::StatusCode::OK, &serde_json::json!({ "success": true })),
        Err(e) => json_response(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            &serde_json::json!({ "error": e }),
        ),
    }
}

/// POST /_dynapm/api/services/:name/disable — 彻底关停：停止进程 + 禁止按需/手动拉起
pub async fn disable_service(
    Path(name): Path<String>,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    axum::Extension(gw): axum::Extension<Arc<Gateway>>,
) -> axum::response::Response {
    if let Some(resp) = auth_check(&uri, &headers, &gw) {
        return resp;
    }
    let rt = match gw.runtime(&name) {
        Some(r) => r,
        None => {
            return json_response(
                axum::http::StatusCode::NOT_FOUND,
                &serde_json::json!({ "error": "Service not found" }),
            );
        }
    };
    rt.paused.store(true, Ordering::Relaxed);
    match gw.stop_service(rt).await {
        Ok(()) => {
            logger::info(&format!("🛑 [{}] 已彻底关停（禁止按需拉起）", name));
            json_response(axum::http::StatusCode::OK, &serde_json::json!({ "success": true, "paused": true }))
        }
        Err(e) => json_response(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            &serde_json::json!({ "error": e }),
        ),
    }
}

/// POST /_dynapm/api/services/:name/enable — 解除彻底关停（恢复可按需拉起，不立即启动）
pub async fn enable_service(
    Path(name): Path<String>,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    axum::Extension(gw): axum::Extension<Arc<Gateway>>,
) -> axum::response::Response {
    if let Some(resp) = auth_check(&uri, &headers, &gw) {
        return resp;
    }
    let rt = match gw.runtime(&name) {
        Some(r) => r,
        None => {
            return json_response(
                axum::http::StatusCode::NOT_FOUND,
                &serde_json::json!({ "error": "Service not found" }),
            );
        }
    };
    rt.paused.store(false, Ordering::Relaxed);
    logger::info(&format!("✅ [{}] 已解除彻底关停", name));
    json_response(axum::http::StatusCode::OK, &serde_json::json!({ "success": true, "paused": false }))
}

/// GET /_dynapm/api/events — SSE 事件流
pub async fn events(
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    axum::Extension(gw): axum::Extension<Arc<Gateway>>,
) -> axum::response::Response {
    if let Some(resp) = auth_check(&uri, &headers, &gw) {
        return resp;
    }
    let rx = gw.subscribe_events();
    let stream = tokio_stream_wrapped(rx);
    let body = Body::from_stream(stream);
    axum::response::Response::builder()
        .status(axum::http::StatusCode::OK)
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .header("Connection", "keep-alive")
        .body(body)
        .unwrap()
}

/// broadcast -> SSE 流适配
fn tokio_stream_wrapped(
    rx: tokio::sync::broadcast::Receiver<String>,
) -> impl Stream<Item = Result<bytes::Bytes, std::io::Error>> {
    futures_util::stream::unfold(rx, move |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    return Some((Ok(bytes::Bytes::from(format!("data: {event}\n\n"))), rx));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    return None;
                }
            }
        }
    })
}

/// JSON 响应
fn json_response(status: axum::http::StatusCode, value: &serde_json::Value) -> axum::response::Response {
    axum::response::Response::builder()
        .status(status)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}

/// 让 axum 的 IntoResponse 推断不报错（占位保持 trait 一致性）
#[allow(dead_code)]
fn _assert_into_response<T: IntoResponse>(_: T) {}

/// Status::Offline 保留引用（对齐 admin 详情未来字段）
#[allow(dead_code)]
fn _status_ref() -> Status {
    Status::Offline
}
