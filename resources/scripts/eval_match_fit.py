# -*- coding: utf-8 -*-
"""eval_match_fit.py —— 验收线：文案 ↔ 画面贴合裁判（离线评测，不进生产管线）

【产品口径】给成片装一把"贴合度尺子"：每一句文案配上它**真正选中的那张画面**，交给多模态
模型打分 0~1。它是唯一可作采纳依据的判据 —— 步骤5 内部的语义/时长/情绪分属"算法给自己打分"，
用来证明算法变好等于自证（项目铁律：裁判必须端到端实测；人工标注底座已作废）。

【架构口径】
- 只读 `data/database/database.sqlite` → `projects.metadata`（只读 URI，读法同 `scripts/verify-step5.py`）
- 每句输入 = 文案 `text` + 画面意图 `visualIntent` + 命中切片封面图 `chunkData.coverPath`
  （base64 内嵌，**不抽帧**，零额外产出）
- 每句输出 = 强制结构化 JSON：`{fit, dims{subject,action,scene,emotion}, violation[], reason}`
- 产出 = `output/eval-match-fit-<tag>-<YYYYMMDD>.json`（逐句明细）+ 终端摘要
- 不写库、不改产物、不进生产管线

【凭据（重要）】**不能读 `ai_config.py`** —— 那是本机模型推断配置，无 LLM 凭据。VLM 凭据真源是
设置页「视觉」通道（Node 侧 `LLMFactory.getEffectiveConfig('visual')`），落盘经 DPAPI 加密 ⇒
离线 Python 读不到 ⇒ 必须**显式传入**：
  CLI：`--api-key / --base / --model`
  环境变量：`ZENTECT_EVAL_VLM_API_KEY / ZENTECT_EVAL_VLM_BASE / ZENTECT_EVAL_VLM_MODEL`
缺任一即打清晰错误并以退出码 2 结束。

【用法】
  resources\\ai-env\\python.exe -X utf8 resources\\scripts\\eval_match_fit.py --project proj_xxx --tag baseline
  冒烟（只判 2 句，省调用）：... --limit 2
  A/B 裁决（§6 采纳口径：均分上升 + 低分段不增 + 无新违反项）：
      ... --tag after-jiexian --compare output/eval-match-fit-baseline-20260927.json

【退出码】0 = 全部单位成功；1 = 有单位失败；2 = 参数/凭据/数据源错误。
"""
import argparse
import base64
import json
import os
import re
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

# 项目根：<root>/resources/scripts/eval_match_fit.py ⇒ 上溯三层
BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_DB = os.path.join(BASE_DIR, 'data', 'database', 'database.sqlite')
DEFAULT_OUT_DIR = os.path.join(BASE_DIR, 'output')
DEFAULT_PID = 'proj_1788878097336_nzcvrq'

# 版本：口径或打分协议一旦改动必须 bump（否则新旧分数混在一张表里不可比）。
# v2 = 「同输入多次采样取中位数」（见 --samples）：实测单次裁判有 ~1/8 概率跳变 0.2~0.55，
# 单次结果与 v1 不可直接比较，故 bump。
PROMPT_VERSION = 'fit-judge-v2'
DIMS = ('subject', 'action', 'scene', 'emotion')
LOW_FIT = 0.5           # 低分段阈值（采纳口径中的"低分段"）
BOTTOM_N = 5            # 摘要里报的最差句数

_MIME = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'}

PROMPT_TMPL = """你是影视成片审片员。下面给你一句**解说文案**，以及它**最终配上的那张画面**（截图）。
请判断画面与文案的贴合程度，严格按要求输出 JSON。

【文案】{text}
{intent}
【评分口径】
- fit：0~1 总贴合度。1 = 主体、动作、场景、情绪全部对上；0 = 完全无关。
- dims 四维各 0~1：
  subject = 主体是否同一个（人/物/数量），action = 动作是否一致，
  scene = 场景/地点是否一致，emotion = 情绪氛围是否一致。
- 若文案与画面存在**明确矛盾**（如：文案说两人重逢、画面只有一人；文案说递出机票、画面在吃饭），
  必须逐条写进 violation，不允许漏报。
- **必须先列 violation，再给分**；不要因为"画面好看"或"风格相近"就给高分。

【输出】只输出一个 JSON 对象，不要 markdown 围栏、不要任何多余文字：
{{"fit": 0.0, "dims": {{"subject": 0.0, "action": 0.0, "scene": 0.0, "emotion": 0.0}}, "violation": [], "reason": ""}}
"""


