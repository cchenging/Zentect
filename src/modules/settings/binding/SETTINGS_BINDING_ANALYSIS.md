# settings/binding 分析文档

## 一、源文件清单

| 文件 | 位置 | 行数 | 职责 |
|------|------|------|------|
| ProfileBindingRepository.ts | src/main/services/ | 37 | 3个静态方法操作 ai_profile_bindings 表 |
| ApiProfileController.ts | src/main/services/ | 45 | 注册 binding IPC（binding:getAll / binding:getByTask / binding:upsert） |
| AITab.tsx（管线映射区域） | src/renderer/src/pages/settings/components/ | ~100行 | 管线节点下拉选择 |

## 二、依赖关系

- ProfileBindingRepository → DatabaseConnectionManager
- ProfileBindingRepository 被 ApiProfileController 引用
- AITab 通过 window.api.profileBinding.* IPC 调用

## 三、与架构规格对照

| 规格项 | 现状 | 差距 |
|--------|------|------|
| ProfileBinding 接口 | ProfileBindingRepository 有内联类型 | 需提至 types.ts |
| BindingInput 接口 | 不存在 | 按 §3.7.2 新建 |
| 6个管线节点 | AITab.tsx 中6节点+PIPELINE_NODES | TTS节点为disabled，实际5个活跃 |
| 修改即保存 | handleBindingChange 实时 upsert | 已实现 |

## 四、迁移方案

1. types.ts：定义 ProfileBinding / BindingInput 接口
2. backend/BindingService.ts：封装管线-模型映射CRUD（委托 ProfileBindingRepository）
3. index.ts：统一导出
4. 旧 ProfileBindingRepository.ts 转 @deprecated 委托
5. AITab.tsx 管线映射区域 import 更新
