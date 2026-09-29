"""
test_supply_dur.py — 🎬 落码点3 可供给时长口径（乙案）+ 母块首帧弱锚开关（丙①）验证

锁定两处「缺省 off = 零行为变化」的新口径（守「禁止未测量即上线」）：

  1. 乙案（`ZENTECT_KM_SUPPLY_DUR`）：`build_supply_ms` 同母块**源时间连续**后继链合并是否正确
     （断链 / 异素材文件 / 无 parent 退化），以及「供得起 ⇒ 不罚、供不起 ⇒ 如实罚」的计分口径。
  2. 丙①（`ZENTECT_KM_BLOCK_ANCHOR`）：`_read_block_anchor` 缺省 off（block_first 锚不参与，
     现状零变化）、仅显式 on 才接线。

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe -m __tests__.test_supply_dur
  （函数式 test_* + 纯 assert；run_all.py 自动收集）
"""
import os
import sys

# 将 scripts 目录加入 path，以便 import 新引擎各模块
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from beam_search import _read_block_anchor
from match_cost import SUPPLY_CHAIN_GAP_MS, _read_supply_dur, build_supply_ms
from montage_contract import assemble_chunk
from timeline_solver import _chain_cover_window, _compute_duration_score


def _with_env(key, value, fn):
    """在指定 env 取值下执行 fn（执行后还原原值，避免测试间互相污染）。"""
    old = os.environ.get(key)
    if value is None:
        os.environ.pop(key, None)
    else:
        os.environ[key] = value
    try:
        return fn()
    finally:
        if old is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = old


def _idx(chunks):
    """切片列表 → {id: chunk} 资产索引。"""
    return {c['id']: c for c in chunks}


def test_supply_chain_merges_contiguous_siblings():
    """同母块、同素材文件、相邻间隔 ≤100ms 的后继段链合并；本段自身时长计入供给。"""
    chunks = [
        assemble_chunk({'id': 'a', 'parentChunkId': 'P', 'filePath': 'v.mp4',
                        'startMs': 0, 'endMs': 3000}),
        assemble_chunk({'id': 'b', 'parentChunkId': 'P', 'filePath': 'v.mp4',
                        'startMs': 3000, 'endMs': 6000}),
        assemble_chunk({'id': 'c', 'parentChunkId': 'P', 'filePath': 'v.mp4',
                        'startMs': 6000, 'endMs': 9000}),
    ]
    sup = build_supply_ms(_idx(chunks))

    assert sup['a'] == 9000, f"a 起可连播 a+b+c=9000，实际 {sup['a']}"
    assert sup['b'] == 6000, f"b 起可连播 b+c=6000，实际 {sup['b']}"
    assert sup['c'] == 3000, "链尾只有自身"
    print("✓ test_supply_chain_merges_contiguous_siblings: 连续后继链合并正确")


def test_supply_chain_breaks_on_gap_and_file():
    """间隔 >100ms 或换素材文件即断链；无 parentChunkId 不入索引（不造假相邻关系）。"""
    gap = SUPPLY_CHAIN_GAP_MS + 1.0
    chunks = [
        assemble_chunk({'id': 'a', 'parentChunkId': 'P', 'filePath': 'v.mp4',
                        'startMs': 0, 'endMs': 3000}),
        # b 紧接 a 之后，但缺口 > 容差 ⇒ a→b 断链（各段自身时长均为 3000，便于断言判别）
        assemble_chunk({'id': 'b', 'parentChunkId': 'P', 'filePath': 'v.mp4',
                        'startMs': 3000 + gap, 'endMs': 3000 + gap + 3000}),
        # c 紧接 b（间隔 0）但换素材文件 ⇒ b→c 因 filePath 不同断链
        assemble_chunk({'id': 'c', 'parentChunkId': 'P', 'filePath': 'other.mp4',
                        'startMs': 3000 + gap + 3000, 'endMs': 3000 + gap + 6000}),
        assemble_chunk({'id': 'd', 'filePath': 'v.mp4', 'startMs': 9000, 'endMs': 12000}),
    ]
    sup = build_supply_ms(_idx(chunks))

    assert sup['a'] == 3000, f"缺口超容差 ⇒ 断链，a 只有自身，实际 {sup['a']}"
    assert sup['b'] == 3000, "b→c 换素材文件 ⇒ 断链，b 只有自身"
    assert sup['c'] == 3000, "换素材文件 ⇒ 不与后继链合并（链尾只有自身）"
    assert 'd' not in sup, "无 parentChunkId 不入供给索引（调用方回退自身时长）"
    print("✓ test_supply_chain_breaks_on_gap_and_file: 断链/异文件/无父退化正确")


