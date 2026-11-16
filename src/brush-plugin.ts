/**
 * @file brush-plugin.ts
 * @description 画笔插件：分离仅展示插件 (BrushDisplayPlugin) 与完整绘制插件 (BrushPlugin)
 *
 * 设计考量 (Why):
 * 1. 展示与编辑装配解耦 (ADR-142)：BrushDisplayPlugin 提供已有 ink 节点的渲染与通用画布操作，
 *    BrushPlugin 在此基础上提供自由绘制工具。
 * 2. 一笔一事务与草稿隔离：拖动期间采样仅写入插件自有 InkDraftBuffer 并经瞬态覆盖层预览，松手时执行简化与局部坐标归一化，
 *    通过一次 createNode 提交；Esc、pointercancel、失焦、切换工具、维护冻结、文档替换或插件卸载立即丢弃未提交草稿。
 * 3. 本笔参数冻结：笔迹按下时快照当前模式、颜色、线宽、透明度、压感与平滑参数，绘制中途修改工具栏仅作用于下一笔。
 * 4. 优先级与互斥：指针优先级 (85) 高于选择 (0)、变换 (50)、文字编辑 (60) 与连线工具 (80)，低于视口空格/中键平移 (100)，
 *    按住空格平移时画笔自动让路，画笔激活时屏蔽底层节点悬停高亮与控制柄光标。
 */

import {
  SELECT_TOOL,
  resolveThemeColor,
  type CanvasKeyboardEvent,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type DocumentChangeSet,
  type PointerHooks,
  type SessionChange,
  type SkyNotePlugin
} from '@skynote/core';
import { InkNodeType } from './ink-node';
import {
  DEFAULT_INK_SMOOTHING,
  DEFAULT_INK_STROKE_WIDTH,
  DEFAULT_INK_THINNING,
  InkDraftBuffer,
  clamp01,
  type InkBrushMode,
  type InkCapStyle
} from './stroke-geometry';

export const BRUSH_PLUGIN_ID = '@skynote-pro/plugin-brush';
export const BRUSH_DISPLAY_PLUGIN_ID = '@skynote-pro/plugin-brush/display';
/** 会话中的画笔工具标识 */
export const BRUSH_TOOL = 'brush';

/** 高于选择 (0)、变换 (50)、文字编辑 (60)、连线工具 (80)，低于视口空格/中键平移 (100) */
const BRUSH_TOOL_PRIORITY = 85;
/** 高于通用编辑快捷键 (0) 与连线工具 (10)，低于文字编辑 (1000) */
const BRUSH_KEY_PRIORITY = 15;
const DRAFT_OVERLAY_SESSION = 'brush:draft';
/** 屏幕空间最小采样间距 (像素)：过滤静止微抖动，同时保留细腻曲线 */
const MIN_SAMPLE_SCREEN_PX = 1.5;
/** 松手落盘时的屏幕空间 RDP 简化容差 (像素)：控制视觉偏差在亚像素级 */
const SIMPLIFY_SCREEN_PX = 0.45;

/** 画笔工具配置项 */
export interface BrushSettings {
  readonly mode: InkBrushMode;
  /** 笔触颜色 (支持 `$blue` 等调色板引用或主题色)；缺省跟随当前主题 textColor */
  readonly stroke?: string;
  readonly strokeWidth: number;
  readonly opacity: number;
  readonly thinning: number;
  readonly smoothing: number;
  /** 起始端点样式 */
  readonly startCap?: InkCapStyle;
  /** 结束端点样式 */
  readonly endCap?: InkCapStyle;
  /** 描边虚线模式 (仅在 mode === 'fixed' 时生效) */
  readonly strokeDashArray?: number[];
}

export type BrushPluginOptions = Partial<BrushSettings>;

interface ActiveBrushDraft {
  readonly pointerId: number;
  readonly frozen: Readonly<BrushSettings>;
  readonly strokeColor: string;
  readonly buffer: InkDraftBuffer;
}

/**
 * 仅展示插件：只注册 ink 节点类型并维护派生路径缓存，不提供画笔绘制工具
 * 用于宿主“仅启用节点展示”模式 (View-Only / 无商业绘制授权时)
 */
export class BrushDisplayPlugin implements SkyNotePlugin {
  readonly id = BRUSH_DISPLAY_PLUGIN_ID;
  readonly name = '画笔笔迹展示';
  readonly version = '0.1.0';
  readonly nodeType = new InkNodeType();

  install(ctx: CanvasPluginContext): void {
    ctx.registerNodeType(this.nodeType);
    ctx.onDocumentChange((changes) => {
      if (changes.contentReplaced) {
        this.nodeType.clearCache();
        return;
      }
      for (const id of changes.nodes.removed) {
        this.nodeType.clearCache(id);
      }
    });
  }

  unmount(): void {
    this.nodeType.clearCache();
  }
}

/**
 * 完整画笔插件：注册 ink 节点类型与自由绘制交互，支持固定宽度笔和压感墨水笔。
 */
export class BrushPlugin implements SkyNotePlugin, PointerHooks {
  readonly id = BRUSH_PLUGIN_ID;
  readonly name = '画笔';
  readonly version = '0.1.0';
  readonly nodeType = new InkNodeType();

