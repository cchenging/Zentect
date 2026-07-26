-- 022: AI 运行时 GPU 加速设置项（阶段 3 新增）
-- 默认 false：避免未安装 CUDA 版 torch 时误传 --device cuda
-- 用户在健康检查页 GPU 卡片中显式开启，触发 CUDA 版 torch 安装后自动设为 true
INSERT OR IGNORE INTO settings (key, value) VALUES ('enableGPU', 'false');