def test_supply_dur_flag_default_off_and_switchable():
    """乙案开关：缺省 off（零行为变化）；显式 1/on/true 才启用；其余值按 off。"""
    assert _with_env('ZENTECT_KM_SUPPLY_DUR', None, _read_supply_dur) is False, \
        "缺省必须 off（零行为变化）"
    for raw in ('1', 'on', 'true', 'ON'):
        assert _with_env('ZENTECT_KM_SUPPLY_DUR', raw, _read_supply_dur) is True, \
            f"{raw!r} 应启用可供给时长口径"
    for raw in ('0', 'off', 'yes', ''):
        assert _with_env('ZENTECT_KM_SUPPLY_DUR', raw, _read_supply_dur) is False, \
            f"{raw!r} 应保持 off（非法值不豁免不造假）"
    print("✓ test_supply_dur_flag_default_off_and_switchable: 乙案开关解析正确")


def test_supply_basis_does_not_penalize_ample_material():
    """口径关键（乙案）：供得起 ⇒ 按曲线「正好够」档计分（因素材过长被罚是伪命题）；
    供不起 ⇒ 与自身时长口径同罚（后果确为变速/截断，如实罚）。"""
    audio = 4744.0
    short = 1067.0     # 供不起（scene_001 实测：命中镜头 1067ms vs 配音 4744ms ⇒ 4.45× 慢放）
    ample = 65229.0    # 供得起（源片连续铺满）

    assert _compute_duration_score(audio, min(ample, audio)) == 0.95, \
        "供得起必须落在曲线自身「正好够」档（免变速）"
    assert _compute_duration_score(audio, min(short, audio)) == _compute_duration_score(audio, short), \
        "供不起必须按真实可供给时长计罚（与自身时长口径同值）"
    assert _compute_duration_score(audio, short) < 0.95, "供不起不得被当成「正好够」"
    print("✓ test_supply_basis_does_not_penalize_ample_material: 供给口径计分语义正确")


def test_block_anchor_flag_default_off():
    """丙① 弱锚开关：缺省 off（block_first 锚仍不参与，现状零变化）；显式 1 才接线。"""
    assert _with_env('ZENTECT_KM_BLOCK_ANCHOR', None, _read_block_anchor) is False, \
        "缺省必须 off（43/43 段 block_first 锚不参与是现状基线）"
    assert _with_env('ZENTECT_KM_BLOCK_ANCHOR', '1', _read_block_anchor) is True
    assert _with_env('ZENTECT_KM_BLOCK_ANCHOR', 'off', _read_block_anchor) is False
    print("✓ test_block_anchor_flag_default_off: 丙① 弱锚开关缺省关闭")


def test_chain_cover_window_extends_to_target_and_consumes():
    """乙案② 交付端：命中片不够 ⇒ 沿同母块连续后继链扩到恰好覆盖配音；吃掉的兄弟片进独占集合。"""
    chunks = [
        assemble_chunk({'id': 'a', 'parentChunkId': 'P', 'filePath': 'v.mp4', 'startMs': 0, 'endMs': 3000}),
        assemble_chunk({'id': 'b', 'parentChunkId': 'P', 'filePath': 'v.mp4', 'startMs': 3000, 'endMs': 6000}),
        assemble_chunk({'id': 'c', 'parentChunkId': 'P', 'filePath': 'v.mp4', 'startMs': 6000, 'endMs': 9000}),
    ]
    used = set()
    out = _chain_cover_window(chunks[0], 5000.0, _idx(chunks), used)

    assert out is not None, "命中片 3000ms < 配音 5000ms ⇒ 必须扩链"
    assert out['startMs'] == 0 and out['endMs'] == 5000.0, f"窗尾须恰好 = 起点+配音，实际 {out['endMs']}"
    assert out['durationMs'] == 5000.0, "durationMs 必须与窗长同源（导出变速依据）"
    assert out['id'] == 'a', "身份保持命中片（卡片/封面仍指命中切片）"
    assert used == {'b'}, f"吃掉的兄弟片须进独占集合，实际 {used}"
    assert chunks[0]['endMs'] == 3000, "不得就地改写入参切片（原对象保真）"
    print("✓ test_chain_cover_window_extends_to_target_and_consumes: 扩链覆盖 + 独占登记正确")


