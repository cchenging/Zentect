// 📁 路径：src/modules/media/audio/types.ts
// 接口契约：人声/背景音乐分离模块（§3.5.3）

/** 音频分离输入参数 */
export interface AudioSeparateInput {
  /** 输入视频文件物理绝对路径 */
  videoPath: string;
  /** 分离引擎：spleeter / uvr5 */
  engine: string;
}

/** 音频分离输出 */
export interface AudioSeparateOutput {
  /** 人声文件绝对路径 */
  vocalsPath: string;
  /** 背景音乐文件绝对路径 */
  bgmPath: string;
}
