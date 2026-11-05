//! 健康检查器（tcp / http / command，与 Bun 版 health-checker.ts 语义对齐）

use crate::config::{HealthCheckConfig, HealthCheckType, ServiceConfig};
use crate::executor::{self, CommandOptions};
use std::time::Duration;
use tokio::net::TcpStream;

/// TCP 探测超时（毫秒），与 Bun 版一致快速失败
const TCP_CHECK_TIMEOUT_MS: u64 = 100;

/// 快速检查 TCP 端口是否可用
pub async fn check_tcp_port(host: &str, port: u16) -> bool {
    let addr = format!("{host}:{port}");
    match tokio::time::timeout(
        Duration::from_millis(TCP_CHECK_TIMEOUT_MS),
        TcpStream::connect(&addr),
    )
    .await
    {
        Ok(Ok(_)) => true,
        _ => false,
    }
}

/// 对指定目标执行单次健康检查（默认 tcp 分支与网关裸 TCP 轮询一致）
pub async fn check_target(
    service: &ServiceConfig,
    target_host: &str,
    target_port: u16,
) -> bool {
    // netns 模式：后端端口在 namespace 内，宿主机不可见，走 UDS HTTP 探活
    if service.netns {
        return crate::netns::check_uds_http(&crate::netns::sock_path(&service.name)).await;
    }
    match &service.health_check {
        None => check_tcp_port(target_host, target_port).await,
        Some(hc) => {
            let t = hc.check_type.clone().unwrap_or_default();
            match t {
                HealthCheckType::Tcp | HealthCheckType::None => {
                    check_tcp_port(target_host, target_port).await
                }
                HealthCheckType::Http => check_http(hc, service).await,
                HealthCheckType::Command => match &hc.command {
                    Some(cmd) => {
                        let opts = CommandOptions {
                            timeout_ms: Some(hc.timeout.unwrap_or(5000)),
                            ..Default::default()
                        };
                        executor::check(cmd, &opts).await
                    }
                    None => false,
                },
            }
        }
    }
}

/// HTTP 健康检查
async fn check_http(config: &HealthCheckConfig, service: &ServiceConfig) -> bool {
    let url = config
        .url
        .clone()
        .unwrap_or_else(|| service.base.clone());
    let expected = config.expected_status.unwrap_or(200);
    let timeout = Duration::from_millis(config.timeout.unwrap_or(5000));

    let client = match reqwest::Client::builder()
        .timeout(timeout)
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get(&url).send().await {
        Ok(resp) => resp.status().as_u16() == expected,
        Err(_) => false,
    }
}

/// 从服务配置解析目标端口（base 为 http(s) URL 时可解析），供 isRunning 的 TCP 探测短路
pub fn resolve_service_port(service: &ServiceConfig) -> Option<u16> {
    let (host, port, _) = crate::config::parse_base_url(&service.base).ok()?;
    if host == "127.0.0.1" || host == "localhost" {
        Some(port)
    } else {
        Some(port)
    }
}
