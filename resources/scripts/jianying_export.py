"""
剪映草稿导出核心模块 — pyJianYingDraft API 版
==============================================
从 test_jy_api_export.py 提取，自包含 FastAPI APIRouter，
ai_daemon.py 只需 app.include_router(router) 即可注册。

关键设计：
  - VideoSegment(material, target_timerange, *, source_timerange)
    target: 轨道显示范围（必须无重叠递增）
    source: 素材截取范围
  - trange(start, duration) — 第2参数是持续时长，非结束时间！
  - 每个 segment 的 target 从前一个 segment 结束时间开始
"""
import os
import traceback
import asyncio
import concurrent.futures

import pyJianYingDraft as draft
from pyJianYingDraft import trange, TrackType
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List

# 剪映草稿根目录 — 自动检测，不再硬编码
import winreg

def _detect_jianying_draft_root():
    """自动检测剪映专业版草稿目录"""
    # 1. 尝试从注册表读取剪映安装路径
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Bytedance\JianyingPro", 0, winreg.KEY_READ)
        install_dir, _ = winreg.QueryValueEx(key, "InstallDir")
        winreg.CloseKey(key)
        if install_dir:
            candidate = os.path.join(os.path.dirname(install_dir), "JianyingPro Drafts")
            if os.path.isdir(candidate):
                return candidate
    except Exception:
        pass

    # 2. 尝试常见路径
    common_paths = [
        os.path.join(os.path.expanduser("~"), "AppData", "Local", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"),
        os.path.join(os.path.expanduser("~"), "AppData", "Local", "Bytedance", "JianyingPro", "User Data", "Projects", "com.lveditor.draft"),
    ]
    for p in common_paths:
        if os.path.isdir(p):
            return p

    # 3. 降级：使用 Zentect 数据目录下的 jianying 子目录
    return os.path.join(os.path.expanduser("~"), "Zentect", "jianying_drafts")

JIANYING_DRAFT_ROOT = _detect_jianying_draft_root()

# ============ FastAPI 路由 ============
router = APIRouter()


class JianyingExportReq(BaseModel):
    matchResults: List[dict]                    # 匹配结果数组（含 chunkData）
    mediaPath: str = ""                         # 原视频路径
    projectName: str = "export"                 # 项目名称
    scriptsParagraphs: List[dict] = []          # 文案段落（含 shotId/text）
    scriptLines: List[dict] = []                # 💥 V1.2 行级剧本（含 id/text/paragraphId）
    ttsResults: List[dict] = []                 # TTS 结果（含 shotId/audioUrl）
    bgmPath: str = ""                           # BGM 背景音乐路径
    customPath: str = ""                        # 用户指定的草稿导出路径


@router.post("/api/jianying/export")
async def export_endpoint(req: JianyingExportReq):
    """接收前端 matchResults + scripts + tts 数据，构建加密剪映草稿"""
    loop = asyncio.get_event_loop()
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        try:
            result = await loop.run_in_executor(
                executor,
                build_and_save_draft,
                req.matchResults,
                req.mediaPath,
                req.projectName,
                req.scriptsParagraphs,
                req.scriptLines,
                req.ttsResults,
                req.bgmPath,
                req.customPath,
            )
            return result
        except Exception as e:
            print(f"ERROR: 剪映草稿导出崩溃 - {str(e)}", file=__import__('sys').stderr)
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=str(e))


# ============ 数据提取 ============
def extract_audio_duration_us(item: dict) -> int:
    if item.get("audioDurationMs") and item["audioDurationMs"] > 0:
        return int(item["audioDurationMs"] * 1000)
    if item.get("audioDuration") and item["audioDuration"] > 0:
        return int(item["audioDuration"] * 1_000_000)
    chunk = item.get("chunkData")
    if chunk and chunk.get("durationMs") and chunk["durationMs"] > 0:
        return int(chunk["durationMs"] * 1000)
    return 0


