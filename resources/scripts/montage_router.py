# -*- coding: utf-8 -*-
"""
montage_router.py —— 求解器薄壳路由（§8.5.2 可插拔，复用既有开关）

职责：按 `ZENTECT_KM_STORYBOARD_MODE` 在「旧 KM」与「新束搜索」之间择一执行。
    on      → 新引擎生效
    shadow  → 新旧并行、只留日志（A/B 对账，新结果不生效）
    off     → 旧引擎（零行为变化，回滚保险丝）

分层：本模块不做任何匹配/规则，只做「读开关 → 分发 + shadow 记录」。
供给层（MatchCost，R1 两层次串行）由集成方注入 provider，本模块不掺画面计算。
"""
from __future__ import annotations

import os
from typing import Callable, Dict, List, Optional

from montage_contract import (
    ROUTER_MODE_OFF,
    ROUTER_MODE_SHADOW,
    ROUTER_MODE_ON,
    ROUTER_MODES,
    ContractError,
    default_result,
)

# 环境变量开关（复用既有，线上改一行即回滚）。
_MODE_ENV = 'ZENTECT_KM_STORYBOARD_MODE'

# 供给层代价 provider：match_cost_provider(req) -> {shotId: {chunkId: base_cost}}
MatchCostProvider = Callable[[dict], Dict[str, Dict[str, float]]]

# trace 收集器（shadow 对账用）：可注入记录函数，缺省静默丢弃。
TraceLogger = Callable[[str], None]


def resolve_mode() -> str:
    """读取运行档位，非法值按 off 处理（旧引擎保底，绝不误开新引擎）。

    Returns:
        str: on | shadow | off。
    """
    raw = (os.environ.get(_MODE_ENV) or '').strip().lower()
    return raw if raw in ROUTER_MODES else ROUTER_MODE_OFF


