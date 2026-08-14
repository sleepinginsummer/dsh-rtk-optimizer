# Release Notes

每个版本的发布说明写在对应章节。发布 workflow 会优先使用本节内容作为 GitHub release notes；没有对应章节时自动从 git log 生成。

<!-- 发布新版本时，在顶部插入新章节，例如：
## v0.2.0

### Features

- ...

### Fixes

- ...

-->

## v0.1.0

### Features

- RTK 命令改写建议：`bash` 调用自动探测 rtk，支持 `suggest`（结果附注改写命令）与 `rewrite`（deny + 反馈命令）双模式
- 输出压缩管线：ANSI 剥离、git status 汇总、测试输出聚合、构建错误过滤、grep 结果分组、智能截断
- `/rtk` 命令：show / verify / stats / set / reset，运行时切换模式与配置
- rtk 未安装时自动降级（原命令原样执行），探测结果缓存避免重复 probe
