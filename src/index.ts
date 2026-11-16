/**
 * @file index.ts
 * @description @skynote-pro/plugin-brush 统一导出入口
 */

import type { SkyNotePlugin } from '@skynote/core';
import { BrushDisplayPlugin, BrushPlugin, type BrushPluginOptions } from './brush-plugin';

export * from './stroke-geometry';
export * from './ink-node';
export * from './brush-plugin';

/** 装配画笔节点与自由绘制工具。 */
export function createPlugins(options?: BrushPluginOptions): SkyNotePlugin[] {
  return [new BrushPlugin(options)];
}

/** 仅装配已有笔迹的展示与通用画布操作。 */
export function createDisplayPlugins(): SkyNotePlugin[] {
  return [new BrushDisplayPlugin()];
}