class Router:
    """新旧求解器薄壳路由对象（集成方构造时注入回调）。

    Attributes:
        legacy_run: 旧引擎同步入参函数（同 `_kuhn_munkres_match_sync(req)`）。
        new_run: 新引擎编排函数（含 build_context + 供给层 + beam_search）。
        mode: 当前档位。
        trace: 对账日志回调（缺省静默）。
    """

    def __init__(
        self,
        legacy_run: Callable[[dict], dict],
        new_run: Optional[Callable[[dict], dict]] = None,
        mode: Optional[str] = None,
        trace: Optional[TraceLogger] = None,
    ) -> None:
        self.legacy_run = legacy_run
        self.new_run = new_run
        self.mode = mode or resolve_mode()
        if self.mode not in ROUTER_MODES:
            raise ContractError(f'非法档位注入: {self.mode!r}')
        self.trace = trace or (lambda _m: None)  # 缺省静默，不制造 I/O

    def run(self, req: dict) -> dict:
        """按档位分发执行一次匹配。

        档位行为（§8.5.2）：
          off     → 只跑旧引擎
          on      → 只跑新引擎（未注入新引擎时错误暴露，绝不静默回退）
          shadow  → 新旧都跑，新结果只留 trace，返回旧结果（A/B 对账仪器）

        Args:
            req: KMMatchReq / SegmentRequest（新引擎侧输入）。

        Returns:
            dict: 实际生效的求解结果。

        Raises:
            ContractError: on 档位未注入 new_run。
        """
        self.trace(f'[router] mode={self.mode}')

        if self.mode == ROUTER_MODE_OFF:
            return self.legacy_run(req)

        if self.mode == ROUTER_MODE_ON:
            if self.new_run is None:
                raise ContractError('档位 on 但未注入新引擎 new_run')
            return self.new_run(req)

        # shadow：新旧并行，只留日志。
        legacy = self.legacy_run(req)
        if self.new_run is not None:
            try:
                shadowed = self.new_run(req)
                self._log_shadow(req, legacy, shadowed)
            except Exception as exc:  # noqa: BLE001 —— shadow 容错，不影响线上
                self.trace(f'[router] shadow 新引擎失败(不影响线上): {exc}')
        return legacy

    def _log_shadow(self, req: dict, legacy: dict, shadowed: dict) -> None:
        """记录新旧结果逐句命中差异（shadow 对账仪器，ininherited no effect）。

        Args:
            req: 请求。
            legacy: 旧引擎结果（线上生效）。
            shadowed: 新引擎结果（仅留日志）。
        """
        # 统一提取“选中片段 id”：legacy 结果项键名是 chunkId（实测），
        # new 引擎结果项用 chunkData.id；chosenChunkId 为历史别名保留。仅影响 shadow 对账读取，
        # 不改任何求解结果，避免“字段名取错→新旧全空→false NEW-DROP”掩盖真实差异。
        def _pick(result: dict) -> str:
            for k in ('chunkId', 'chosenChunkId'):
                v = result.get(k)
                if v:
                    return str(v)
            cd = result.get('chunkData')
            if isinstance(cd, dict) and cd.get('id'):
                return str(cd['id'])
            return ''

        def hit_map(results: List[dict]) -> Dict[str, str]:
            return {r.get('shotId', ''): _pick(r) for r in (results or [])}

        lmap = hit_map(_extract_results(legacy))
        smap = hit_map(_extract_results(shadowed))
        for sid in sorted(set(lmap) | set(smap)):
            l, s = lmap.get(sid), smap.get(sid)
            mark = 'OK' if l == s else 'DIFF' if s else 'NEW-DROP'
            self.trace(f'[shadow] {sid}: legacy={l} new={s} → {mark}')

        # ===== 质量 gate 汇总（#9 达标判据，不改线上行为，只加统计 trace）=====
        # 判达标不能用“chunkId 完全一致”的 OK 率（新旧算法本就难裁同一帧），改看三组硬指标：
        #   ① 降级分布   ：new 每句 isDegraded/degradeKind（hard_relax/all_beam_death/正常）
        #   ② 段界连续性 ：按 new 结果的原序（叙事时序），相邻句父镜头 parentChunkId 相同率
        #                  = “不切镜率”（长镜头顺延）；chosenChunkId 相同 = 续镜复用。
        #   ③ 空段核对   ：legacy 留空但新引擎填充的句数（验收“旧7空段必0”的反面证据）。
        # 数据全取自已返回的 new 结果项，不反查求解过程，故与线上结果天然一致。
        new_items = _extract_results(shadowed) or []
        _degrade_kinds: Dict[str, int] = {}
        _normal = 0
        for _it in new_items:
            if _it.get('isDegraded'):
                _k = str(_it.get('degradeKind') or 'degraded')
                _degrade_kinds[_k] = _degrade_kinds.get(_k, 0) + 1
            else:
                _normal += 1
        _adj = 0
        _same_parent = 0
        _same_chunk = 0
        for _i in range(1, len(new_items)):
            _adj += 1
            _p1 = (_new_item_field(new_items[_i - 1], 'parentChunkId'))
            _p0 = (_new_item_field(new_items[_i], 'parentChunkId'))
            if _p1 and _p1 == _p0:
                _same_parent += 1
            if _new_item_field(new_items[_i - 1], 'id') and \
                    _new_item_field(new_items[_i - 1], 'id') == _new_item_field(new_items[_i], 'id'):
                _same_chunk += 1
        _legacy_infl = sum(
            1 for _sid in smap
            if _sid not in lmap or not lmap.get(_sid)
        )  # legacy 为空(new 却填了)的句数 → 空段被新引擎填充数。

        # ③ 顺延句成功率（新增细分指标，束搜索顺延失效的判定口径）：
        #   场景调度(shotMode)对某个句断言 CONTINUE_PREV 时，若上一镜有父镜头，则期望本句
        #   沿用同父切片（不切镜）。success = 断言顺延且实际同父的句占比；分母=顺延句总数。
        # req 可能是 pydantic KMMatchReq 或 dict，统一归一化后再读（pydantic 无 .get）。
        def _to_dict(obj):
            """把 pydantic 模型/字典归一化成 dict 读取字段。"""
            if hasattr(obj, 'model_dump'):
                return obj.model_dump()
            return obj

        _req_d = _to_dict(req)
        _q_mode: Dict[str, str] = {}
        for _q in (_req_d.get('queries') or []):
            _qd = _to_dict(_q)
            _q_mode[str(_qd.get('shotId'))] = str(_qd.get('shotMode') or '')
        _cont_total = 0
        _cont_hit = 0
        for _i in range(1, len(new_items)):
            _p1 = (_new_item_field(new_items[_i - 1], 'parentChunkId'))
            _p0 = (_new_item_field(new_items[_i], 'parentChunkId'))
            _sid_cur = str(new_items[_i].get('shotId') or '')
            if _p1 and _q_mode.get(_sid_cur) == 'CONTINUE_PREV':
                _cont_total += 1
                if _p1 == _p0:
                    _cont_hit += 1
        _cont_ratio = (100.0 * _cont_hit / _cont_total) if _cont_total else 0.0
        # 修正顺延口径（诊断揭示：异父且 within_time 挡住的 3 句是 7s 物理锁正确强切，非失败）。
        # 按「本该续且实际续上」评估：直接读引擎权威 `_cont_ok` 分类（eliminating 数组相邻
        #       读父误差——CONTINUE_PREV 句之间夹 NEW_SHOT，相邻项父 ≠ 语义上一镜父）。
        #   continued   =已续上
        #   same        =主解本已同父（非缺陷）
        #   time_lock   =7s 物理锁强切（非缺陷）
        #   limit_3     =连续触顶强切（非缺陷）
        #   fail        =该续未续（真失败）
        _ok_cont = {'continued', 'same', 'time_lock', 'limit_3', 'fail'}
        _cont_ok_hist: Dict[str, int] = {}
        for _it in new_items:
            _sid_c = str(_it.get('shotId') or '')
            if _q_mode.get(_sid_c) != 'CONTINUE_PREV':
                continue
            _okv = str(_it.get('_cont_ok') or '').strip()
            _okv = _okv if _okv in _ok_cont else 'fail'
            _cont_ok_hist[_okv] = _cont_ok_hist.get(_okv, 0) + 1
        _cont_success = _cont_ok_hist.get('continued', 0) + _cont_ok_hist.get('same', 0)
        _cont_true_total = _cont_ok_hist.get('continued', 0) + _cont_ok_hist.get('fail', 0)
        _cont_true_ratio = (100.0 * _cont_ok_hist.get('continued', 0) / _cont_true_total) \
            if _cont_true_total else 0.0
        _cont_fail = _cont_ok_hist.get('fail', 0)
        _cont_nondefect = _cont_ok_hist.get('time_lock', 0) + _cont_ok_hist.get('limit_3', 0) \
            + _cont_ok_hist.get('same', 0)
        # 汇总辅助变量（trace 引用，short/保留原语义）。
        _dd = {k: _degrade_kinds[k] for k in sorted(_degrade_kinds)}
        _dd_txt = str(_dd) if _dd else '无熔断'
        _ratio = (100.0 * _same_parent / _adj) if _adj else 0.0
        _mode_hist: Dict[str, int] = {}
        for _v in _q_mode.values():
            _mode_hist[_v] = _mode_hist.get(_v, 0) + 1
        _req_n = len(_q_mode)
        _new_pid_n = sum(
            1 for _it in new_items if _new_item_field(_it, 'parentChunkId')
        )  # 新结果里携带父镜头字段的句数（判据依赖的 _p1 非空前提）。
        self.trace(
            f'[shadow-summary] 句数={len(new_items)} '
            f'degrade(正常={_normal} {_dd_txt}) '
            f'连续率(同父镜头顺延)={_ratio:.1f}% ({_same_parent}/{_adj}) '
            f'顺延成功率(CONTINUE_PREV断言)={_cont_ratio:.1f}% ({_cont_hit}/{_cont_total}) '
            f'顺延真实成功率(该续续上率)={_cont_true_ratio:.1f}% ({_cont_ok_hist.get("continued", 0)}/{_cont_true_total}) '
            f'顺延成功(续上+本同父)={_cont_success} 顺延缺陷失败={_cont_fail} 非缺陷阻挡={_cont_nondefect} '
            f'顺延细分={_cont_ok_hist} '
            f'续镜复用={_same_chunk} 空段被新填(legacy空→new有值)={_legacy_infl} '
            f'[diag] req_queries={_req_n} mode_hist={_mode_hist} new_has_parent={_new_pid_n}/{len(new_items)}'
        )


