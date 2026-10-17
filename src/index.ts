/**
 * @file index.ts
 * @description @skynote-pro/plugin-brush 统一导出入口
 */

import type { SkyNotePlugin } from '@skynote/core';
import { BrushDisplayPlugin, BrushPlugin, type BrushPluginOptions } from './brush-plugin';

export * from './stroke-geometry';
export * from './ink-node';
export * from './brush-plugin';

/** 商业插件包的统一入口约定：完整启用画笔节点与自由绘制工具 (是否启用由宿主 FeatureGate 决定) */
export function createPlugins(options?: BrushPluginOptions): SkyNotePlugin[] {
  return [new BrushPlugin(options)];
}

/** 仅启用画笔节点展示入口：宿主无绘制编辑授权时装配，支持展示已有笔迹与通用画布命令 */
export function createDisplayPlugins(): SkyNotePlugin[] {
  return [new BrushDisplayPlugin()];
}
