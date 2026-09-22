# -*- coding: utf-8 -*-
"""
gen_contracts.py —— K3 契约双端生成器（杜绝 Python/TS 字段漂移）

职责：
  以 resources/scripts/montage_contract.py 的 default_* 骨架函数为**唯一权威源**，
  内省其字段名 + 默认值类型推断 TS 类型，一键生成前端共享契约文件
  src/shared/contracts/montage.ts。

原则（守项目「只认一份契约」）：
  - 严禁人工手写 TS 接口文件；改动契约=改 montage_contract.py 后重跑本脚本。
  - 字段名/类型漂移在编译期即暴露（TS 消费端类型不匹配即报错），杜绝运行时 undefined。
  - 生成文件头部写入「禁止手改」警示 + 再生成命令。

调用方式：
  npm run gen:contracts
  或 python resources/scripts/gen_contracts.py

依赖：仅标准库（inspect/os/re/sys），无需额外安装。
"""

import inspect
import os
import re
import sys

# ---------------------------------------------------------------------------
# 脚本目录准入：保证可 import 同目录的 montage_contract（cwd 不一定在 scripts 下）
# ---------------------------------------------------------------------------
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import montage_contract as _mc

# ---------------------------------------------------------------------------
# 生成映射表：(python 骨架函数, TS 接口名, 接口职责注释, 字段类型覆盖表)
#   字段类型覆盖表用于「默认值无法自解释类型」的情形（None / 空数组 / 应引用的实体接口）：
#   - asrAnchorStartMs=None 但语义是 number|null，需显式声明；
#   - bgm=None 但语义是对象|null，需显式声明；
#   - chunkData={} 但语义是对应 VideoChunkAsset 实体，应引用接口而非 Record；
#   - queries/videoChunks/segments 空数组，应引用各实体接口数组。
# ---------------------------------------------------------------------------
# TS 类型表达式里的结构字符（括号/分隔/null/对象键），校验剥壳时一并视作合法
_STRUCTURAL = set('[]|?{}:,. /;\t')

_DEFS = [
    (
        _mc.default_query,
        'SegmentQuery',
        '剪辑装配输入契约：一条脚本句 + 其分镜工单（§8.5.5 / §24.15）。',
        {
            'characters': 'string[]',                 # 期望角色名集合
            'charIds': 'string[]',                    # 期望角色注册表主键集合
            'asrAnchorStartMs': 'number | null',      # 原声段 ASR 台词起始
            'asrAnchorEndMs': 'number | null',        # 原声段 ASR 台词结束
        },
    ),
    (
        _mc.default_chunk,
        'VideoChunkAsset',
        '视频切片资产品牌资产（§10.2.1 A 域）：素材侧物理资产 + 视听实体字段。',
        {
            'characters': 'string[]',
            'charIds': 'string[]',
            'colorHist': 'number[]',                  # 色温直方图
        },
    ),
    (
        _mc.default_segment,
        'Segment',
        '宏观场次（scene）资产（S1 场记单 / §8.2 补丁19）。',
        {
            'parentIds': 'string[]',                  # 归属物理镜头 ID 集合（同 parentChunkId 口径）
        },
    ),
    (
        _mc.default_request,
        'SegmentRequest',
        '剪辑装配引擎输入契约根（喂什么）。',
        {
            'queries': 'SegmentQuery[]',
            'videoChunks': 'VideoChunkAsset[]',
            'segments': 'Segment[]',
            'bgm': '{ bpm?: number; filePath: string; name?: string } | null',
        },
    ),
    (
        _mc.default_result,
        'MatchResult',
        '剪辑装配引擎输出契约（吐什么）：一段字幕一首镜的完整匹配结果，供 Node/前端渲染合成。',
        {
            'chunkData': 'VideoChunkAsset',           # 原始切片引用（透传）
        },
    ),
]

_OUTPUT_REL = os.path.join('src', 'shared', 'contracts', 'montage.ts')

# 逐字段中文注释提取正则：匹配 default_* 函数体内的单行字段 `'key': VALUE  # 注释`
_FIELD_LINE_RE = re.compile(
    r"^\s*['\"](\w+)['\"]\s*:\s*[^\n#]*(?:#\s*(.*))?\s*$",
    re.M,
)


def _field_comments(fn) -> dict:
    """提取 Python 骨架函数里各字段的尾随中文注释。

    用 inspect.getsource 拿到函数体源码，逐行正则抓 `# 注释`，
    供生成 TS 时补齐 `/ ** 字段注释 * /`，保持「中文注释」工程习惯。

    Args:
        fn: 骨架函数（default_query 等）。

    Returns:
        dict: {字段名: 注释文本}；无注释字段不收录。
    """
    source = inspect.getsource(fn)
    comments: dict = {}
    for m in _FIELD_LINE_RE.finditer(source):
        key = m.group(1)
        note = (m.group(2) or '').strip()
        if note and key not in comments:
            comments[key] = note
    return comments


