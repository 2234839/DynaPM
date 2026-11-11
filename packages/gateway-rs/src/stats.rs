//! 服务统计持久化：mmap 固定布局文件，原地槽写（无全量重写）
//!
//! 每服务一个文件（约 177KB），布局：
//! - header: magic / base_minute / span_head / span_len / last_minute
//! - 存活区间环形数组 512 段 (start_ms, end_ms)
//! - 30 天分钟级请求桶 43200 个 u32
//!
//! 写入均为对齐的 4/8 字节槽写（x86_64 原子），掉电最坏丢单桶；
//! MAP_SHARED 脏页由内核按页回写，无应用层全量写。

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

/** 分钟桶数：30 天 */
const BUCKETS: usize = 30 * 24 * 60;
/** 存活区间容量 */
const SPANS: usize = 512;
/** 文件总大小 */
const FILE_SIZE: usize = 32 + SPANS * 16 + BUCKETS * 4;
/** header 布局偏移 */
const OFF_BASE_MIN: usize = 8;
const OFF_SPAN_HEAD: usize = 16;
const OFF_SPAN_LEN: usize = 20;
const OFF_LAST_MIN: usize = 24;
const OFF_SPANS: usize = 32;
const OFF_COUNTS: usize = OFF_SPANS + SPANS * 16;
/** magic "DPMS" */
const MAGIC: u32 = 0x534D_5044;
/** 进行中区间的 end 哨兵值 */
const SPAN_OPEN: u64 = u64::MAX;

/** 统计数据目录（None = 持久化禁用）；由 main 在配置加载后注入 */
static STATS_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/** 注入统计目录（仅 main 启动时调用一次） */
pub fn init_dir(dir: Option<PathBuf>) {
    let _ = STATS_DIR.set(dir);
}

/** 当前 unix 毫秒（唯一实现在 state，禁止各模块重写） */
#[allow(unused_imports)]
use crate::state::now_ms;

/** mmap 持久化统计文件（Drop 时 munmap，停止的服务不占驻留内存） */
pub struct StatsFile {
    ptr: *mut u8,
}

// mmap 指针跨线程共享；写入均为原子槽写，无数据竞争
unsafe impl Send for StatsFile {}
unsafe impl Sync for StatsFile {}

impl Drop for StatsFile {
    fn drop(&mut self) {
        unsafe {
            libc::munmap(self.ptr.cast(), FILE_SIZE);
        }
    }
}