# ---------------------------------------------------------------- 数据读取（只读库）
def _resolve_cover(p):
    """封面图路径归位：绝对路径直用；相对路径按项目根拼；都取不到则原样返回（供报错）。"""
    s = str(p or '').strip()
    if not s:
        return ''
    if os.path.isabs(s):
        return s
    cand = os.path.join(BASE_DIR, s.replace('/', os.sep))
    return cand


def _load_units(project_id, db_path):
    """读 `projects.metadata`，把 `matchResults` 与 `scriptParagraphs` 按 matchUnitId 对齐成评测单位。

    对齐口径同 `scripts/verify-step5.py`：key = matchUnitId（缺失则回退 matchResult 自身 id/shotId）。
    """
    uri = 'file:' + db_path.replace(os.sep, '/') + '?mode=ro'
    conn = sqlite3.connect(uri, uri=True)
    try:
        row = conn.execute('SELECT metadata FROM projects WHERE id=?', (project_id,)).fetchone()
    finally:
        conn.close()
    if not row or not row[0]:
        print('❌ 项目不存在或无 metadata：{}（--project/--db 传错？）'.format(project_id))
        sys.exit(2)
    md = json.loads(row[0])

    by_id = {}
    for p in (md.get('scriptParagraphs') or []):
        for k in (str(p.get('id') or ''), str(p.get('shotId') or '')):
            if k:
                by_id.setdefault(k, p)

    units = []
    for m in (md.get('matchResults') or []):
        sid = str(m.get('id') or m.get('shotId') or '')
        key = str(m.get('matchUnitId') or '').strip() or sid
        p = by_id.get(key) or by_id.get(sid) or {}
        chunk = m.get('chunkData') or {}
        units.append({
            'matchUnitId': key,
            'shotId': sid,
            'chunkId': str(chunk.get('id') or ''),
            'text': str(p.get('text') or m.get('text') or '').strip(),
            'visualIntent': str(p.get('visualIntent') or '').strip(),
            'coverPath': _resolve_cover(chunk.get('coverPath')),
            'startMs': chunk.get('startMs'),
            'endMs': chunk.get('endMs'),
        })
    return md, units


def _load_units_from_json(path):
    """从既有产出 JSON 重建评测单位。

    用途：库内 `matchResults` 已被覆盖后，仍能对**历史那一次选片结果**按当前协议重打分
    （封面图按源切片命名、内容稳定，故可复用），从而保证 A/B 两侧走同一套打分协议。
    """
    with open(path, encoding='utf-8') as f:
        doc = json.load(f)
    units = []
    for u in doc.get('units', []):
        if not u.get('text') or not u.get('coverPath'):
            continue
        units.append({
            'matchUnitId': u.get('matchUnitId', ''),
            'shotId': u.get('shotId', ''),
            'chunkId': u.get('chunkId', ''),
            'text': u['text'],
            'visualIntent': u.get('visualIntent', ''),
            'coverPath': u['coverPath'],
            'startMs': u.get('startMs'),
            'endMs': u.get('endMs'),
        })
    print('▶ 从既有产出重建：{}（{} 个单位）'.format(path, len(units)))
    return units


# ---------------------------------------------------------------- 打分（VLM 调用）
def _median(vals):
    """中位数（忽略 None）。空集返回 None。"""
    vals = sorted(v for v in vals if v is not None)
    if not vals:
        return None
    m = len(vals) // 2
    return round(vals[m] if len(vals) % 2 else (vals[m - 1] + vals[m]) / 2, 4)


