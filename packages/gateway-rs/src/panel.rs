//! 管理面板静态托管：把 admin-ui 构建产物嵌入二进制，`/_dynapm/panel` 直接访问
//!
//! UI 产物位于 packages/admin-ui/dist（构建顺序：先 `pnpm build` admin-ui 再编译网关）

use axum::body::Body;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use include_dir::{include_dir, Dir};

/// 嵌入的 admin-ui 构建产物
static PANEL_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../admin-ui/dist");

/// 扩展名 -> Content-Type
fn mime_by_ext(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("map") => "application/json",
        _ => "application/octet-stream",
    }
}

/// GET /_dynapm/panel 与 /_dynapm/panel/*：返回嵌入的静态文件，目录路径回退 index.html
/// 无尾斜杠访问（/_dynapm/panel）301 到带斜杠版本，保证相对资源路径正确解析
pub async fn panel(uri: axum::extract::OriginalUri) -> axum::response::Response {
    let path = uri.0.path();
    if path == "/_dynapm/panel" {
        return axum::response::Redirect::permanent("/_dynapm/panel/").into_response();
    }
    serve_rel(path.trim_start_matches("/_dynapm/panel"))
}

/// 专属管理域名根路径托管：/ 与 /* 均直接返回面板
pub fn serve_root(path: &str) -> axum::response::Response {
    serve_rel(path)
}

/** 按剥离挂载前缀后的相对路径返回静态文件，目录/SPA 路径回退 index.html */
fn serve_rel(raw: &str) -> axum::response::Response {
    let rel = if raw.is_empty() || raw == "/" { "index.html" } else { raw.trim_start_matches('/') };
    // SPA 路由兜底：无扩展名的路径回退 index.html
    let file = PANEL_DIST
        .get_file(rel)
        .or_else(|| (!rel.contains('.')).then_some(PANEL_DIST.get_file("index.html")).flatten())
        .or_else(|| PANEL_DIST.get_file("index.html"));
    match file {
        Some(f) => axum::response::Response::builder()
            .status(StatusCode::OK)
            .header(axum::http::header::CONTENT_TYPE, mime_by_ext(f.path().to_str().unwrap_or("")))
            .body(Body::from(f.contents()))
            .unwrap(),
        None => axum::response::Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("Panel not found"))
            .unwrap(),
    }
}