  private ctx!: CanvasPluginContext;
  private settings: BrushSettings;
  private draft: ActiveBrushDraft | null = null;
  private readonly settingsListeners = new Set<(settings: Readonly<BrushSettings>) => void>();

  constructor(options: BrushPluginOptions = {}) {
    const hasDash = Boolean(options.strokeDashArray && options.strokeDashArray.length > 0);
    this.settings = {
      mode: hasDash ? (options.mode ?? 'fixed') : (options.mode ?? 'pressure'),
      stroke: options.stroke,
      strokeWidth: Math.max(0.5, options.strokeWidth ?? DEFAULT_INK_STROKE_WIDTH),
      opacity: clamp01(options.opacity ?? 1),
      thinning: clamp01(options.thinning ?? DEFAULT_INK_THINNING),
      smoothing: clamp01(options.smoothing ?? DEFAULT_INK_SMOOTHING),
      startCap: options.startCap ?? 'round',
      endCap: options.endCap ?? 'round',
      strokeDashArray: options.strokeDashArray
    };
  }

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerNodeType(this.nodeType);
    ctx.registerPointerHooks(this, BRUSH_TOOL_PRIORITY);
    ctx.registerInputScope({
      id: 'canvas:brush-tool',
      priority: BRUSH_KEY_PRIORITY,
      onKeyDown: (e) => this.onKeyDown(e),
      onBlur: () => this.cancelActiveDraft()
    });
    ctx.onSessionChange((change) => this.onSessionChange(change));
    ctx.onDocumentChange((changes) => this.onDocumentChange(changes));
  }

  unmount(): void {
    this.cancelActiveDraft();
    this.nodeType.clearCache();
    this.settingsListeners.clear();
  }

  /** 当前是否处于画笔工具激活态 */
  get active(): boolean {
    return this.ctx?.session.tool === BRUSH_TOOL;
  }

  /** 当前是否存在正在绘制的未提交草稿 */
  get hasActiveDraft(): boolean {
    return this.draft !== null;
  }

  /** 读取当前画笔设置 */
  getSettings(): Readonly<BrushSettings> {
    return this.settings;
  }

  /**
   * 更新画笔设置 (供笔盒 UI 调用)
   * 若当前正在绘制一笔，已按下的笔迹保持冻结参数不变，新设置从下一笔开始生效
   */
  setSettings(partial: Partial<BrushSettings>): void {
    const strokeDashArray = 'strokeDashArray' in partial ? partial.strokeDashArray : this.settings.strokeDashArray;
    const hasDash = Boolean(strokeDashArray && strokeDashArray.length > 0);
    const nextMode = partial.mode ?? (hasDash && this.settings.mode === 'pressure' ? 'fixed' : this.settings.mode);

    const next: BrushSettings = {
      mode: nextMode,
      stroke: 'stroke' in partial ? partial.stroke : this.settings.stroke,
      strokeWidth: partial.strokeWidth !== undefined ? Math.max(0.5, partial.strokeWidth) : this.settings.strokeWidth,
      opacity: partial.opacity !== undefined ? clamp01(partial.opacity) : this.settings.opacity,
      thinning: partial.thinning !== undefined ? clamp01(partial.thinning) : this.settings.thinning,
      smoothing: partial.smoothing !== undefined ? clamp01(partial.smoothing) : this.settings.smoothing,
      startCap: partial.startCap !== undefined ? partial.startCap : this.settings.startCap,
      endCap: partial.endCap !== undefined ? partial.endCap : this.settings.endCap,
      strokeDashArray
    };
    this.settings = next;
    for (const listener of this.settingsListeners) {
      listener(this.settings);
    }
  }

  /** 订阅画笔设置变更 */
  onSettingsChange(listener: (settings: Readonly<BrushSettings>) => void): () => void {
    this.settingsListeners.add(listener);
    return () => {
      this.settingsListeners.delete(listener);
    };
  }

  /** 激活画笔工具 */
  activateTool(): void {
    this.ctx.session.setTool(BRUSH_TOOL);
  }

  /** 立即取消并丢弃当前未提交的笔迹草稿，不产生文档事务 */
  cancelActiveDraft(): void {
    if (!this.draft) return;
    const { pointerId } = this.draft;
    this.draft = null;
    this.ctx.host.releasePointer(pointerId);
    this.ctx.host.overlay.clear(DRAFT_OVERLAY_SESSION);
  }

  /** 绘制中右键：丢弃这一笔并消费右键，不弹出菜单 */
  onContextMenu(e: CanvasPointerEvent): void {
    if (!this.draft) return;
    e.stopPropagation();
    this.cancelActiveDraft();
  }

  onPointerDown(e: CanvasPointerEvent): void {
    if (!this.active || e.isClaimed || this.draft || e.button !== 0 || this.ctx.session.inMaintenance) {
      return;
    }
    e.claimPointer(BRUSH_PLUGIN_ID);
    e.stopPropagation();
    this.ctx.host.capturePointer(e.pointerId);

    // 冻结本笔参数：绘制中途工具栏修改不影响正在画的这一笔
    const frozen: Readonly<BrushSettings> = { ...this.settings };
    const strokeColor = resolveThemeColor(frozen.stroke, this.ctx.session.theme, this.ctx.session.theme.textColor)!;
    const buffer = new InkDraftBuffer({
      mode: frozen.mode,
      strokeWidth: frozen.strokeWidth,
      thinning: frozen.thinning,
      smoothing: frozen.smoothing,
      startCap: frozen.startCap,
      endCap: frozen.endCap,
      strokeDashArray: frozen.strokeDashArray,
      strokeColor,
      opacity: frozen.opacity
    });

    const zoom = Math.max(0.01, this.ctx.session.viewport.zoom);
    buffer.appendSamples(e.samples, MIN_SAMPLE_SCREEN_PX / zoom);

    this.draft = {
      pointerId: e.pointerId,
      frozen,
      strokeColor,
      buffer
    };
    this.ctx.host.overlay.setPrimitives(DRAFT_OVERLAY_SESSION, buffer.toPrimitives(), { transient: true });
  }

  onPointerMove(e: CanvasPointerEvent): void {
    const { draft } = this;
    if (draft) {
      // 多指触控或其他指针干扰：直接忽略非当前绘制指针的移动
      if (e.pointerId !== draft.pointerId) return;
      e.stopPropagation();
      const zoom = Math.max(0.01, this.ctx.session.viewport.zoom);
      draft.buffer.appendSamples(e.samples, MIN_SAMPLE_SCREEN_PX / zoom);
      this.ctx.host.overlay.setPrimitives(DRAFT_OVERLAY_SESSION, draft.buffer.toPrimitives(), { transient: true });
      return;
    }

    if (!this.active) return;
    // 画笔工具激活且空闲悬停时：独占悬停并保持十字光标，避免底部节点出现选择高亮或缩放光标
    e.stopPropagation();
    this.ctx.host.setCursor('crosshair');
  }

  onPointerUp(e: CanvasPointerEvent): void {
    const { draft } = this;
    if (!draft || e.pointerId !== draft.pointerId) return;
    e.stopPropagation();

    const zoom = Math.max(0.01, this.ctx.session.viewport.zoom);
    draft.buffer.appendSamples(e.samples, MIN_SAMPLE_SCREEN_PX / zoom);

    const { frozen, buffer } = draft;
    this.cancelActiveDraft();

    // 若绘制期间进入维护态，放弃提交
    if (this.ctx.session.inMaintenance) {
      return;
    }

    const normalized = buffer.finalize(SIMPLIFY_SCREEN_PX / zoom);
    if (normalized.samples.length === 0) return;

    this.ctx.document.createNode({
      nodeType: InkNodeType.TYPE,
      x: normalized.x,
      y: normalized.y,
      width: normalized.width,
      height: normalized.height,
      options: {
        mode: frozen.mode,
        samples: normalized.samples,
        width: normalized.width,
        height: normalized.height,
        stroke: frozen.stroke,
        strokeWidth: frozen.strokeWidth,
        ...(frozen.strokeDashArray && { strokeDashArray: frozen.strokeDashArray }),
        ...(frozen.opacity < 1 && { strokeOpacity: frozen.opacity, opacity: frozen.opacity }),
        thinning: frozen.thinning,
        smoothing: frozen.smoothing,
        ...(frozen.startCap !== undefined && { startCap: frozen.startCap }),
        ...(frozen.endCap !== undefined && { endCap: frozen.endCap })
      },
      label: '绘制笔迹'
    });
  }

  onPointerCancel(e: CanvasPointerEvent): void {
    if (this.draft?.pointerId === e.pointerId) {
      this.cancelActiveDraft();
    }
  }

  private onKeyDown(e: CanvasKeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    if (!mod && !e.shiftKey && e.code === 'KeyB' && !this.active) {
      this.ctx.session.setTool(BRUSH_TOOL);
      return true;
    }
    if (e.key === 'Escape' && (this.active || this.draft)) {
      // 正在绘制时按 Esc 仅丢弃当前未提交笔迹并留在画笔工具；空闲时按 Esc 退回选择工具
      if (this.draft) {
        this.cancelActiveDraft();
      } else {
        this.ctx.session.setTool(SELECT_TOOL);
      }
      return true;
    }
    return false;
  }

  private onSessionChange(change: SessionChange): void {
    if (change.maintenanceChanged && this.ctx.session.inMaintenance) {
      this.cancelActiveDraft();
    }
    if (change.toolChanged) {
      if (this.active) {
        this.ctx.session.setSelection({ nodeIds: [], connectorIds: [] });
        this.ctx.host.setCursor('crosshair');
      } else {
        this.cancelActiveDraft();
        if (change.previousTool === BRUSH_TOOL) this.ctx.host.setCursor('default');
      }
    }
  }

  private onDocumentChange(changes: DocumentChangeSet): void {
    if (changes.contentReplaced) {
      this.cancelActiveDraft();
      this.nodeType.clearCache();
      return;
    }
    for (const id of changes.nodes.removed) {
      this.nodeType.clearCache(id);
    }
  }
}
