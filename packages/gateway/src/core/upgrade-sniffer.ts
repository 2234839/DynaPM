/**
 * 从 TCP 字节流中增量解析出首个 HTTP 请求头
 * 支持分片到达（头未完整时持续缓冲），解析出是否为 WebSocket upgrade、
 * Host 头，以及完整原始头字节（含 CRLF 结尾），供原样转发使用（不丢已缓冲字节）。
 *
 * 只解析这一个请求头，之后调用方应永远透传。
 */
export class HttpUpgradeSniffer {
  /** 头结束分隔符（标准 CRLF CRLF） */
  private static readonly HEADER_END = '\r\n\r\n';
  /** 容错分隔符（裸 LF LF） */
  private static readonly HEADER_END_LF = '\n\n';
  /** 头部缓冲上限（64KB），超限判定为非法请求不再等待 */
  private static readonly MAX_HEADER_SIZE = 64 * 1024;

  /** 内部缓冲：尚未解析出头结束符的字节 */
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  /** 是否已完成解析（无论成败） */
  parsed = false;
  /** 解析结果；parsed 为 true 之前为 null */
  result: SniffResult | null = null;

  /**
   * 喂入一个数据分片
   * @param chunk - 从 TCP 流读到的字节
   * @returns 头结束之后剩余的字节（body/后续协议数据），头未完整时返回空 Buffer；
   *          剩余字节必须由调用方随原始头一起转发，不能丢弃
   */
  feed(chunk: Buffer): Buffer {
    if (this.parsed) {
      /** 已解析完成：调用方不应再 feed，剩余数据原样返回 */
      return chunk;
    }

    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);


    /** 查找头结束符（优先 CRLFCRLF，容错 LFLF） */
    let endIndex = this.buffer.indexOf(HttpUpgradeSniffer.HEADER_END, 0, 'utf8');
    let endLength = 4;
    if (endIndex === -1) {
      endIndex = this.buffer.indexOf(HttpUpgradeSniffer.HEADER_END_LF, 0, 'utf8');
      endLength = 2;
    }

    if (endIndex === -1) {
      /** 头未完整：超过缓冲上限则放弃等待，判定为非 upgrade（防内存无限增长） */
      if (this.buffer.length > HttpUpgradeSniffer.MAX_HEADER_SIZE) {
        this.parsed = true;
        this.result = { isUpgrade: false, host: null, headerBytes: this.buffer };
      }
      return Buffer.alloc(0);
    }

    this.parsed = true;
    const headerEnd = endIndex + endLength;
    const headerBytes = this.buffer.subarray(0, headerEnd);
    const rest = this.buffer.subarray(headerEnd);
    this.buffer = Buffer.alloc(0);

    const headerText = headerBytes.toString('utf8');
    /** 多行匹配 Upgrade: websocket 头行（值允许大小写混合、尾随空白） */
    const isUpgrade = /^upgrade:[ \t]*websocket[ \t]*\r?$/im.test(headerText);
    const hostMatch = headerText.match(/(^|\r?\n)host:[ \t]*([^\r\n]+)/i);

    this.result = {
      isUpgrade,
      host: hostMatch ? hostMatch[2].trim() : null,
      headerBytes,
    };
    return rest;
  }
}

/** 首个 HTTP 请求头嗅探结果 */
export interface SniffResult {
  /** 是否为 WebSocket upgrade 请求（Upgrade: websocket 头存在） */
  isUpgrade: boolean;
  /** Host 头值（含端口，原样）；无 Host 时为 null */
  host: string | null;
  /** 完整原始头字节（含结尾 CRLF），转发时必须原样置于数据流最前 */
  headerBytes: Buffer;
}
