// 📁 路径：src/renderer/src/utils/formatUrl.ts

/** 
 * 将底层物理路径转换为 Chromium 安全的浏览器渲染 URL 
 * 包含对 file://、 http://、Base64 以及特权 magic:// 协议的全量兼容防御
 * @param rawPath 原始路径
 * @param basePath 可选的项目基础路径，用于拼接相对路径
 */
export const getSafeMediaUrl = (rawPath?: string | null): string => {
  if (!rawPath) return '';
  
  const trimmedPath = rawPath.trim();

  // 1. 绝对放行的安全协议（http/https/data/magic 直接透传
  // 注意：atom:// 协议需要转换为 magic:// 协议
  if (
    trimmedPath.startsWith('http://') ||
    trimmedPath.startsWith('https://') ||
    trimmedPath.startsWith('data:image') ||
    trimmedPath.startsWith('magic://') ||
    trimmedPath.startsWith('blob:')
  ) {
    return trimmedPath;
  }
  
  // 2. 处理 atom:// 协议，转换为 magic:// 协议
  if (trimmedPath.startsWith('atom://')) {
    const pathWithoutProtocol = trimmedPath.replace(/^atom:\/\//, '');
    return getSafeMediaUrl(pathWithoutProtocol);
  }

  // 3. 处理 Windows 绝对路径（如 C:\Users\xxx\video.mp4）
  let cleanPath = trimmedPath.startsWith('file://') 
    ? trimmedPath.replace(/^file:/, '') 
    : trimmedPath;

  // 3. 物理洗地：统一目录分隔符
  cleanPath = cleanPath.replace(/\\/g, '/');

  // 4. 处理 Windows 绝对路径的前导斜杠
  const isWindowsAbsolutePath = /^[A-Za-z]:/.test(cleanPath);
  if (!isWindowsAbsolutePath && !cleanPath.startsWith('/')) {
    cleanPath = '/' + cleanPath;
  }

  // 5. 编码处理
  let safeEncodedPath = encodeURI(cleanPath);
  
  // 特殊处理 Windows 盘符冒号（需在 encodeURI 之后进行，因为 encodeURI 不会转义冒号）
  if (isWindowsAbsolutePath) {
    safeEncodedPath = safeEncodedPath.replace(/^([A-Za-z]):/, '$1%3A');
  }

  // 额外处理其他可能截断 URL 的字符
  safeEncodedPath = safeEncodedPath
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');

  // 6. 核心修复：强制铸造为绕过跨域限制的特权协议！
  // 使用 magic://local/ 前缀确保盘符(G%3A)位于 pathname 而非 host
  return `magic://local/${safeEncodedPath}`;
}

/**
 * 安全格式化 magic:// URL，清洗双重编码和斜杠异常
 * 用于播放器组件加载前对 URL 做防御性清洗
 */
export const formatMagicUrl = (rawSrc: string): string => {
  if (!rawSrc || !rawSrc.startsWith('magic://')) return rawSrc;

  try {
    let decodedPath = decodeURIComponent(rawSrc.replace('magic://local/', '').replace('magic://', ''));

    decodedPath = decodedPath.replace(/\\/g, '/');
    if (decodedPath.startsWith('/')) {
      decodedPath = decodedPath.substring(1);
    }

    return `magic://local/${decodedPath}`;
  } catch (e) {
    console.error('formatMagicUrl 解析失败', e);
    return rawSrc;
  }
}