def extract_text(item: dict, scripts_map: dict, lines_map: dict) -> str:
    """统一降级链：scriptLines → scriptParagraphs → aiText → ttsText → originalText → shotId → subtitle"""
    sid = item.get("shotId", "")
    # 💥 V1.2 优先从 scriptLines 按行级 ID 查找（行级模式下 shotId 是 line_xxx）
    line = lines_map.get(sid, {})
    text = line.get("text") or ""
    if text:
        return text
    # 2. 从 scriptParagraphs 取文案（段落级匹配）
    sp = scripts_map.get(sid, {})
    text = sp.get("text") or ""
    if text:
        return text
    # 3. 降级链：aiText → ttsText → originalText → shotId → subtitle
    return (
        item.get("aiText")
        or item.get("ttsText")
        or item.get("originalText")
        or item.get("subtitle")
        or ""
    )


def extract_audio_path(item: dict, tts_map: dict) -> str:
    """从 ttsResults 中按 shotId 取配音路径（去 magic:// 前缀，转为实际路径）"""
    sid = item.get("shotId", "")
    tr = tts_map.get(sid, {})
    url = tr.get("audioUrl") or tr.get("audioPath") or ""
    if not url:
        return ""
    # 去除 magic://proj_xxx/ 前缀（TS 端已做 resolveMagicPath，这里是双保险）
    if url.startswith("magic://"):
        # magic://proj_xxx/extractions/tts/xxx.wav → 提取相对路径部分
        try:
            from urllib.parse import urlparse
            parsed = urlparse(url)
            return parsed.path.lstrip("/")
        except Exception:
            pass
    return url


