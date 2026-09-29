"""
test_vlm_rerank.py — 🔬 跨模态重排（新引擎版）单测

覆盖四件事：
  1. 档位/上限/模型解析（off/dry/on + 非法回退；MAX 缺省 0=不限；模型缺省 plus、可 env 覆写）
  2. `_parse_vlm_pick` 解析健壮性（围栏/夹废话/截断 JSON/全 0 占位/无 scores/越界标签）
  3. `_build_vlm_slate` 候选盘纯函数（语义降序 / 排他 / 父封面兜底 / 无图剔除 / 同封面去重 / 截断）
  4. `_apply_vlm_rerank_new_engine` 端到端（off 不动 / dry 只记日志 / on 真换片且零重复用片 /
     凭据缺失跳过）+ 调用熔断的「连续失败、成功清零」语义

不触网：HTTP 一律用假 `requests.post` 顶替；封面用临时文件占位（只判存在性，不读内容）。

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe __tests__\\test_vlm_rerank.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import timeline_solver as ts


# ---------------------------------------------------------------- 夹具
class _FakeCtx:
    """最小 ctx：只需 queries / cands_by_shotid / chunk_by_id 三件。"""

    def __init__(self, queries, cands, chunks):
        self.queries = queries
        self.cands_by_shotid = cands
        self.chunk_by_id = chunks


def _mk_covers(n):
    """造 n 个临时封面文件，返回路径列表（内容不参与判定，只判 os.path.exists）。"""
    d = tempfile.mkdtemp(prefix='vlmrr_')
    out = []
    for i in range(n):
        p = os.path.join(d, 'c{}.jpg'.format(i))
        with open(p, 'wb') as f:
            f.write(b'\xff\xd8\xff\xd9')
        out.append(p)
    return out


def _env(**kw):
    """临时设置/清除 env（None = 删除），返回还原函数。"""
    old = {k: os.environ.get(k) for k in kw}
    for k, v in kw.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

    def restore():
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    return restore


# ---------------------------------------------------------------- 1) 档位解析
def test_mode_and_max():
    r = _env(ZENTECT_VLM_RERANK=None, ZENTECT_VLM_RERANK_MAX=None, ZENTECT_VLM_RERANK_MODEL=None)
    try:
        assert ts._read_vlm_rerank_mode() == 'off', '缺省必须是 off（零行为变化）'
        assert ts._read_vlm_rerank_max() == 0, '缺省 MAX=0 表示不限'
        assert ts._read_vlm_rerank_model() == 'qwen3-vl-plus', '缺省模型必须是 plus（视觉通道 flash 实测不合格）'

        for raw, want in (('on', 'on'), (' DRY ', 'dry'), ('off', 'off'),
                          ('bogus', 'off'), ('', 'off'), ('ON', 'on')):
            os.environ['ZENTECT_VLM_RERANK'] = raw
            assert ts._read_vlm_rerank_mode() == want, '档位解析错: {!r}'.format(raw)

        for raw, want in (('5', 5), ('0', 0), ('', 0), ('abc', 0), ('-3', 0)):
            os.environ['ZENTECT_VLM_RERANK_MAX'] = raw
            assert ts._read_vlm_rerank_max() == want, 'MAX 解析错: {!r}'.format(raw)

        os.environ['ZENTECT_VLM_RERANK_MODEL'] = ' qwen3-vl-flash '
        assert ts._read_vlm_rerank_model() == 'qwen3-vl-flash', '模型名应可 env 覆写（供 A/B）'
    finally:
        r()
    print('  ✅ 档位/上限/模型解析')


# ---------------------------------------------------------------- 2) 解析健壮性
def test_parse_vlm_pick():
    """口径 = `scores` 的 argmax（对齐离线实验），但 `best` 自述「无」时一票否决；
    全 0/缺失/解析失败一律 None。"""
    labels = ['C{:02d}'.format(i + 1) for i in range(12)]
    cases = [
        # (响应, 期望下标)
        ('{"scores": {"C01": 0.1, "C02": 0.2, "C03": 0.9, "C04": 0.3}}', 2),
        ('```json\n{"scores": {"C12": 0.7, "C01": 0.1}}\n```', 11),          # 围栏 + 乱序
        ('好的：{"scores": {"C05": 0.6}, "best": "C03"}', 4),                 # 以 scores 为准，不看 best
        ('{"scores": {"C01": 0.0, "C02": 0.0, "C03": 0.0}}', None),          # 全 0 占位模板 ⇒ 不选
        ('{"scores": {"C03": 0.2, "C08": 0.1}, "best": "无"}', None),        # 自述「无」⇒ 否决（哪怕有噪声分）
        ('{"scores": {"C03": 0.2}, "best": " 无。 "}', None),                 # 「无」的变体/空白同样否决
        ('{"scores": {"C03": 0.2}, "best": "无。但也有"}', 2),                # 非纯「无」⇒ 不误杀
        ('{"best": "C03", "reason": "x"}', None),                            # 无 scores ⇒ 不选
        ('{"scores": {"C99": 0.9}}', None),                                  # 越界标签 ⇒ 不选
        ('{"scores": {"C01": 0.5, "C02": "bad"}}', 0),                       # 非数值忽略，取唯一正值
        ('{"scores": {"C01": -0.3, "C02": -0.1}}', None),                    # 全负 ⇒ 不选
        ('{"scores": {"C02": 0.5, "C01": 0.5}}', 0),                         # 并列取先出现（严格 >）
        ('{"scores": {"C01": 0.9}', None),                                   # 截断 JSON ⇒ 不猜
        ('完全不是 JSON，best 是 C05', None),                                  # 无 JSON 块 ⇒ 不猜
        ('', None),
    ]
    for raw, want in cases:
        got = ts._parse_vlm_pick(raw, labels)
        assert got == want, '解析错: {!r} → {}（期望 {}）'.format(raw, got, want)
    print('  ✅ _parse_vlm_pick 健壮性（{} 例）'.format(len(cases)))


# ---------------------------------------------------------------- 3) 候选盘
def test_build_vlm_slate():
    covers = _mk_covers(6)
    chunks = {
        'a': {'id': 'a', 'coverPath': covers[0]},
        'b': {'id': 'b', 'coverPath': covers[1]},
        'c': {'id': 'c', 'coverPath': '', 'parentCoverPath': covers[2]},   # 非首段：靠父封面兜底
        'd': {'id': 'd', 'coverPath': '', 'parentCoverPath': ''},          # 无图 → 剔除
        'e': {'id': 'e', 'coverPath': covers[0]},                          # 与 a 同封面 → 去重
        'f': {'id': 'f', 'coverPath': covers[3]},
        'z': {'id': 'z', 'coverPath': covers[4]},
    }
    sem = {'a': 0.1, 'b': 0.9, 'c': 0.5, 'd': 0.99, 'e': 0.8, 'f': 0.3, 'z': 0.7}

    # ① 语义降序 + 父封面兜底 + 无图剔除 + 同封面去重
    got = [x[0] for x in ts._build_vlm_slate(['a', 'b', 'c', 'd', 'e', 'f'], chunks, sem, set(), '')]
    assert got == ['b', 'e', 'c', 'f'], got
    assert 'd' not in got, '无封面候选必须剔除'
    assert 'a' not in got, '同封面（a/e 共用 covers[0]）应只留语义高的 e'
    assert got[0] == 'b', '语义最高应排第一'
    assert covers[2] in [x[1] for x in ts._build_vlm_slate(['b', 'c'], chunks, sem, set(), '')], \
        '非首段应靠 parentCoverPath 兜底进盘'

    # ② 排他：b 已被他人占用 → 剔除；但本句当前片即使是它，也要保留
    got2 = [x[0] for x in ts._build_vlm_slate(['a', 'b', 'c', 'f'], chunks, sem, {'b'}, '')]
    assert 'b' not in got2, '被他人占用的片必须剔除'
    got3 = [x[0] for x in ts._build_vlm_slate(['a', 'b', 'c', 'f'], chunks, sem, {'b'}, 'b')]
    assert 'b' in got3, '本句当前片应保留在盘（作为"保持原样"的参照）'

    # ③ 截断 top_k
    got4 = ts._build_vlm_slate(['a', 'b', 'c', 'f', 'z', 'e'], chunks, sem, set(), '', top_k=2)
    assert len(got4) == 2, got4

    # ④ 候选 id 不在资产索引中 → 跳过（不抛）
    got5 = [x[0] for x in ts._build_vlm_slate(['a', 'nonexist'], chunks, sem, set(), '')]
    assert got5 == ['a'], got5

    # ⑤ 空候选 → 空盘
    assert ts._build_vlm_slate([], chunks, sem, set(), '') == []

    # ⑥ 覆盖约束（选项A）：供不起的候选不进盘（b/c 语义更高但只供 300ms < 阈值 1000ms）
    got6 = [x[0] for x in ts._build_vlm_slate(
        ['a', 'b', 'c'], chunks, sem, set(), '',
        supply_by_id={'a': 5000.0, 'b': 300.0, 'c': 300.0}, min_cover_ms=1000.0)]
    assert got6 == ['a'], '供不起的候选必须剔除: {}'.format(got6)
    # 缺读数 ⇒ 回退自身时长（f 无 durationMs/startMs ⇒ 0 ⇒ 供不起 ⇒ 剔除）
    got7 = [x[0] for x in ts._build_vlm_slate(
        ['a', 'f'], chunks, sem, set(), '', supply_by_id={'a': 5000.0}, min_cover_ms=1000.0)]
    assert got7 == ['a'], got7
    # 未给 supply_by_id ⇒ 不裁（零行为变化）
    got8 = [x[0] for x in ts._build_vlm_slate(
        ['a', 'b'], chunks, sem, set(), '', min_cover_ms=1000.0)]
    assert got8 == ['b', 'a'], '未给 supply_by_id 不得裁剪: {}'.format(got8)
    print('  ✅ _build_vlm_slate（降序/排他/兜底/去重/截断/覆盖约束）')


# ---------------------------------------------------------------- 4) 端到端
class _PostOk:
    """假 requests.post：给指定编号打高分（其余 0），模拟重排器的 scores 输出。"""

    def __init__(self, pick='C02'):
        self.pick = pick
        self.calls = 0

    def __call__(self, url, json=None, headers=None, timeout=None):
        self.calls += 1
        _r = self
        body = '{"scores": {"%s": 0.9}, "reason": "x"}' % _r.pick   # 仅命中编号为正分

        class _Resp:
            def raise_for_status(self):
                pass

            def json(self):
                return {'choices': [{'message': {'content': body}}],
                        'usage': {'prompt_tokens': 1234, 'completion_tokens': 56}}
        return _Resp()


def _apply(scenario, monkeypatch_post=None, creds=True, **envkw):
    """在指定 env 下跑一次 _apply_vlm_rerank_new_engine，返回 (solved, traces, chunks)。"""
    covers = _mk_covers(4)
    chunks = {
        'p0': {'id': 'p0', 'coverPath': covers[0], 'startMs': 0, 'endMs': 1000},
        'p1': {'id': 'p1', 'coverPath': covers[1], 'startMs': 1000, 'endMs': 2000},
        'p2': {'id': 'p2', 'coverPath': covers[2], 'startMs': 2000, 'endMs': 3000},
        'p3': {'id': 'p3', 'coverPath': covers[3], 'startMs': 3000, 'endMs': 4000},
    }
    queries = [{'shotId': 's1', 'text': '文案一', 'visualIntent': ''},
               {'shotId': 's2', 'text': '文案二', 'visualIntent': '意图二'}]
    cands = {'s1': ['p0', 'p1', 'p2'], 's2': ['p0', 'p1', 'p3']}
    sem = {'s1': {'p0': 0.1, 'p1': 0.9, 'p2': 0.5}, 's2': {'p0': 0.2, 'p1': 0.3, 'p3': 0.8}}
    ctx = _FakeCtx(queries, cands, chunks)
    solved = {'s1': {'chunkData': dict(chunks['p0']), 'chunkId': 'p0', 'confidence': 0.7},
              's2': {'chunkData': dict(chunks['p1']), 'chunkId': 'p1', 'confidence': 0.7}}
    req = type('Req', (), {
        'vlmApiKey': 'k' if creds else '',
        'vlmApiBase': 'http://x/v1' if creds else '',
        'vlmApiModel': 'm' if creds else '',
    })()

    traces = []
    old_trace, old_pick = ts._append_engine_trace, ts._call_vlm_pick
    ts._append_engine_trace = traces.append
    ts._VLM_RR_FAIL_COUNT = 0
    if monkeypatch_post is not None:
        import requests
        old_post = requests.post
        requests.post = monkeypatch_post
    else:
        old_post = None
    r = _env(**envkw)
    try:
        out = ts._apply_vlm_rerank_new_engine(solved, ctx, sem, req)
    finally:
        r()
        ts._append_engine_trace, ts._call_vlm_pick = old_trace, old_pick
        if old_post is not None:
            import requests
            requests.post = old_post
    return out, traces, chunks


def test_apply_end_to_end():
    # ① off：完全不进函数（外层已门控），此处只验返回原对象
    out, traces, _ = _apply('off', ZENTECT_VLM_RERANK='off')
    assert out['s1']['chunkData']['id'] == 'p0' and not traces

    # ② dry：只记日志，绝不改 solved（scores 命中盘内首项，本会换成 p2/p3）
    out, traces, _ = _apply('dry', monkeypatch_post=_PostOk('C01'), ZENTECT_VLM_RERANK='dry')
    assert out['s1']['chunkData']['id'] == 'p0', 'dry 档不得改选片'
    assert any('⇒' in t for t in traces), traces

    # ③ on：真换片（scores 命中 C01 → 盘内首项：s1=p2、s2=p3），且**零重复用片**
    out, traces, _ = _apply('on', monkeypatch_post=_PostOk('C01'), ZENTECT_VLM_RERANK='on')
    ids = [out['s1']['chunkData']['id'], out['s2']['chunkData']['id']]
    assert out['s1']['chunkData']['id'] == 'p2', out['s1']['chunkData']['id']
    assert out['s2']['chunkData']['id'] == 'p3', out['s2']['chunkData']['id']
    assert out['s1'].get('vlmReranked') is True
    assert out['s1'].get('chunkId') == 'p2', 'chunkId 必须与 chunkData.id 同步'
    assert len(set(ids)) == len(ids), '排他被破坏：出现重复用片 {}'.format(ids)

    # ④ 凭据不全 → 直接跳过（不发请求、不改 solved）
    out, traces, _ = _apply('nocreds', monkeypatch_post=_PostOk('C01'), creds=False,
                            ZENTECT_VLM_RERANK='on')
    assert out['s1']['chunkData']['id'] == 'p0'
    assert any('凭据' in t for t in traces), traces
    print('  ✅ _apply_vlm_rerank_new_engine（off/dry/on/无凭据 + 零重复用片）')


def test_supply_cover_constraint():
    """选项A：重排只能在「可供给时长 ≥ 本句配音时长」的候选里挑画面。

    对照（同一 solved / 同一 VLM 回复）：
      ① 口径 off ⇒ 不裁 ⇒ 盘首项 = 语义最高但供不起的 q3 = 当前片 ⇒ 保持不动；
      ② 口径 on  ⇒ q3（供 1000ms < 配音 1500ms）被剔出盘 ⇒ 只能换到供得起的 q2。
    母块 P 四段连续（q0..q3）⇒ 可供给时长 q0=4000 / q1=3000 / q2=2000 / q3=1000ms。
    """
    import requests
    covs = _mk_covers(4)
    ch = {}
    for i, (cid, st) in enumerate((('q0', 0), ('q1', 1000), ('q2', 2000), ('q3', 3000))):
        ch[cid] = {'id': cid, 'coverPath': covs[i], 'parentChunkId': 'P',
                   'filePath': 'f.mp4', 'startMs': st, 'endMs': st + 1000}
    queries = [{'shotId': 's1', 'text': '一', 'visualIntent': '', 'audioDurationMs': 1500}]
    ctx = _FakeCtx(queries, {'s1': ['q3', 'q2', 'q1']}, ch)
    sem = {'s1': {'q3': 0.9, 'q2': 0.5, 'q1': 0.3}}      # 语义最高的是供不起的 q3
    req = type('Req', (), {'vlmApiKey': 'k', 'vlmApiBase': 'http://x/v1', 'vlmApiModel': 'm'})()

    old_post = requests.post
    requests.post = _PostOk('C01')                        # 恒选盘内首项
    ts._VLM_RR_FAIL_COUNT = 0
    try:
        # ① 口径 off：不裁 ⇒ 盘首项 = q3 = 当前片 ⇒ 保持（零行为变化）
        r = _env(ZENTECT_VLM_RERANK='on', ZENTECT_KM_SUPPLY_DUR=None)
        try:
            solved = {'s1': {'chunkData': dict(ch['q3']), 'chunkId': 'q3'}}
            out = ts._apply_vlm_rerank_new_engine(solved, ctx, sem, req)
        finally:
            r()
        assert out['s1']['chunkData']['id'] == 'q3', 'off 档行为必须不变'

        # ② 口径 on：q3 被覆盖约束剔除 ⇒ 只能换到供得起的 q2
        r = _env(ZENTECT_VLM_RERANK='on', ZENTECT_KM_SUPPLY_DUR='1')
        try:
            solved2 = {'s1': {'chunkData': dict(ch['q3']), 'chunkId': 'q3'}}
            out2 = ts._apply_vlm_rerank_new_engine(solved2, ctx, sem, req)
        finally:
            r()
        assert out2['s1']['chunkData']['id'] == 'q2', \
            '供不起的 q3 应被剔出候选盘（实际 {}）'.format(out2['s1']['chunkData']['id'])
    finally:
        requests.post = old_post
        ts._VLM_RR_FAIL_COUNT = 0
    print('  ✅ 选项A 覆盖约束（供不起的候选不进重排盘；口径 off 零行为变化）')


def test_no_cross_sentence_cover_dup():
    """兄弟段共用父封面 ⇒ 必须按封面跨句排他（实测 seg_26_sub_1/3 各选 …_seg1/…_seg2 的成因）。

    s1 盘首项 x1 与 s2 盘首项 x2 是**不同 cid、同一封面**：仅靠 cid 排他会放行，
    两句各选一个 ⇒ 最终画面重复。按封面排他后 s2 只能退到别的封面。
    """
    import requests
    covs = _mk_covers(4)                                # A / B / C / D
    ch = {'n1': {'id': 'n1', 'coverPath': covs[0]},     # A ―┐ 兄弟段（同封面、不同 cid）
          'n2': {'id': 'n2', 'coverPath': covs[0]},     # A ―┘
          'n3': {'id': 'n3', 'coverPath': covs[1]},     # B
          'n4': {'id': 'n4', 'coverPath': covs[2]},     # C
          'n5': {'id': 'n5', 'coverPath': covs[3]}}     # D
    sem = {'n1': 0.9, 'n2': 0.9, 'n3': 0.1, 'n4': 0.1, 'n5': 0.5}

    # 纯函数层：封面被占则剔除；本句当前片即使封面被占也要留盘（作"保持"参照）
    got = [x[0] for x in ts._build_vlm_slate(['n1', 'n3'], ch, sem, set(), '', {covs[0]})]
    assert got == ['n3'], '封面被占的候选必须剔除: {}'.format(got)
    got = [x[0] for x in ts._build_vlm_slate(['n1', 'n3'], ch, sem, set(), 'n1', {covs[0]})]
    assert got == ['n1', 'n3'], '当前片例外：封面被占也应留盘: {}'.format(got)

    # 端到端：s1 先选中封面 A 的 x1 ⇒ s2 不得再选同封面的 x2，只能退到封面 D 的 x5
    queries = [{'shotId': 's1', 'text': '一', 'visualIntent': ''},
               {'shotId': 's2', 'text': '二', 'visualIntent': ''}]
    ctx = _FakeCtx(queries, {'s1': ['n3', 'n1'], 's2': ['n4', 'n5', 'n2']}, ch)
    sem_shot = {'s1': {'n3': 0.1, 'n1': 0.9},
                's2': {'n4': 0.1, 'n5': 0.5, 'n2': 0.9}}
    solved = {'s1': {'chunkData': dict(ch['n3']), 'chunkId': 'n3'},
              's2': {'chunkData': dict(ch['n4']), 'chunkId': 'n4'}}
    req = type('Req', (), {'vlmApiKey': 'k', 'vlmApiBase': 'http://x/v1', 'vlmApiModel': 'm'})()

    old_post = requests.post
    requests.post = _PostOk('C01')                      # 两句盘首项都是同封面的候选
    ts._VLM_RR_FAIL_COUNT = 0
    r = _env(ZENTECT_VLM_RERANK='on')
    try:
        out = ts._apply_vlm_rerank_new_engine(solved, ctx, sem_shot, req)
    finally:
        r()
        requests.post = old_post
    assert out['s1']['chunkData']['id'] == 'n1', out['s1']['chunkData']['id']
    assert out['s2']['chunkData']['id'] == 'n5', \
        's2 不得再选同封面兄弟段（应退到封面 D）: {}'.format(out['s2']['chunkData']['id'])
    structs = [out['s1']['chunkData'], out['s2']['chunkData']]
    covers = [c.get('coverPath') for c in structs]
    assert len(set(covers)) == len(covers), '跨句封面重复用片: {}'.format(covers)
    print('  ✅ 跨句封面排他（兄弟段同封面不得被两句各选一次）')


def test_circuit_breaker():
    """熔断 = 连续失败语义：失败累加、成功清零、达阈值后不再发请求。"""
    import requests
    covers = _mk_covers(2)
    old_post = requests.post

    def boom(*_a, **_kw):
        raise RuntimeError('boom')

    requests.post = boom
    try:
        ts._VLM_RR_FAIL_COUNT = 0
        assert ts._call_vlm_pick('t', '', covers, 'k', 'http://x/v1', 'm') is None
        assert ts._VLM_RR_FAIL_COUNT == 1, '失败应累加'
        ts._call_vlm_pick('t', '', covers, 'k', 'http://x/v1', 'm')
        assert ts._VLM_RR_FAIL_COUNT == 2, '连续失败应继续累加'

        # 成功 → 清零（旧实现"永不重置"在全量下必误熔断）
        ok = _PostOk('C01')
        requests.post = ok
        assert ts._call_vlm_pick('t', '', covers, 'k', 'http://x/v1', 'm') == 0
        assert ts._VLM_RR_FAIL_COUNT == 0, '成功必须清零'
        assert ok.calls == 1

        # 达阈值 → 熔断，不再发请求
        ts._VLM_RR_FAIL_COUNT = ts.VLM_RR_FAIL_THRESHOLD
        before = ok.calls
        assert ts._call_vlm_pick('t', '', covers, 'k', 'http://x/v1', 'm') is None
        assert ok.calls == before, '熔断后不得再发请求'
    finally:
        requests.post = old_post
        ts._VLM_RR_FAIL_COUNT = 0
    print('  ✅ 熔断「连续失败 / 成功清零 / 达阈值停发」')


def test_encode_cover_b64_and_usage():
    """送图缩图（成本口径）+ token 用量累计。

    ① 2160×1080（生产封面实际尺寸）⇒ 编码后长边 ≤720（单图 token 由 ~3042 降到 ~338），仍是 JPEG；
    ② 小图不被放大（长边已 <720 时保持原尺寸）；
    ③ 调用成功后 `_VLM_RR_USAGE` 累计 prompt/completion token（供收尾日志对账）。
    """
    import base64
    import io
    import requests
    from PIL import Image
    d = tempfile.mkdtemp(prefix='vlmrr_img_')

    def _mk(w, h, name):
        p = os.path.join(d, name)
        Image.new('RGB', (w, h), (30, 60, 90)).save(p, format='JPEG', quality=95)
        return p

    big, small = _mk(2160, 1080, 'big.jpg'), _mk(320, 180, 'small.jpg')
    for p, cap in ((big, 720), (small, 320)):
        raw = base64.b64decode(ts._encode_cover_b64(p))
        with Image.open(io.BytesIO(raw)) as im:
            assert max(im.size) <= cap, '长边应 ≤{}，实际 {}'.format(cap, im.size)
        assert raw[:2] == b'\xff\xd8', '必须是 JPEG 字节'

    old_post = requests.post
    requests.post = _PostOk('C01')
    ts._VLM_RR_FAIL_COUNT = 0
    ts._VLM_RR_USAGE.update(calls=0, **{'in': 0, 'out': 0})
    try:
        assert ts._call_vlm_pick('t', '', [big], 'k', 'http://x/v1', 'm') == 0
        assert ts._VLM_RR_USAGE == {'calls': 1, 'in': 1234, 'out': 56}, ts._VLM_RR_USAGE
    finally:
        requests.post = old_post
        ts._VLM_RR_FAIL_COUNT = 0
    print('  ✅ 送图缩图（2160→≤720）+ token 用量累计')


if __name__ == '__main__':
    test_mode_and_max()
    test_parse_vlm_pick()
    test_build_vlm_slate()
    test_apply_end_to_end()
    test_supply_cover_constraint()
    test_no_cross_sentence_cover_dup()
    test_encode_cover_b64_and_usage()
    test_circuit_breaker()
    print('test_vlm_rerank ✅ 全部通过')