def _score_n(unit, cfg):
    """判一句：同一输入跑 `cfg['samples']` 次，取中位数。

    为什么：实测单次裁判对**逐字节相同**的输入仍有 ~1/8 概率跳变 0.2~0.55（σ≈0.19），
    3 次取中位数把 SE 从 0.19 压到 ~0.11。violation/reason 取「fit 等于中位数」那一次，
    保证文字与分数自洽；多次结果并存于 `fits` 便于审计离散度。
    """
    n = max(1, int(cfg.get('samples') or 1))
    if n == 1:
        return _score_one(unit, cfg)

    oks, errs = [], []
    for _ in range(n):
        ok, payload = _score_one(unit, cfg)
        (oks if ok else errs).append(payload)
    if not oks:
        return False, errs[-1] if errs else '全部采样失败'

    fit = _median([p['fit'] for p in oks])
    rep = min(oks, key=lambda p: abs(p['fit'] - fit))
    return True, {
        'fit': fit,
        'dims': {d: _median([p['dims'].get(d) for p in oks]) for d in DIMS},
        'violation': rep['violation'],
        'reason': rep['reason'],
        'fits': [p['fit'] for p in oks],
        'nOk': len(oks),
    }


def _norm_score(v):
    """把模型给的值收敛成 [0,1] 的 float；不可解析返回 None（不臆造）。"""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, str):
        m = re.search(r'-?\d+(?:\.\d+)?', v)
        if not m:
            return None
        v = m.group()
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return max(0.0, min(1.0, f))


def _parse_judgement(raw):
    """从模型回复里抽出结构化判定；解析失败抛 ValueError（不静默兜底，避免污染均分）。"""
    s = str(raw or '').strip()
    s = re.sub(r'^```(?:json)?\s*|\s*```$', '', s, flags=re.M).strip()
    i, j = s.find('{'), s.rfind('}')
    if i < 0 or j <= i:
        raise ValueError('未找到 JSON 对象：{}'.format(s[:80]))
    obj = json.loads(s[i:j + 1])

    fit = _norm_score(obj.get('fit'))
    if fit is None:
        raise ValueError('响应缺少可解析的 fit：{}'.format(s[:80]))

    raw_dims = obj.get('dims') if isinstance(obj.get('dims'), dict) else {}
    dims = {d: _norm_score(raw_dims.get(d)) for d in DIMS}

    viol = obj.get('violation')
    if isinstance(viol, str):
        viol = [viol]
    if not isinstance(viol, list):
        viol = []
    viol = [str(v).strip() for v in viol if str(v).strip()]

    return {
        'fit': fit,
        'dims': dims,
        'violation': viol,
        'reason': str(obj.get('reason') or '').strip(),
    }


def _post_chat(api_base, api_key, model, content, timeout):
    """OpenAI 兼容 `/chat/completions` 单次调用（协议与 `timeline_solver._call_vlm_rerank` 一致）。"""
    import requests
    url = api_base.rstrip('/') + '/chat/completions'
    payload = {
        'model': model,
        'messages': [{'role': 'user', 'content': content}],
        'temperature': 0.1,
        'max_tokens': 400,
    }
    headers = {'Authorization': 'Bearer {}'.format(api_key), 'Content-Type': 'application/json'}
    resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
    resp.raise_for_status()
    body = resp.json()
    return (body.get('choices') or [{}])[0].get('message', {}).get('content', '')


def _score_one(unit, cfg):
    """判一句：封面图缺失即失败（绝不"无图猜分"，否则分数不可信）。返回 (ok, payload_or_error)。"""
    if not unit['text']:
        return False, '文案缺失'
    cover = unit['coverPath']
    if not cover or not os.path.exists(cover):
        return False, '封面图缺失/不可读：{}'.format(cover or '(空)')

    intent = ('【画面意图（编剧标注，仅供参考，缺失即忽略）】{}\n'.format(unit['visualIntent'])
              if unit['visualIntent'] else '')
    prompt = PROMPT_TMPL.format(text=unit['text'], intent=intent)

    try:
        with open(cover, 'rb') as f:
            b64 = base64.b64encode(f.read()).decode('utf-8')
        mime = _MIME.get(os.path.splitext(cover)[1].lower(), 'image/jpeg')
        content = [
            {'type': 'text', 'text': prompt},
            {'type': 'image_url', 'image_url': {'url': 'data:{};base64,{}'.format(mime, b64)}},
        ]
        last = None
        for _ in range(cfg['retries'] + 1):
            try:
                raw = _post_chat(cfg['base'], cfg['key'], cfg['model'], content, cfg['timeout'])
                return True, _parse_judgement(raw)
            except Exception as e:  # noqa: BLE001 —— 网络/解析/鉴权统一重试一次后上报
                last = e
                time.sleep(1.0)
        return False, '{}: {}'.format(type(last).__name__, last)
    except Exception as e:  # noqa: BLE001
        return False, '{}: {}'.format(type(e).__name__, e)


