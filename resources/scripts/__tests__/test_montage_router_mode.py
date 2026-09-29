"""
test_montage_router_mode.py — 🧊 步骤5 求解器档位真源收敛（ISSUE-4）

锁定 `montage_router.resolve_mode()` 的档位读取顺序（收敛后，单一真源）：
   标记文件 `temp/storyboard-mode`（Node 权威落盘，缺省 on）→ 环境变量 → off

  1. 两者皆缺失 ⇒ off（旧引擎保底，绝不误开新引擎）
  2. 仅环境变量 ⇒ 取环境变量（大小写不敏感）
  3. 标记文件与环境变量并存 ⇒ **标记文件优先**（消除双缺省分叉）
  4. 标记文件非法值 ⇒ 回落环境变量；两者皆非法 ⇒ off
  5. 标记文件带 BOM（utf-8-sig）⇒ 仍正确解析（不静默回落，`load_storyboard` 同坑）
  6. 读档缺失/异常不抛（等价「未设」，交由下一档兜底）

运行方式：cd resources/scripts ; ..\\ai-env\\python.exe __tests__\\test_montage_router_mode.py
（或 ..\\ai-env\\python.exe __tests__\\run_all.py 全量跑）
"""
import os
import sys
import tempfile

# 将 scripts 目录加入 path，以便 import montage_router
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import montage_router
from montage_router import resolve_mode

ENV_KEY = 'ZENTECT_KM_STORYBOARD_MODE'


class _Sandbox:
    """把标记文件根目录临时改到 tmp（**绝不触碰真实 temp/**），可选写入档位文件。

    用法：`with _Sandbox(content='on'): assert resolve_mode() == 'on'`。
    """

    def __init__(self, content=None, encoding='utf-8'):
        self.content = content
        self.encoding = encoding
        self._tmp = None
        self._old_root = None

    def __enter__(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.makedirs(os.path.join(self._tmp.name, 'temp'), exist_ok=True)
        # 补丁：`_read_mode_file` 在调用期查模块全局 `_repo_root` ⇒ 替换即生效。
        self._old_root = montage_router._repo_root
        montage_router._repo_root = lambda: self._tmp.name
        if self.content is not None:
            with open(os.path.join(self._tmp.name, 'temp', 'storyboard-mode'),
                      'w', encoding=self.encoding) as f:
                f.write(self.content)
        return self

    def __exit__(self, *exc):
        montage_router._repo_root = self._old_root
        self._tmp.cleanup()
        return False


def _with_env(raw, fn):
    """在 env 临时置为 raw 的前提下执行 fn（跑完原样还原，绝不污染后续用例）。"""
    old = os.environ.get(ENV_KEY)
    if raw is None:
        os.environ.pop(ENV_KEY, None)
    else:
        os.environ[ENV_KEY] = raw
    try:
        return fn()
    finally:
        if old is None:
            os.environ.pop(ENV_KEY, None)
        else:
            os.environ[ENV_KEY] = old


def test_missing_both_falls_back_off():
    """两者皆缺失 ⇒ off（旧引擎保底；守卫「绝不误开新引擎」）。"""
    with _Sandbox(content=None):
        assert _with_env(None, resolve_mode) == 'off', "文件+env 皆无必须落 off"
        assert _with_env('', resolve_mode) == 'off', "空串 env 等价未设"
        assert _with_env('bogus', resolve_mode) == 'off', "非法 env 错就错落 off"
    print("✓ test_missing_both_falls_back_off: 双缺失/非法 ⇒ off")


def test_env_only_case_insensitive():
    """仅环境变量：大小写不敏感，三档直通。"""
    with _Sandbox(content=None):
        assert _with_env('on', resolve_mode) == 'on'
        assert _with_env('SHADOW', resolve_mode) == 'shadow'
        assert _with_env(' off ', resolve_mode) == 'off', "首尾空白须裁剪"
    print("✓ test_env_only_case_insensitive: env 直通（大小写/空白不敏感）")


def test_file_wins_over_env():
    """文件与环境变量并存 ⇒ 文件优先（单一真源；这正是 ISSUE-4 收敛的落点）。"""
    with _Sandbox(content='on'):
        assert _with_env('off', resolve_mode) == 'on', "标记文件须压过 env（否则又成分叉）"
    with _Sandbox(content='shadow'):
        assert _with_env('on', resolve_mode) == 'shadow'
    with _Sandbox(content='off'):
        assert _with_env('on', resolve_mode) == 'off', "文件显式 off 亦须压过 env=on"
    print("✓ test_file_wins_over_env: 标记文件优先于环境变量")


def test_invalid_file_falls_back_to_env():
    """文件非法值 ⇒ 回落 env；两者皆非法 ⇒ off（逐级兜底，不抛不猜）。"""
    with _Sandbox(content='unknown'):
        assert _with_env('on', resolve_mode) == 'on', "文件非法须回落 env"
        assert _with_env(None, resolve_mode) == 'off'
    print("✓ test_invalid_file_falls_back_to_env: 非法文件逐级回落")


def test_bom_file_parsed():
    """带 BOM 的标记文件仍须正确解析（utf-8-sig；否则静默回落 = 档位「设了不生效」）。"""
    with _Sandbox(content='on', encoding='utf-8-sig'):
        assert _with_env(None, resolve_mode) == 'on', "BOM 文件必须解析成功"
        assert _with_env('off', resolve_mode) == 'on'
    print("✓ test_bom_file_parsed: BOM 标记文件正确解析")


if __name__ == "__main__":
    print("=" * 60)
    print("🧊 步骤5 求解器档位真源收敛（ISSUE-4）")
    print("=" * 60)
    test_missing_both_falls_back_off()
    test_env_only_case_insensitive()
    test_file_wins_over_env()
    test_invalid_file_falls_back_to_env()
    test_bom_file_parsed()
    print("=" * 60)
    print("全部通过 ✅")