def _ts_type(field: str, value, overrides: dict) -> str:
    """从 Python 默认值推断 TS 类型（overrides 优先）。

    推断规则（bool 须在 int 之前判，因 bool 是 int 子类）：
      0.0 → number；'' → string；False → boolean；[] → Array；{} → Record；None → any。

    Args:
        field: 字段名。
        value: 该字段的 Python 默认值。
        overrides: 该接口的字段类型覆盖表。

    Returns:
        str: TS 类型表达式。
    """
    if field in overrides:
        return overrides[field]
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, (int, float)):
        return 'number'
    if isinstance(value, str):
        return 'string'
    if isinstance(value, list):
        if not value:
            return 'Array<any>'
        return f'Array<{_ts_type(field, value[0], overrides)}>'
    if value is None:
        return 'any'
    if isinstance(value, dict):
        return 'Record<string, any>'
    return 'any'


def _validate_overrides(ts_name: str, overrides: dict) -> None:
    """防御性校验覆盖表里的每个类型表达式，确认其只含已知结构。

    实现：先把表达式里所有标识符（[A-Za-z_] + 序列）剥掉，再滤掉结构字符；
    若仍有残留，说明手滑写成了未知符号（例如多了个 `@` / 拼错），直接抛错终止。

    Args:
        ts_name: 接口名（用于报错定位）。
        overrides: 字段类型覆盖表。

    Raises:
        SystemExit: 覆盖表类型表达式含非合法结构字符。
    """
    for field, expr in overrides.items():
        stripped = re.sub(r'[A-Za-z_]+', '', expr)          # 去掉类型名
        residual = ''.join(c for c in stripped
                           if c not in _STRUCTURAL).strip()
        if residual:
            raise SystemExit(
                f'[gen_contracts] {ts_name}.{field} 覆盖类型含非法符号 {residual!r}: {expr!r}'
            )


def _render_interface(ts_name: str, doc: str, fn, overrides: dict) -> str:
    """渲染单个 TS interface 定义块。

    Args:
        ts_name: TS 接口名。
        doc: 接口职责注释。
        fn: 对应 Python 骨架函数。
        overrides: 该接口字段类型覆盖表。

    Returns:
        str: 渲染完成的 interface 代码段。
    """
    _validate_overrides(ts_name, overrides)
    defaults = fn()
    comments = _field_comments(fn)
    out = [f'/** {doc} */', f'export interface {ts_name} {{']
    for field, value in defaults.items():
        ts_type = _ts_type(field, value, overrides)
        note = comments.get(field, '')
        if note:
            out.append(f'  /** {note} */')
        out.append(f'  {field}: {ts_type};')
    out.append('}')
    return '\n'.join(out)


def _generate() -> str:
    """按依赖顺序渲染全部接口，拼装为完整 TS 契约文件内容。

    依赖顺序保证被引用的实体接口先声明（SegmentQuery → VideoChunkAsset → Segment
    → SegmentRequest → MatchResult.chunkData）。

    Returns:
        str: 生成的 montage.ts 完整文本。
    """
    header = (
        '/**\n'
        ' * ⚠️ 本文件由脚本自动生成，禁止手写/手改！\n'
        ' * 唯一权威源：resources/scripts/montage_contract.py（default_* 骨架函数）。\n'
        ' * 改动契约流程：\n'
        ' *   1. 在 montage_contract.py 中增/删/改字段（含中文尾注）；\n'
        ' *   2. 重新执行 `npm run gen:contracts`；\n'
        ' *   3. 本文件自动同步，TS 消费端在编译期即校验字段漂移（K3 闭环）。\n'
        ' * 生成命令：npm run gen:contracts\n'
        ' */\n'
        '\n'
        '/* eslint-disable */\n'
        '/* generated by resources/scripts/gen_contracts.py — do not edit */\n'
        '\n'
    )
    blocks = [_render_interface(ts_name, doc, fn, overrides)
              for fn, ts_name, doc, overrides in _DEFS]
    return header + '\n\n'.join(blocks) + '\n'


def main() -> None:
    """生成 montage.ts 并落盘到 src/shared/contracts/。

    Raises:
        SystemExit: 输出目录不可定位时抛错（守「错就错」，不静默跳过）。
    """
    project_root = os.path.abspath(os.path.join(_SCRIPTS_DIR, '..', '..'))
    output_path = os.path.join(project_root, _OUTPUT_REL)
    if not os.path.isdir(os.path.dirname(output_path)):
        raise SystemExit(f'[gen_contracts] 输出目录不存在: {os.path.dirname(output_path)}')
    content = _generate()
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'[gen_contracts] 已生成: {output_path}')


if __name__ == '__main__':
    main()