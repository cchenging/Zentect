// 📁 路径：src/renderer/src/utils/formatUrl.ts

/** 
 * 将底层物理路径转换为 Chromium 安全的浏览器渲染 URL 
 * 包含对 file://、 http://、Base64 以及特权 magic:// 协议的全量兼容防御
 * @param rawPath 原始路径
 * @param basePath 可选的项目基础路径，用于拼接相对路径
 */
export const getSafeMediaUrl = (rawPath?: string | null): string => {
  // 类型防御：rawPath 运行时可能是 number/object/null 等非字符串
  // （如 framePaths 混入非法项、hydration 置 null），直接调 .trim 会崩溃
  if (!rawPath || typeof rawPath !== 'string') return '';

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

  // 🎬 分离 query 参数(如 ?t=1720000000),避免被 encodeURI 转义成 %3F
  // 用于封面 cache-busting:覆盖同名文件后 ?t=timestamp 强制 Chromium 重新加载
  let pathPart = trimmedPath;
  let queryPart = '';
  const queryIdx = trimmedPath.indexOf('?');
  if (queryIdx >= 0) {
    pathPart = trimmedPath.slice(0, queryIdx);
    queryPart = trimmedPath.slice(queryIdx + 1);
  }

  // 3. 处理 Windows 绝对路径（如 C:\Users\xxx\video.mp4）
  let cleanPath = pathPart.startsWith('file://')
    ? pathPart.replace(/^file:/, '')
    : pathPart;

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
    .replace(/#/g, '%23');

  // 6. 核心修复：强制铸造为绕过跨域限制的特权协议！
  // 使用 magic://local/ 前缀确保盘符(G%3A)位于 pathname 而非 host
  const baseUrl = `magic://local/${safeEncodedPath}`;

  // 🎬 拼回 query 参数,用于 cache-busting
  return queryPart ? `${baseUrl}?${queryPart}` : baseUrl;
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