# ---------------------------------------------------------------- 汇总与裁决
def _aggregate(units, tag, project_id, db_path, cfg):
    ok = [u for u in units if u.get('ok')]
    bad = [u for u in units if not u.get('ok')]

    def _mean(vals):
        vals = [v for v in vals if v is not None]
        return round(sum(vals) / len(vals), 4) if vals else None

    low = sorted([u for u in ok if u['fit'] < LOW_FIT], key=lambda u: u['fit'])
    bottom = sorted(ok, key=lambda u: u['fit'])[:BOTTOM_N]
    viol_units = [u for u in ok if u['violation']]

    return {
        'meta': {
            'project': project_id,
            'db': db_path,
            'tag': tag,
            'promptVersion': PROMPT_VERSION,
            'model': cfg['model'],
            'samples': cfg.get('samples') or 1,
            'generatedAt': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'total': len(units),
            'ok': len(ok),
            'failed': len(bad),
            'meanFit': _mean([u['fit'] for u in ok]),
            'dimsMean': {d: _mean([u['dims'].get(d) for u in ok]) for d in DIMS},
            'fitUnderHalf': len(low),
            'lowUnits': [u['matchUnitId'] for u in low],
            'violationUnits': len(viol_units),
            'bottomUnits': [u['matchUnitId'] for u in bottom],
        },
        'units': units,
        'failed': [{'matchUnitId': u['matchUnitId'], 'error': u.get('error')} for u in bad],
    }


def _print_summary(doc):
    m = doc['meta']
    print('')
    print('═' * 68)
    print('▶ 项目：{} ｜ 单位={} ｜ 成功={} ｜ 失败={}'.format(
        m['project'], m['total'], m['ok'], m['failed']))
    print('均分 fit = {}（{} ｜ model={} ｜ 采样 {} 次取中位数）'.format(
        m['meanFit'], m['promptVersion'], m['model'], m.get('samples', 1)))
    dm = m['dimsMean']
    print('分维均分：' + ' / '.join('{}={}'.format(d, dm[d]) for d in DIMS))
    print('fit<{} 段数 = {}{}'.format(
        LOW_FIT, m['fitUnderHalf'],
        '：' + ', '.join(m['lowUnits'][:8]) if m['lowUnits'] else ''))
    print('含违反项的段数 = {}'.format(m['violationUnits']))
    print('最低 {} 句：'.format(BOTTOM_N))
    for u in sorted([u for u in doc['units'] if u.get('ok')], key=lambda u: u['fit'])[:BOTTOM_N]:
        print('  - {:<22} fit={:<6} {}{}'.format(
            u['matchUnitId'], u['fit'],
            u['reason'][:60],
            ' ｜违反: ' + '; '.join(u['violation'])[:80] if u['violation'] else ''))
    if doc['failed']:
        print('失败单位：')
        for f in doc['failed'][:10]:
            print('  - {:<22} {}'.format(f['matchUnitId'], f['error']))