# ============ 草稿构建 ============
def build_draft(match_results: list, media_path: str, project_name: str,
                scripts_paragraphs: list = None, script_lines: list = None,
                tts_results: list = None, bgm_path: str = "",
                custom_path: str = ""):
    """用 pyJianYingDraft API 构建草稿，自动加密 content"""
    # 💥 scriptParagraphs 可能没有 shotId，安全构建 map
    scripts_map = {}
    for s in (scripts_paragraphs or []):
        sid = s.get("shotId") or s.get("id") or ""
        if sid:
            scripts_map[sid] = s
    # 💥 V1.2 行级剧本 map：按行级 ID 查找文案
    lines_map = {}
    for line in (script_lines or []):
        lid = line.get("id") or line.get("shotId") or ""
        if lid:
            lines_map[lid] = line
    tts_map = {t["shotId"]: t for t in (tts_results or []) if t.get("shotId")}

    # 用户指定路径优先，否则自动检测
    draft_root = custom_path if custom_path and os.path.isdir(custom_path) else JIANYING_DRAFT_ROOT

    # 递增版本号避免覆盖旧草稿，不删除任何已有草稿
    draft_name = project_name
    version = 2
    while os.path.exists(os.path.join(draft_root, draft_name)):
        draft_name = f"{project_name}_v{version}"
        version += 1

    print(f"  [草稿名称] {draft_name}")
    print(f"  [草稿路径] {draft_root}")

    folder = draft.DraftFolder(draft_root)
    script = folder.create_draft(draft_name, 1920, 1080)

    vid_track = script.add_track(TrackType.video, "main")
    aud_track = script.add_track(TrackType.audio, "audio")
    txt_track = script.add_track(TrackType.text, "subs")

    valid, skipped = 0, 0
    track_end = 0  # 当前轨道末尾微秒

    # 💥 BGM 铺底：整片一条，放在音频轨最前面
    if bgm_path and os.path.exists(bgm_path):
        # 先计算总时长（用于 BGM 截取）
        total_dur_us = 0
        for match in match_results:
            chunk = match.get("chunkData")
            if not chunk:
                continue
            audio_dur = extract_audio_duration_us(match)
            chunk_dur = int((chunk.get("durationMs", 0) or 0) * 1000)
            total_dur_us += audio_dur if audio_dur > 0 else chunk_dur
        if total_dur_us > 0:
            try:
                import wave
                with wave.open(bgm_path, 'rb') as wf:
                    bgm_dur_us = int((wf.getnframes() / wf.getframerate()) * 1_000_000)
            except Exception:
                bgm_dur_us = total_dur_us
            bgm = draft.AudioSegment(
                bgm_path,
                trange(0, total_dur_us),
                source_timerange=trange(0, min(bgm_dur_us, total_dur_us)),
            )
            script.add_segment(bgm, "audio")
            print(f"  [BGM] 已添加背景音乐，时长 {total_dur_us / 1_000_000:.1f}s")

    for idx, match in enumerate(match_results):
        chunk = match.get("chunkData")
        if not chunk:
            skipped += 1
            continue

        audio_dur_us = extract_audio_duration_us(match)
        chunk_dur_us = int((chunk.get("durationMs", 0) or 0) * 1000)
        effective_dur_us = audio_dur_us if audio_dur_us > 0 else chunk_dur_us
        if effective_dur_us <= 0:
            continue

        valid += 1
        video_path = chunk.get("filePath") or media_path or ""
        audio_path = extract_audio_path(match, tts_map)
        text_content = extract_text(match, scripts_map, lines_map)

        if video_path and os.path.exists(video_path):
            chunk_start_us = int((chunk.get("startMs", 0) or 0) * 1000)
            # 💥 音画同步：有 TTS 配音时，重新计算 speed_factor 使 source_dur = target_dur
            if audio_dur_us > 0 and chunk_dur_us > 0:
                # source_dur = chunk_dur * speed_factor = target_dur = audio_dur
                # → speed_factor = audio_dur / chunk_dur
                speed_factor = audio_dur_us / chunk_dur_us
            else:
                speed_factor = match.get("appliedSpeedFactor") or 1.0
            source_dur_us = int(chunk_dur_us * speed_factor)
            vs = draft.VideoSegment(
                video_path,
                target_timerange=trange(0, effective_dur_us),
                source_timerange=trange(chunk_start_us, source_dur_us),
            )
            vs.target_timerange = trange(track_end, effective_dur_us)
            script.add_segment(vs, "main")

        if audio_path and os.path.exists(audio_path):
            try:
                import wave
                with wave.open(audio_path, 'rb') as wf:
                    actual_dur_us = int((wf.getnframes() / wf.getframerate()) * 1_000_000)
            except Exception:
                actual_dur_us = effective_dur_us
            aud = draft.AudioSegment(
                audio_path,
                trange(track_end, effective_dur_us),
                source_timerange=trange(0, actual_dur_us),
            )
            script.add_segment(aud, "audio")

        if text_content:
            txt = draft.TextSegment(
                text_content,
                trange(track_end, effective_dur_us),
                style=draft.TextStyle(size=3.5, color=(1.0, 1.0, 1.0), align=1),
                clip_settings=draft.ClipSettings(transform_y=-0.85),
                border=draft.TextBorder(),
            )
            script.add_segment(txt, "subs")

        track_end += effective_dur_us

    print(f"  [构建] 输入 {len(match_results)} 条, 有效 {valid}, 跳过 {skipped}")
    print(f"  [构建] 总时长 {track_end / 1_000_000:.1f}s")
    return script


# ============ 对外入口 ============
def build_and_save_draft(match_results: list, media_path: str, project_name: str,
                         scripts_paragraphs: list = None, script_lines: list = None,
                         tts_results: list = None, bgm_path: str = "",
                         custom_path: str = ""):
    """构建并保存草稿，返回草稿信息"""
    script = build_draft(match_results, media_path, project_name,
                         scripts_paragraphs, script_lines, tts_results, bgm_path, custom_path)
    script.save()
    return {
        "success": True,
        "draftName": script.name if hasattr(script, 'name') else project_name,
        "duration": script.duration,
        "durationSec": round(script.duration / 1_000_000, 1),
    }
