import { readFile, stat } from 'node:fs/promises';
import { projectPath } from '../host/store.ts';
import { probeVideo } from './video.ts';
import type { EnvironmentSettings, VideoProject } from '../shared/types.ts';

export function inspectImage(bytes: Uint8Array): { mime: string; width: number; height: number } {
  const buffer = Buffer.from(bytes);
  let result: { mime: string; width: number; height: number } | undefined;
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    result = { mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } else if (buffer[0] === 255 && buffer[1] === 216) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 255) break;
      const marker = buffer[offset + 1]!; offset += 2;
      if (marker === 217 || marker === 218) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        result = { mime: 'image/jpeg', height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) }; break;
      }
      offset += length;
    }
  } else if (buffer.length >= 30 && buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP') {
    const kind = buffer.subarray(12,16).toString();
    if (kind === 'VP8X') result = { mime: 'image/webp', width: 1 + buffer.readUIntLE(24,3), height: 1 + buffer.readUIntLE(27,3) };
    else if (kind === 'VP8 ' && buffer[23] === 157 && buffer[24] === 1 && buffer[25] === 42) result = { mime: 'image/webp', width: buffer.readUInt16LE(26) & 16383, height: buffer.readUInt16LE(28) & 16383 };
    else if (kind === 'VP8L' && buffer[20] === 47) { const bits = buffer.readUInt32LE(21); result = { mime: 'image/webp', width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 }; }
  }
  if (!result || result.width < 1 || result.height < 1 || result.width * result.height > 33_554_432) throw new Error('图片真实格式或尺寸无效，仅支持 PNG/JPEG/WebP');
  return result;
}

export async function readProjectImage(root: string, project: VideoProject, assetId: string, shotId?: string) {
  const asset = project.assets.find(item => item.id === assetId && item.kind === 'image');
  if (!asset?.path) throw new Error('所选图片不属于当前工程');
  if (shotId) {
    const shot = project.shots.find(item => item.id === shotId);
    if (!shot || ![...shot.assetIds, ...shot.referenceIds].includes(assetId)) throw new Error('图片未绑定到本轮镜头');
  }
  const file = await projectPath(root, asset.path), info = await stat(file);
  if (!info.isFile() || info.size < 1 || info.size > 6 * 1024 * 1024) throw new Error('上传图片须不超过 6 MiB');
  const bytes = await readFile(file);
  if (bytes.length > 6 * 1024 * 1024) throw new Error('上传图片读取后超过 6 MiB');
  const metadata = inspectImage(bytes);
  if (Math.max(metadata.width, metadata.height) > 4096 || metadata.width * metadata.height > 16_777_216) throw new Error('上传图片尺寸超过 4096 或像素上限');
  return { bytes, mime: metadata.mime };
}

export async function inspectGeneratedMedia(file: string, mime: string, settings: Partial<EnvironmentSettings> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const info = await stat(file);
  if (!info.isFile() || !info.size) throw new Error('生成产物不是有效文件');
  if (mime.startsWith('image/')) {
    if (info.size > 20_000_000) throw new Error('生成图片超过 20 MB');
    const result = inspectImage(await readFile(file));
    if (result.mime !== mime) throw new Error('生成图片格式与声明不一致');
    return result;
  }
  if (mime.startsWith('video/')) return { ...await probeVideo(file, settings, signal) };
  throw new Error('生成产物只接受图片或视频');
}
