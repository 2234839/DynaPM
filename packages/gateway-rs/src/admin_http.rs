//! admin API 横切中间件：鉴权与 gzip 压缩响应
//!
//! handler 只保留业务逻辑，认证与传输压缩统一在此下沉，
//! 消除每个 handler 重复的 uri/headers 提取 + auth_check 早退样板

use crate::gateway::Gateway;
use axum::body::Body;
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

/// 鉴权中间件：挂载于 /_dynapm/api 路由层，token 不匹配直接 401（面板静态资源不走此层，登录门禁在页面侧）
pub async fn auth(
    req: axum::http::Request<Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let gw = req
        .extensions()
        .get::<Arc<Gateway>>()
        .cloned()
        .expect("gateway extension 必存在");
    if !is_authorized(req.uri(), req.headers(), gw.admin_auth_token().as_ref()) {
        return axum::response::Response::builder()
            .status(axum::http::StatusCode::UNAUTHORIZED)
            .header("WWW-Authenticate", "Bearer")
            .body(Body::from("Unauthorized"))
            .unwrap();
    }
    next.run(req).await
}

/// 低于此体积不压缩（收益不抵 CPU 与头部开销）
const GZIP_MIN_BYTES: usize = 1024;
/// 压缩读取上限：admin API 最大响应（万级服务列表 gzip 后仍远小于此）
const GZIP_MAX_BYTES: usize = 64 * 1024 * 1024;

/// gzip 压缩中间件：JSON 响应超过阈值且客户端声明接受 gzip 时压缩传输。
/// 万级服务的列表/统计 JSON 压缩比约 10:1，显著降低面板轮询的带宽与解析开销。
/// SSE 流式响应（text/event-stream）与非 JSON 响应原样透传
pub async fn gzip(
    req: axum::http::Request<Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let accepts_gzip = req
        .headers()
        .get(axum::http::header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase().contains("gzip"))
        .unwrap_or(false);
    let resp = next.run(req).await;
    if !accepts_gzip {
        return resp;
    }
    let is_json = resp
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.starts_with("application/json"))
        .unwrap_or(false);
    if !is_json {
        return resp;
    }
    let (parts, body) = resp.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, GZIP_MAX_BYTES).await else {
        return axum::response::Response::from_parts(parts, Body::empty());
    };
    if bytes.len() < GZIP_MIN_BYTES {
        return axum::response::Response::from_parts(parts, Body::from(bytes));
    }
    let mut encoder = flate2::write::GzEncoder::new(Vec::with_capacity(bytes.len() / 8), flate2::Compression::fast());
    std::io::Write::write_all(&mut encoder, &bytes).expect("gzip 编码不失败");
    let compressed = encoder.finish().expect("gzip flush 不失败");
    let mut parts = parts;
    parts.headers.insert(axum::http::header::CONTENT_ENCODING, "gzip".parse().unwrap());
    parts.headers.insert("Vary", "Accept-Encoding".parse().unwrap());
    axum::response::Response::from_parts(parts, Body::from(compressed))
}