def _new_item_field(item: dict, key: str) -> str:
    """取新引擎结果项上指定字段（优先读 chunkData 内嵌切片字段）。

    Args:
        item: 结果项（{shotId, chosenChunkId, chunkData, ...}）。
        key: 字段名（如 parentChunkId / shotScale / id）。

    Returns:
        str: 字段值；缺失返回空串。
    """
    v = item.get(key)
    if v is not None and v != '':
        return str(v)
    cd = item.get('chunkData')
    if isinstance(cd, dict) and cd.get(key):
        return str(cd[key])
    return ''


def _extract_results(payload: dict) -> List[dict]:
    """统一从新旧结果体里抽取 matchResults 列表（兼容多种返回包装）。

    Args:
        payload: 求解结果（可能 {matchResults: [...]} 或直接是列表等）。

    Returns:
        List[dict]: matchResults 列表。
    """
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        # legacy KM 返回 {"success", "results", "videoChunks"}，故补 'results' 键：
        #   K 域交付后首个真实接入点（#8）实测 legacy 顶层是 results 而非 matchResults，
        #   此处按本函数「兼容多种返回包装」的设计意图扩展，仅影响 shadow 对账，不改线上行为。
        for key in ('matchResults', 'results', 'data'):
            val = payload.get(key)
            if isinstance(val, list):
                return val
            if isinstance(val, dict) and isinstance(val.get('matchResults'), list):
                return val['matchResults']
    return []