def _compare(doc, base_path):
    """按 §6 采纳口径裁决：均分上升 + 低分段不增 + 无新违反项。"""
    try:
        with open(base_path, encoding='utf-8') as f:
            base = json.load(f)
    except Exception as e:  # noqa: BLE001
        print('⚠️ 基线文件不可读，跳过对照：{}（{}）'.format(base_path, e))
        return None

    bm, cm = base.get('meta', {}), doc['meta']
    b_units = {u['matchUnitId']: u for u in base.get('units', []) if u.get('ok')}
    c_units = {u['matchUnitId']: u for u in doc['units'] if u.get('ok')}

    b_low = {k for k, u in b_units.items() if u['fit'] is not None and u['fit'] < LOW_FIT}
    c_low = {k for k, u in c_units.items() if u['fit'] is not None and u['fit'] < LOW_FIT}
    new_viol = [k for k, u in c_units.items()
                if len(u.get('violation') or []) > len((b_units.get(k) or {}).get('violation') or [])]
    b_bottom = set((bm.get('bottomUnits') or [])[:BOTTOM_N])
    c_bottom = set((cm.get('bottomUnits') or [])[:BOTTOM_N])

    # ⑤ 差异显著性（仅供参考，不参与裁决）：逐句差值算 t 值。
    # 判分协议变更使单次结果含 ~0.19 的裁判噪声，均分差若小于噪声标准误即不可分辨。
    deltas = [c_units[k]['fit'] - b_units[k]['fit']
              for k in c_units
              if k in b_units and c_units[k]['fit'] is not None and b_units[k]['fit'] is not None]
    delta_mean = delta_se = delta_t = None
    if len(deltas) > 1:
        delta_mean = sum(deltas) / len(deltas)
        var = sum((x - delta_mean) ** 2 for x in deltas) / (len(deltas) - 1)
        delta_se = var ** 0.5 / len(deltas) ** 0.5
        delta_t = delta_mean / delta_se if delta_se else 0.0

    up = (bm.get('meanFit') is not None and cm.get('meanFit') is not None
          and cm['meanFit'] > bm['meanFit'])
    low_ok = len(c_low) <= len(b_low)
    viol_ok = not new_viol
    adopted = up and low_ok and viol_ok

    print('')
    print('─' * 68)
    print('▶ A/B 对照：{} ↔ {}'.format(base_path, cm['tag']))
    print('  ① 均分：{} → {}  {}'.format(
        bm.get('meanFit'), cm.get('meanFit'), '✅ 上升' if up else '⚠️ 未上升'))
    print('  ② fit<{} 段数：{} → {}  {}'.format(
        LOW_FIT, len(b_low), len(c_low), '✅ 未增加' if low_ok else '⚠️ 增加'))
    print('  ③ 新出现违反项的段：{} 个  {}'.format(
        len(new_viol), '✅ 无' if viol_ok else '⚠️ ' + ', '.join(new_viol[:6])))
    print('  ④ 最低 {} 句换人：{}/{}'.format(BOTTOM_N, len(c_bottom - b_bottom), BOTTOM_N))
    if delta_t is not None:
        print('  ⑤ 均值差 {:+.4f} ｜ 标准误 {:.4f} ｜ t={:.2f}  ⇒ {}（|t|>=2 才算可分辨；仅供参考，不改裁决）'.format(
            delta_mean, delta_se, delta_t,
            '差异可分辨' if abs(delta_t) >= 2 else '落在噪声内，不可分辨'))
    print('  裁决：{}'.format(
        '✅ 采纳（三项全满足）' if adopted else '⛔ 不满足采纳口径 ⇒ 回退，不进主干'))
    return adopted


# ---------------------------------------------------------------- 入口
def _build_cfg(args):
    key = args.api_key or os.environ.get('ZENTECT_EVAL_VLM_API_KEY') or ''
    base = args.base or os.environ.get('ZENTECT_EVAL_VLM_BASE') or ''
    model = args.model or os.environ.get('ZENTECT_EVAL_VLM_MODEL') or ''
    if not (key and base and model):
        print('❌ 缺少视觉通道凭据（三者缺一不可）：api-key={} base={} model={}'.format(
            bool(key), bool(base), bool(model)))
        print('   离线脚本读不到设置页里 DPAPI 加密的凭据，必须显式传入：')
        print('   --api-key/--base/--model  或  环境变量 '
              'ZENTECT_EVAL_VLM_API_KEY / ZENTECT_EVAL_VLM_BASE / ZENTECT_EVAL_VLM_MODEL')
        sys.exit(2)
    return {
        'key': key, 'base': base, 'model': model,
        'timeout': args.timeout, 'retries': args.retries,
        'samples': max(1, int(args.samples or 1)),
    }