def test_chain_cover_window_partial_and_blocked_cases():
    """链不足 ⇒ 尽力覆盖到链尾；兄弟片已被吃掉/断链/异文件/无父/自身够长 ⇒ 直通（None）。"""
    chunks = [
        assemble_chunk({'id': 'a', 'parentChunkId': 'P', 'filePath': 'v.mp4', 'startMs': 0, 'endMs': 3000}),
        assemble_chunk({'id': 'b', 'parentChunkId': 'P', 'filePath': 'v.mp4', 'startMs': 3000, 'endMs': 4000}),
    ]
    idx = _idx(chunks)
    used = set()
    out = _chain_cover_window(chunks[0], 5000.0, idx, used)

    assert out is not None and out['endMs'] == 4000.0 and out['durationMs'] == 4000.0, \
        "链不足须如实尽力覆盖（不造假到配音时长）"
    assert used == {'b'}
    used2 = {'b'}
    assert _chain_cover_window(chunks[0], 5000.0, idx, used2) is None, \
        "兄弟片已被前序碎片吃掉 ⇒ 独占阻断"
    assert used2 == {'b'}, "阻断时不得改动独占集合"
    assert _chain_cover_window(chunks[0], 3000.0, idx, set()) is None, "自身够长 ⇒ 直通（零行为变化）"

    gap = SUPPLY_CHAIN_GAP_MS + 1.0
    gap_idx = _idx([chunks[0], assemble_chunk({'id': 'g', 'parentChunkId': 'P', 'filePath': 'v.mp4',
                                               'startMs': 3000 + gap, 'endMs': 9000})])
    assert _chain_cover_window(chunks[0], 5000.0, gap_idx, set()) is None, "源时间断链 ⇒ 不跨接"
    other_idx = _idx([chunks[0], assemble_chunk({'id': 'f', 'parentChunkId': 'P', 'filePath': 'other.mp4',
                                                 'startMs': 3000, 'endMs': 9000})])
    assert _chain_cover_window(chunks[0], 5000.0, other_idx, set()) is None, "跨素材文件 ⇒ 不跨接"
    noparent = assemble_chunk({'id': 'n', 'filePath': 'v.mp4', 'startMs': 0, 'endMs': 1000})
    assert _chain_cover_window(noparent, 5000.0, _idx([noparent]), set()) is None, \
        "无父块 ⇒ 直通（不造假兄弟关系）"
    print("✓ test_chain_cover_window_partial_and_blocked_cases: 链不足/独占阻断/断链退化正确")


def test_chain_cover_window_backfills_from_predecessors():
    """🩹 2026-09-27 向前补足：命中母块尾片（后向链为空）⇒ 沿同母块前驱链回吃差额，窗 = [尾−配音, 尾]。"""
    chunks = [
        assemble_chunk({'id': 'a', 'parentChunkId': 'P', 'filePath': 'v.mp4', 'startMs': 0, 'endMs': 2000}),
        assemble_chunk({'id': 'b', 'parentChunkId': 'P', 'filePath': 'v.mp4', 'startMs': 2000, 'endMs': 4000}),
        assemble_chunk({'id': 'c', 'parentChunkId': 'P', 'filePath': 'v.mp4', 'startMs': 4000, 'endMs': 6000}),
    ]
    idx = _idx(chunks)
    hit = chunks[2]           # 母块尾片只有 2000ms，配音 5000ms ⇒ 后向无料（实测 seg_19 形态）
    used = set()
    out = _chain_cover_window(hit, 5000.0, idx, used)

    assert out is not None, "命中尾片 + 后向无料 ⇒ 必须向前回吃（旧口径在此必然判荒）"
    assert out['startMs'] == 1000 and out['endMs'] == 6000, \
        f"窗须 = [尾−配音, 尾] = [1000, 6000]，实际 {out['startMs']}~{out['endMs']}"
    assert out['durationMs'] == 5000.0, "窗长须补齐到配音（该段变速归 1.0）"
    assert out['id'] == 'c', "身份保持命中片（卡片/封面仍指命中切片）"
    assert used == {'a', 'b'}, f"回吃的前驱片须进独占集合，实际 {used}"
    assert chunks[2]['startMs'] == 4000, "不得就地改写入参切片（原对象保真）"

    # 独占：回吃不得越过他段命中片（reserved）——即使它在前驱链上
    used2 = set()
    assert _chain_cover_window(hit, 5000.0, idx, used2, {'b'}) is None, "前驱片是他段命中片 ⇒ 独占阻断、直通"
    assert used2 == set(), "阻断时不得改动独占集合"

    # 断链：前驱片与命中片源间隙 > 容差 ⇒ 不回吃
    gap = SUPPLY_CHAIN_GAP_MS + 1.0
    gap_idx = _idx([
        assemble_chunk({'id': 'g', 'parentChunkId': 'P', 'filePath': 'v.mp4',
                        'startMs': 4000 - gap - 1000, 'endMs': 4000 - gap}),
        hit,
    ])
    assert _chain_cover_window(hit, 5000.0, gap_idx, set()) is None, "源时间断链 ⇒ 不回吃"

    # 后向优先：后向链够长 ⇒ 窗头恒 = 命中起点（旧口径零行为变化）
    fwd = _chain_cover_window(chunks[0], 5000.0, idx, set())
    assert fwd is not None and fwd['startMs'] == 0, "后向够长时窗头不动，仍为命中起点"
    print("✓ test_chain_cover_window_backfills_from_predecessors: 向前补足/独占阻断/断链口径正确")


if __name__ == "__main__":
    print("=" * 60)
    print("🎬 落码点3 · 可供给时长口径（乙案）+ 母块首帧弱锚（丙①）验证")
    print("=" * 60)
    test_supply_chain_merges_contiguous_siblings()
    test_supply_chain_breaks_on_gap_and_file()
    test_supply_dur_flag_default_off_and_switchable()
    test_supply_basis_does_not_penalize_ample_material()
    test_block_anchor_flag_default_off()
    test_chain_cover_window_extends_to_target_and_consumes()
    test_chain_cover_window_partial_and_blocked_cases()
    test_chain_cover_window_backfills_from_predecessors()
    print("=" * 60)
    print("全部通过 ✅")