"""
run_all.py —— 步骤5 新引擎 L1 单测总入口（一条命令、单一退出码）。

为什么需要它（不是多余封装）：
  `resources/ai-env/` 是 **Python 嵌入式发行版**（存在 `python312._pth`），sys.path 被
  `._pth` 完全接管 ⇒ **当前工作目录永不入 path、PYTHONPATH 被忽略**，故
  `python -m __tests__.test_x` 恒报 `No module named '__tests__'`（加 `__init__.py` 也无用）。
  各测试模块自带 `sys.path.insert` 自举，故「逐文件直跑」可用；本入口用 `runpy` 把各模块
  当 `__main__` 跑一遍，凑出**单一退出码**，作为方案文档 §0 的 L1 判据落地形式。

用法：
  cd resources/scripts
  ..\\ai-env\\python.exe __tests__\\run_all.py     # 全绿退出 0，任一失败退出 1
"""
import glob
import os
import runpy
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
# scripts/ 入 path，供测试内 `import beam_search / timeline_solver / rules` 等新引擎模块。
sys.path.insert(0, os.path.dirname(HERE))


def main() -> int:
    """逐个模块以 __main__ 身份执行，汇总失败清单。"""
    modules = sorted(glob.glob(os.path.join(HERE, 'test_*.py')))
    if not modules:
        print('未发现任何 test_*.py，L1 判据为空 —— 视为失败')
        return 1

    failed = []
    for path in modules:
        name = os.path.basename(path)
        print(f'--- {name} ---')
        try:
            runpy.run_path(path, run_name='__main__')
        except Exception:  # noqa: BLE001 —— 收集全部失败后统一报，不首个即退出
            failed.append(name)
            traceback.print_exc()

    print('=' * 60)
    if failed:
        print(f'L1 单测失败 {len(failed)}/{len(modules)}: {failed}')
        return 1
    print(f'L1 单测全绿 {len(modules)}/{len(modules)} ✅')
    return 0


if __name__ == '__main__':
    sys.exit(main())