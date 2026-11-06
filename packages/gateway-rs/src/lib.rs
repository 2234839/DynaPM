//! lib 入口：供 examples / 集成测试复用 crate 内模块

pub mod admin;
pub mod config;
pub mod executor;
pub mod gateway;
pub mod health;
pub mod logger;
pub mod netns;
pub mod procreg;
pub mod state;
pub mod stats;

/** 本进程启动时刻（unix 毫秒） */
pub fn process_start_ms() -> u64 {
    process_start_ms_of(std::process::id())
}

/** 指定进程的启动时刻（unix 毫秒）：/proc/<pid>/stat 第 22 列 starttime（时钟滴答）换算。
 *  CLI 据此判断"二进制比运行中的网关进程新"（mtime 比对对同文件双角色无效） */
pub fn process_start_ms_of(pid: u32) -> u64 {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return 0;
    };
    if let Some(close) = stat.rfind(')') {
        // close+1 起从 state（第 3 列）算，starttime 是第 22 列 → 索引 19
        if let Some(ticks) = stat[close + 1..]
            .split_whitespace()
            .nth(19)
            .and_then(|s| s.parse::<u64>().ok())
        {
            let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as u64;
            if hz > 0 {
                if let Ok(uptime) = std::fs::read_to_string("/proc/uptime") {
                    let up_ms: u64 = uptime
                        .split_whitespace()
                        .next()
                        .and_then(|s| s.parse::<f64>().ok())
                        .map(|s| (s * 1000.0) as u64)
                        .unwrap_or(0);
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    return now_ms.saturating_sub(up_ms).saturating_add(ticks * 1000 / hz);
                }
            }
        }
    }
    0
}