impl StatsFile {
    /// 打开（不存在则创建初始化）统计文件；失败返回 None（统计降级为不可用）
    pub fn open(path: &std::path::Path) -> Option<Self> {
        if !path.exists() || fs::metadata(path).ok()?.len() != FILE_SIZE as u64 {
            // 新建/损坏重建：一次性写零文件（初始化路径，非数据更新）
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).ok()?;
            }
            fs::write(path, vec![0u8; FILE_SIZE]).ok()?;
        }
        let file = fs::OpenOptions::new().read(true).write(true).open(path).ok()?;
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                FILE_SIZE,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                file.as_raw_fd(),
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            return None;
        }
        let sf = Self { ptr: ptr as *mut u8 };
        if sf.rd_u32(0) != MAGIC {
            // 旧格式/未初始化：清零数据区 + 写 header（一次性初始化）
            unsafe {
                std::ptr::write_bytes(sf.ptr.add(OFF_SPANS), 0, FILE_SIZE - OFF_SPANS);
            }
            sf.wr_u32(0, MAGIC);
            sf.wr_u64(OFF_BASE_MIN, 0);
            sf.wr_u32(OFF_SPAN_HEAD, 0);
            sf.wr_u32(OFF_SPAN_LEN, 0);
            sf.wr_u64(OFF_LAST_MIN, 0);
        }
        // base 未对齐 BUCKETS 边界的是旧版错位数据（读取分钟值会整体偏移），
        // 直接作废重建：清零数据区，下次写入会重新初始化对齐的 base
        if sf.rd_u64(OFF_BASE_MIN) % BUCKETS as u64 != 0 {
            unsafe {
                std::ptr::write_bytes(sf.ptr.add(OFF_SPANS), 0, FILE_SIZE - OFF_SPANS);
            }
            sf.wr_u32(0, MAGIC);
            sf.wr_u64(OFF_BASE_MIN, 0);
            sf.wr_u32(OFF_SPAN_HEAD, 0);
            sf.wr_u32(OFF_SPAN_LEN, 0);
            sf.wr_u64(OFF_LAST_MIN, 0);
        }
        // 崩溃恢复：上次网关进程死亡时来不及写 offline，最后一个存活段
        // 会永远停在 SPAN_OPEN——既导致读取侧把已死服务当"进行中"，
        // 又让 record_status 的幂等检查跳过新会话的开段。这里闭合到当前时刻
        let head = sf.rd_u32(OFF_SPAN_HEAD) as usize;
        let len = sf.rd_u32(OFF_SPAN_LEN) as usize;
        if len > 0 {
            let last = (head + SPANS - 1) % SPANS;
            let slot = OFF_SPANS + last * 16 + 8;
            if sf.rd_u64(slot) == SPAN_OPEN {
                sf.wr_u64(slot, now_ms());
            }
        }
        Some(sf)
    }

    fn rd_u32(&self, off: usize) -> u32 {
        unsafe { (self.ptr.add(off) as *const u32).read_unaligned() }
    }
    fn rd_u64(&self, off: usize) -> u64 {
        unsafe { (self.ptr.add(off) as *const u64).read_unaligned() }
    }
    fn wr_u32(&self, off: usize, v: u32) {
        unsafe { (self.ptr.add(off) as *mut u32).write_unaligned(v) }
    }
    fn wr_u64(&self, off: usize, v: u64) {
        unsafe { (self.ptr.add(off) as *mut u64).write_unaligned(v) }
    }

    /** 清 (from, to] 分钟区间的桶（原地槽写） */
    fn clear_range(&self, from: u64, to: u64) {
        let span = BUCKETS as u64;
        if to.saturating_sub(from) >= span {
            unsafe { std::ptr::write_bytes(self.ptr.add(OFF_COUNTS), 0, BUCKETS * 4) };
            return;
        }
        for m in (from + 1)..=to {
            unsafe { std::ptr::write_volatile(self.ptr.add(OFF_COUNTS + ((m % span) as usize) * 4) as *mut u32, 0) };
        }
    }

    /// 记录一次请求到当前分钟桶
    pub fn record_request(&self) {
        let min = now_ms() / 60_000;
        let last = self.rd_u64(OFF_LAST_MIN);
        let base = self.rd_u64(OFF_BASE_MIN);
        if last == 0 || base == 0 {
            // 首次写入（新文件或进程重启后第一次）
            if last > 0 {
                self.clear_range(0, u64::MAX); // base==0 但有 last：异常态，重建
            }
            // base 必须对齐到 BUCKETS 边界：写入槽位是 min%BUCKETS，
            // 读取侧按 base+i 反推分钟，两者仅在对齐时一致
            self.wr_u64(OFF_BASE_MIN, min - (min % BUCKETS as u64));
        } else if min > last {
            // 跨分钟：清掉区间内旧周期残留桶
            self.clear_range(last, min);
            if min >= base + BUCKETS as u64 {
                self.wr_u64(OFF_BASE_MIN, min - (min % BUCKETS as u64));
            }
        } else if min < last {
            return; // 时钟回拨，丢弃
        }
        self.wr_u64(OFF_LAST_MIN, min);
        let idx = OFF_COUNTS + ((min % BUCKETS as u64) as usize) * 4;
        unsafe {
            let slot = self.ptr.add(idx) as *mut u32;
            let v = slot.read_volatile();
            slot.write_volatile(v.saturating_add(1));
        }
    }

    /// 记录状态变化：online 开新段（幂等），offline 关闭进行段
    pub fn record_status(&self, online: bool) {        let now = now_ms();
        let head = self.rd_u32(OFF_SPAN_HEAD) as usize;
        let len = self.rd_u32(OFF_SPAN_LEN) as usize;
        if online {
            let last = (head + SPANS - 1) % SPANS;
            if len > 0 && self.rd_u64(OFF_SPANS + last * 16 + 8) == SPAN_OPEN {
                return; // 已有进行段，幂等
            }
            let slot = OFF_SPANS + head * 16;
            self.wr_u64(slot, now);
            self.wr_u64(slot + 8, SPAN_OPEN);
            self.wr_u32(OFF_SPAN_HEAD, ((head + 1) % SPANS) as u32);
            self.wr_u32(OFF_SPAN_LEN, len.saturating_add(1).min(SPANS) as u32);
        } else if len > 0 {
            let last = (head + SPANS - 1) % SPANS;
            let slot = OFF_SPANS + last * 16 + 8;
            if self.rd_u64(slot) == SPAN_OPEN {
                self.wr_u64(slot, now);
            }
        }
    }

    /// 读取最近 since_minute 分钟内的请求桶（升序，跳过空桶）
    pub fn buckets_since(&self, since_minute: u64) -> Vec<(u64, u32)> {
        let base = self.rd_u64(OFF_BASE_MIN);
        if base == 0 {
            return Vec::new();
        }
        let start = since_minute.saturating_sub(base) as usize;
        // 扫描上界用 last_minute 夹紧：环形数组在当前分钟之后是空洞，
        // 万级服务逐个全环扫描是每次轮询上亿次 volatile 读的纯 CPU 热点
        let last = self.rd_u64(OFF_LAST_MIN);
        let end = (last.saturating_sub(base) as usize + 1).min(BUCKETS);
        let start = start.min(end);
        let mut out = Vec::new();
        for i in start..end {
            let c = self.rd_u32(OFF_COUNTS + i * 4);
            if c > 0 {
                out.push((base + i as u64, c));
            }
        }
        out
    }

    /// 读取全部存活区间（时间升序，(start_ms, end_ms)，end 为 u64::MAX 表示进行中）
    pub fn alive_spans(&self) -> Vec<(u64, u64)> {
        let head = self.rd_u32(OFF_SPAN_HEAD) as usize;
        let len = self.rd_u32(OFF_SPAN_LEN) as usize;
        let mut out = Vec::with_capacity(len);
        for i in 0..len {
            let idx = (head + SPANS - len + i) % SPANS;
            let slot = OFF_SPANS + idx * 16;
            out.push((self.rd_u64(slot), self.rd_u64(slot + 8)));
        }
        out
    }

    /// 窗口 [from, to]（分钟）内是否有任何数据（请求桶非零或有存活段）。
    /// 供 stats 接口过滤零数据服务：万级实例下长尾服务连序列化都不该发生
    pub fn has_data_in_window(&self, from_minute: u64, to_minute: u64) -> bool {
        let base = self.rd_u64(OFF_BASE_MIN);
        if base != 0 {
            let start = from_minute.saturating_sub(base) as usize;
            let last = self.rd_u64(OFF_LAST_MIN);
            let end = (last.saturating_sub(base) as usize + 1).min(BUCKETS);
            let end = end.min((to_minute.saturating_sub(base) as usize + 1).max(start));
            for i in start..end {
                if self.rd_u32(OFF_COUNTS + i * 4) > 0 {
                    return true;
                }
            }
        }
        // 存活段与窗口求交（SPAN_OPEN 视为延伸到现在）
        let now = now_ms();
        let from_ms = from_minute * 60_000;
        let to_ms = to_minute * 60_000;
        let head = self.rd_u32(OFF_SPAN_HEAD) as usize;
        let len = self.rd_u32(OFF_SPAN_LEN) as usize;
        for i in 0..len {
            let idx = (head + SPANS - len + i) % SPANS;
            let s = self.rd_u64(OFF_SPANS + idx * 16);
            let e_raw = self.rd_u64(OFF_SPANS + idx * 16 + 8);
            let e = if e_raw == SPAN_OPEN { now } else { e_raw };
            if e >= from_ms && s <= to_ms {
                return true;
            }
        }
        false
    }
}

use std::os::unix::io::AsRawFd;

/** 按服务名构造安全的统计文件名 */
pub fn stats_file_for(dir: &std::path::Path, name: &str) -> PathBuf {
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' })
        .collect();
    dir.join(format!("{safe}.bin"))
}

/** 该服务的统计文件是否已存在（从未写入过则不存在）。
 *  读取侧先查这个再懒打开：避免面板轮询把万级从未访问服务的文件 mmap 出来（甚至凭空创建文件） */
pub fn exists_for(name: &str) -> bool {
    match STATS_DIR.get().and_then(|d| d.as_ref()) {
        Some(dir) => stats_file_for(dir, name).exists(),
        None => false,
    }
}

/** 打开（或降级返回 None）某服务的持久化统计 */
pub fn open_for(name: &str) -> Option<StatsFile> {
    let dir = STATS_DIR.get()?;
    let dir = dir.as_ref()?;
    StatsFile::open(&stats_file_for(dir, name))
}