def main():
    ap = argparse.ArgumentParser(description='验收线：文案 ↔ 画面贴合裁判（离线，不进生产管线）')
    ap.add_argument('--project', default=DEFAULT_PID, help='项目 id（默认：历史基线项目）')
    ap.add_argument('--db', default=DEFAULT_DB, help='SQLite 路径（默认 data/database/database.sqlite）')
    ap.add_argument('--tag', default='run', help='本次标签，仅用于产出文件名与对照显示（如 baseline / after-x）')
    ap.add_argument('--out-dir', default=DEFAULT_OUT_DIR, help='产出目录（默认 <root>/output）')
    ap.add_argument('--api-key', default='', help='视觉通道 API Key（缺省读环境变量）')
    ap.add_argument('--base', default='', help='视觉通道接口地址（缺省读环境变量）')
    ap.add_argument('--model', default='', help='视觉通道模型名（缺省读环境变量）')
    ap.add_argument('--workers', type=int, default=4, help='并发数（默认 4）')
    ap.add_argument('--timeout', type=float, default=90.0, help='单次调用超时秒（默认 90）')
    ap.add_argument('--retries', type=int, default=1, help='单句失败重试次数（默认 1）')
    ap.add_argument('--limit', type=int, default=0, help='只判前 N 句（冒烟用，0=全量）')
    ap.add_argument('--compare', default='', help='与既有产出对照并按采纳口径裁决（传基线 json 路径）')
    ap.add_argument('--samples', type=int, default=1, help='每句采样次数，取中位数（压裁判噪声，推荐 3）')
    ap.add_argument('--from-json', default='', help='改从既有产出 JSON 重建单位（对历史选片结果按当前协议重打分）')
    args = ap.parse_args()

    cfg = _build_cfg(args)
    print('▶ 读取数据：{} / {}'.format(args.db, args.project))
    if args.from_json:
        units = _load_units_from_json(args.from_json)
    else:
        _, units = _load_units(args.project, args.db)
    if args.limit > 0:
        units = units[:args.limit]
    if not units:
        print('❌ 该项目没有任何 matchResults，无从裁判（先跑步骤5）')
        sys.exit(2)
    cover_ok = sum(1 for u in units if u['coverPath'] and os.path.exists(u['coverPath']))
    print('▶ 评测单位 {} 个 ｜ 封面图可用 {}/{} ｜ 并发 {} ｜ 采样 {} 次取中位数 ｜ {}'.format(
        len(units), cover_ok, len(units), args.workers, cfg['samples'], PROMPT_VERSION))

    def _run(u):
        ok, payload = _score_n(u, cfg)
        u['ok'] = ok
        if ok:
            u.update(payload)
        else:
            u['error'] = payload
        return u

    # 首句单跑做前置校验：凭据/地址错时立即止损，不白烧 N 次调用
    first = _run(units[0])
    print('  [1/{}] {:<22} {}'.format(
        len(units), first['matchUnitId'],
        'fit={}'.format(first['fit']) if first.get('ok') else '❌ ' + str(first.get('error'))[:70]))
    if not first.get('ok') and len(units) > 1:
        print('❌ 首句即失败 ⇒ 判定为凭据/地址/网络问题，已中止（避免继续消耗调用额度）')
        print('   失败原因：{}'.format(first.get('error')))
        sys.exit(1)

    done = 1
    if len(units) > 1:
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futs = {pool.submit(_run, u): u for u in units[1:]}
            for fut in as_completed(futs):
                u = fut.result()
                done += 1
                print('  [{}/{}] {:<22} {}'.format(
                    done, len(units), u['matchUnitId'],
                    'fit={}'.format(u['fit']) if u.get('ok') else '❌ ' + str(u.get('error'))[:70]))

    doc = _aggregate(units, args.tag, args.project, args.db, cfg)
    os.makedirs(args.out_dir, exist_ok=True)
    safe_tag = re.sub(r'[^0-9A-Za-z_\-]', '_', args.tag) or 'run'
    out_path = os.path.join(args.out_dir, 'eval-match-fit-{}-{}.json'.format(
        safe_tag, datetime.now().strftime('%Y%m%d')))
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)

    _print_summary(doc)
    print('')
    print('产出：{}'.format(out_path))
    if args.compare:
        _compare(doc, args.compare)

    return 1 if doc['meta']['failed'] else 0


if __name__ == '__main__':
    sys.exit(main())