"""
test_attr_subject.py — 🎭 属性贴合「主体维」的人数泛称对齐（2026-10-20）

锁定 bug：工单 `targetSubjects` 常写**人数泛称**（「多人」「两人」「一男一女」），
而切片侧给的是**具体视觉称谓**（「一男一女背影」「穿深色外套的男子」）。
字面子串比对必然落空 ⇒ 实测主体维落空 34%，其中大量是「多人→一男一女背影」这类**假阴性**。

修法（montage_contract._subject_adherence ③-0，**只做命中侧、不新增落空**）：
  声明含人数泛称（SUBJECT_MULTI_TOKENS）且候选侧确实 ≥2 个主体（characters 去重 ≥2，
  或 primarySubject 指向多主体）⇒ 直接命中。声明多人而候选是单人 ⇒ 行为保持不变（不因本规则命中，
  也不凭空落空）。

覆盖点：
  1. 「多人」↔ 多主体候选（characters 两个）⇒ 命中（原判定为落空/中性）
  2. 「一男一女」↔ primarySubject「一男一女背影」⇒ 命中
  3. 纯姓名并列声明（「张三和李四」）且无 char-id 桥 ⇒ 中性（不因「和」字被误当人数泛称）
  4. 声明「多人」但候选单人（characters 仅 1 个）⇒ 不命中、也不新增落空（保持中性）
  5. 既有子串契约不回归：视觉称谓子串命中仍命中、真差异仍落空

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe -m __tests__.test_attr_subject
  （函数式 test_* + 纯 assert；run_all.py 自动收集）
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import montage_contract as mc


def _stats():
    return {'match': 0, 'miss': 0, 'neutral': 0}


def test_multi_person_both_sides_hits() -> None:
    """① 声明「多人」+ 候选 characters 两个 ⇒ 命中（此前为落空/中性）。"""
    st = _stats()
    cost = mc._subject_adherence(['多人'], {'characters': ['穿黑衣的男子', '穿白裙的女子']}, st)
    assert cost == mc.ATTR_MATCH_REWARD, f'应命中，实际 {cost}'
    assert st['match'] == 1 and st['miss'] == 0, st


def test_pair_wording_hits() -> None:
    """② 声明「一男一女」↔ primarySubject「一男一女背影」⇒ 命中。"""
    st = _stats()
    cost = mc._subject_adherence(['一男一女'], {'primarySubject': '一男一女背影', 'characters': []}, st)
    assert cost == mc.ATTR_MATCH_REWARD, f'应命中，实际 {cost}'
    assert st['match'] == 1, st


def test_conjunction_names_without_bridge_stays_neutral() -> None:
    """③ 声明「张三和李四」（并列**姓名**，非人数泛称）且无 char-id 桥 ⇒ 中性。

    边界说明：纯姓名并列两侧不可判"是否同一人"，属 char-id 桥（②）职责；
    桥不可用时保持中性，不因「和」字被误当人数泛称（防伪命中）。
    """
    st = _stats()
    cost = mc._subject_adherence(['张三和李四'], {'characters': ['张三', '李四']}, st)
    assert cost == 0.0, f'无桥时应保持中性 0，实际 {cost}'
    assert st['neutral'] == 1 and st['match'] == 0, st


def test_multi_declared_vs_single_candidate_stays_neutral() -> None:
    """④ 声明「多人」但候选是单人 ⇒ 不命中（保持中性，不凭空落空）。"""
    st = _stats()
    cost = mc._subject_adherence(['多人'], {'characters': ['穿深色外套的男子']}, st)
    assert cost == 0.0, f'应保持中性 0，实际 {cost}'
    assert st['neutral'] == 1 and st['match'] == 0 and st['miss'] == 0, st


def test_existing_substring_contract_no_regression() -> None:
    """⑤ 既有「视觉称谓」子串契约不回归：命中仍命中、真差异仍落空。"""
    st_hit = _stats()
    hit = mc._subject_adherence(['卷发女子'], {'characters': ['戴眼镜的卷发女子']}, st_hit)
    assert hit == mc.ATTR_MATCH_REWARD, f'子串命中应奖励，实际 {hit}'
    st_miss = _stats()
    miss = mc._subject_adherence(['卷发女子'], {'characters': ['穿黑西装的男子']}, st_miss)
    assert miss == mc.ATTR_MISS_PENALTY, f'同坐标系真差异应落空，实际 {miss}'


def _run_all() -> int:
    """逐函数执行；任何断言失败向上抛（run_all.py 收集）。"""
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for t in tests:
        t()
        print(f'  ✔ {t.__name__}')
    print(f'  attr-subject 用例 {len(tests)} 个全绿 ✅')
    return 0


if __name__ == '__main__':
    sys.exit(_run_all())
