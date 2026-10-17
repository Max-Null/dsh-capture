# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.2] - 2026-10-18

### Changed

- 适配 DSH 0.2.1：`src/host-context.d.ts` 的类型镜像由 `webRuntime` 改为 `webStartup`。该服务自 0.2.1-alpha.2 起被删除；本插件对该面是可选读取（`ctx.get`），运行时不受影响，改动只是让类型声明与内核一致。
- 补 `repository` 字段：npm 的来源证明（provenance）会校验 package.json 的仓库地址与构建来源一致，缺它会让 `npm publish --provenance` 在最后一步被拒。
