// 全局暂存：SSE 流式写入器 + taskId + 最新全文（重连快照用）
// 注意：本文件保持"全局脚本"（无顶层 import/export），
// 类型一律用内联 import("...") 写法；
// 若以后需要顶层 import，就必须改成 declare global { ... } + export {} 的形式。

/** 流式 SSE 响应写入器（agent.ts 中 res 的原生引用，供断线重连续写） */
declare var __novelRes: import("express").Response;

/** 当前小说生成任务的唯一 id（区分不同任务的重连快照） */
declare var __novelTaskId: string;

/** 内存中最新的全文（重连快照取内存值，消除节流落库 ≤200ms 的 gap，与续订阅无缝衔接） */
declare var __novelFullText: string;

/** @ffmpeg-installer/ffmpeg：按平台分包分发二进制，导出 { path, version } */
declare module '@ffmpeg-installer/ffmpeg' {
  const ffmpeg: { path: string; version: string };
  export default ffmpeg;
}

/** ffprobe-static：导出 { path, version } */
declare module 'ffprobe-static' {
  const ffprobe: { path: string; version: string };
  export default ffprobe;
}
