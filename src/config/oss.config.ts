import OSS from "ali-oss";
import crypto from "crypto";

// 阿里云OSS配置
let cachedOssClient: OSS | null = null;

/**
 * 延迟创建 OSS 客户端：模块加载阶段不校验凭证，缺少配置时只在真正上传时抛出可读错误
 * （历史缺陷：顶层 new OSS() 会让未配置 OSS 的进程在 import 阶段直接崩溃）。
 */
function getOssClient(): OSS {
    if (cachedOssClient) return cachedOssClient;
    const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
    const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
    const region = process.env.OSS_REGION;
    const bucket = process.env.OSS_BUCKET;
    if (!accessKeyId || !accessKeySecret || !region || !bucket) {
        throw new Error('OSS 配置不完整，请设置 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_REGION / OSS_BUCKET');
    }
    cachedOssClient = new OSS({
        accessKeyId,
        accessKeySecret,
        region,
        bucket,
        secure: true,
        timeout: 120000,
        authorizationV4: true, // 使用 V4 签名
    });
    return cachedOssClient;
}

const ossPublicBaseUrl = (process.env.OSS_PUBLIC_BASE_URL || 'https://image.chatfox.cc').replace(/\/+$/, '')

/** 将 OSS 对象 key 转为对外访问地址，数据库只保存自定义域名。 */
export function buildOssPublicUrl(key: string): string {
    const encodedKey = key.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')
    return `${ossPublicBaseUrl}/${encodedKey}`
}

function isRetryableOssError(error: any) {
    const status = Number(error?.status || error?.statusCode || 0)
    return !status || status === 408 || status === 429 || status >= 500
}

/** OSS 上传统一使用 HTTPS，并对连接超时、限流和服务端错误进行重试。 */
export async function uploadBufferToOSS(
    key: string,
    buffer: Buffer,
    mime: string,
    maxRetries = 3,
): Promise<string> {
    let lastError: any
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await getOssClient().put(key, buffer, { mime, timeout: 120000 })
            const publicUrl = buildOssPublicUrl(key)
            console.log(`[OSS] 上传完成: ${publicUrl}`)
            return publicUrl
        } catch (error: any) {
            lastError = error
            if (!isRetryableOssError(error) || attempt === maxRetries) break
            const delay = 1000 * 2 ** (attempt - 1)
            console.warn(`[OSS] 上传失败，第 ${attempt}/${maxRetries} 次重试: ${error.message}`)
            await new Promise(resolve => setTimeout(resolve, delay))
        }
    }
    throw lastError
}

/** 将远程图片 URL 转存到 OSS，返回 OSS 永久 URL */
export async function uploadRemoteImageToOSS(imageUrl: string, folder: string = 'images/personas'): Promise<string> {
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`下载图片失败: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = imageUrl.split('.').pop()?.split('?')[0] || 'png';
    const key = `${folder}/${crypto.randomUUID()}.${ext}`;
    return uploadBufferToOSS(key, buffer, `image/${ext}`);
}

/** 将远程文件 URL 转存到 OSS，根据扩展名自动判断 MIME 类型（带超时+重试），返回 OSS 永久 URL */
export async function uploadRemoteFileToOSS(fileUrl: string, folder: string): Promise<string> {
    const maxRetries = 3
    let lastError: any
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 60000) // 60 秒超时
            const res = await fetch(fileUrl, { signal: controller.signal })
            clearTimeout(timeout)
            if (!res.ok) throw new Error(`下载文件失败: ${res.status}`)
            const buffer = Buffer.from(await res.arrayBuffer())
            const ext = fileUrl.split('.').pop()?.split('?')[0]?.toLowerCase() || 'bin'
            const mimeMap: Record<string, string> = {
                mp3: 'audio/mpeg',
                wav: 'audio/wav',
                mp4: 'video/mp4',
                mov: 'video/quicktime',
                png: 'image/png',
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                webp: 'image/webp',
            }
            const mime = mimeMap[ext] || 'application/octet-stream'
            const key = `${folder}/${crypto.randomUUID()}.${ext}`
            return uploadBufferToOSS(key, buffer, mime)
        } catch (e: any) {
            lastError = e
            console.warn(`转存文件失败（第 ${attempt + 1}/${maxRetries} 次）: ${e.message}`, fileUrl.slice(0, 120))
            if (attempt < maxRetries - 1) {
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1))) // 递增间隔重试
            }
        }
    }
    throw new Error(`转存文件失败（已重试 ${maxRetries} 次）: ${lastError?.message}`)
}

/** 将 hex 编码的音频数据解码并上传到 OSS，返回 OSS 永久 URL */
export async function uploadHexAudioToOSS(hexAudio: string, format: string = 'mp3', folder: string = 'tts'): Promise<string> {
    const buffer = Buffer.from(hexAudio, 'hex');
    const key = `${folder}/${crypto.randomUUID()}.${format}`;
    console.log(`[OSS] 上传音频: key=${key}, size=${buffer.length} bytes`);
    return uploadBufferToOSS(key, buffer, `audio/${format}`);
}

/** 需要直接操作客户端时按需获取（凭证缺失会在此抛出可读错误）。 */
export { getOssClient };
