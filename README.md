# SkyNote 画笔

在 SkyNote 画布上绘制自由笔迹，用于手写、标注和勾勒想法。

[免费在线体验](https://playground.skynote.top/?example=brush) · [功能文档](https://docs.skynote.top/plugins/brush)

## 主要能力

- 支持固定宽度和压感笔触。
- 调整颜色、线宽、透明度、虚线和端点样式。
- 完成的笔迹可以选中、移动、缩放和撤销。

## 源码开发

包名为 `@skynote-pro/plugin-brush`。当前通过 pnpm 工作区解析 SkyNote 基础 SDK 依赖，公共 npm 暂无安装入口。宿主可以用 `createPlugins()` 装配插件。

只需在画布上展示已有笔迹时，可使用 `createDisplayPlugins()`。

在新工作区中装配基础 SDK，再将本插件检出到 `pro/plugin-brush`。

```sh
git clone https://github.com/skynote-universe/skynote.git
cd skynote
node scripts/bootstrap.mjs
git clone --branch main https://github.com/skynote-universe/plugin-brush.git pro/plugin-brush
pnpm install --no-frozen-lockfile
pnpm --filter @skynote-pro/plugin-brush typecheck
pnpm --filter @skynote-pro/plugin-brush test
```

工作区使用 Node.js 22.12 或更高版本和 pnpm 10.12.4。加入插件后，安装会更新本地锁文件，以记录额外的工作区包。

## 参与贡献

欢迎向本仓提交 PR。请按同一 MIT 许可证提交你有权提供的改动，并在 PR 中说明改动和验证结果。

## 许可证

[MIT 许可证](./LICENSE)
