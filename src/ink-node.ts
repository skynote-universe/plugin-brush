/**
 * @file ink-node.ts
 * @description 画笔笔迹节点定义 (nodeType = 'ink')：具名强类型字段 node.ink、专有结构校验、精确命中、等比缩放与路径缓存
 *
 * 设计考量 (Why):
 * 1. 具名强类型扩展：笔迹采样与模式存储在顶层具名字段 node.ink，不塞入通用 node.data；公共颜色与线宽复用 node.style。
 * 2. 派生轮廓运行时缓存：持久化只存 samples 与笔触参数 (单一事实源)，SVG Path 字符串在内存中按 (node.ink 引用, 线宽) 缓存，
 *    平移、缩放视口或切换主题时不重复执行轮廓拟合，节点删除或插件卸载时及时释放。
 * 3. 零跨度除零守卫：单点圆点或纯水平/垂直笔迹的 width 或 height 为 0，applyResize 优先使用 request.scale，
 *    严禁除以 0 产生 NaN；同时通过 extent 外扩笔触半宽，确保零跨度笔迹在空间索引中拥有合法包围盒。
 */

import {
  resolveNodeStyle,
  type CanvasPrimitive,
  type NodeComposeContext,
  type NodeCreateContent,
  type NodeEntity,
  type NodeResizeRequest,
  type NodeSizingPolicy,
  type NodeStyle,
  type NodeTypeDefinition,
  type Point,
  type RectBounds
} from '@skynote/core';
import {
  DEFAULT_INK_SMOOTHING,
  DEFAULT_INK_STROKE_WIDTH,
  DEFAULT_INK_THINNING,
  INK_MAX_SAMPLES,
  buildInkPrimitives,
  computeMaxInkRadius,
  hitTestInkStroke,
  intersectsInkStrokeBounds,
  normalizeInkSamples,
  roundInkNum,
  type InkBrushMode,
  type InkCapStyle,
  type InkSample,
  type InkStrokeGeometryOptions
} from './stroke-geometry';

export const INK_NODE_TYPE = 'ink';

/** 节点持久化专有字段 node.ink */
export interface InkNodeFields {
  readonly mode: InkBrushMode;
  readonly samples: readonly InkSample[];
  /** 压感响应强度 [0, 1] (仅 mode === 'pressure' 时生效) */
  readonly thinning?: number;
  /** 轨迹平滑系数 [0, 1] */
  readonly smoothing?: number;
  /** 起始端点样式 (缺省为 'round') */
  readonly startCap?: InkCapStyle;
  /** 结束端点样式 (缺省为 'round') */
  readonly endCap?: InkCapStyle;
}

/** createNode({ nodeType: 'ink', options }) 的新建选项 */
export interface InkCreateOptions {
  readonly mode?: InkBrushMode;
  readonly samples?: readonly InkSample[];
  readonly width?: number;
  readonly height?: number;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly strokeDashArray?: number[];
  readonly strokeOpacity?: number;
  readonly opacity?: number;
  readonly thinning?: number;
  readonly smoothing?: number;
  readonly startCap?: InkCapStyle;
  readonly endCap?: InkCapStyle;
}

declare module '@skynote/core' {
  interface CustomNodeFields {
    ink?: InkNodeFields;
  }
  interface NodeCreateOptionsMap {
    ink: InkCreateOptions;
  }
}

interface CachedInkPrimitives {
  readonly ink: InkNodeFields;
  readonly strokeWidth: number;
  readonly strokeDashArray: number[] | undefined;
  readonly color: string;
  readonly opacity: number | undefined;
  readonly primitives: CanvasPrimitive[];
}

const VALID_MODES: readonly InkBrushMode[] = ['fixed', 'pressure'];
const VALID_CAP_STYLES: readonly InkCapStyle[] = ['round', 'arrow', 'closed-arrow', 'taper'];

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** 提取节点的几何重建选项 */
export function resolveInkGeometryOptions(
  node: Readonly<NodeEntity>,
  definition?: NodeTypeDefinition
): InkStrokeGeometryOptions {
  const style = resolveNodeStyle(node, definition);
  const ink = node.ink;
  const strokeWidth =
    typeof style.strokeWidth === 'number' && Number.isFinite(style.strokeWidth) && style.strokeWidth > 0
      ? style.strokeWidth
      : DEFAULT_INK_STROKE_WIDTH;
  return {
    mode: ink?.mode === 'fixed' ? 'fixed' : 'pressure',
    strokeWidth,
    thinning: ink?.thinning ?? DEFAULT_INK_THINNING,
    smoothing: ink?.smoothing ?? DEFAULT_INK_SMOOTHING,
    startCap: ink?.startCap,
    endCap: ink?.endCap,
    strokeDashArray: style.strokeDashArray
  };
}

/**
 * 校验 node.ink 专有结构的完整性 (纯函数)
 * 通过返回 null，损坏返回具体原因供内核缓存与降级渲染使用
 */
export function validateInkNode(node: Readonly<NodeEntity>): string | null {
  if (!Number.isFinite(node.width) || node.width < 0 || !Number.isFinite(node.height) || node.height < 0) {
    return 'ink 节点宽高必须为非负有限数值';
  }
  const ink = node.ink;
  if (!ink || typeof ink !== 'object' || Array.isArray(ink)) {
    return '缺少合法的 node.ink 专有字段';
  }
  if (!VALID_MODES.includes(ink.mode)) {
    return `无效的画笔模式: ${String(ink.mode)}`;
  }
  if (!Array.isArray(ink.samples) || ink.samples.length === 0) {
    return 'ink.samples 必须为非空采样数组';
  }
  if (ink.samples.length > INK_MAX_SAMPLES) {
    return `ink.samples 超出最大点数上限 (${INK_MAX_SAMPLES})`;
  }
  if (ink.thinning !== undefined && !isFiniteInRange(ink.thinning, 0, 1)) {
    return 'ink.thinning 必须为 [0, 1] 之间的有限数值';
  }
  if (ink.smoothing !== undefined && !isFiniteInRange(ink.smoothing, 0, 1)) {
    return 'ink.smoothing 必须为 [0, 1] 之间的有限数值';
  }
  if (ink.startCap !== undefined && !VALID_CAP_STYLES.includes(ink.startCap)) {
    return `无效的起始端点样式: ${String(ink.startCap)}`;
  }
  if (ink.endCap !== undefined && !VALID_CAP_STYLES.includes(ink.endCap)) {
    return `无效的结束端点样式: ${String(ink.endCap)}`;
  }
  for (let i = 0; i < ink.samples.length; i++) {
    const s = ink.samples[i];
    if (
      !s ||
      typeof s !== 'object' ||
      typeof s.x !== 'number' ||
      !Number.isFinite(s.x) ||
      typeof s.y !== 'number' ||
      !Number.isFinite(s.y) ||
      !isFiniteInRange(s.pressure, 0, 1)
    ) {
      return `ink.samples[${i}] 坐标或压力非法`;
    }
  }
  return null;
}

export class InkNodeType implements NodeTypeDefinition {
  static readonly TYPE = 'ink';

  readonly type = InkNodeType.TYPE;
  readonly label = '笔迹';
  readonly defaultData = {};
  readonly sizingPolicy: NodeSizingPolicy = 'fixed';
  readonly defaultAspectLocked = true;
  readonly scaleContentOnCorners = true;
  readonly defaultStyle: NodeStyle = {
    strokeWidth: DEFAULT_INK_STROKE_WIDTH,
    strokeCap: 'round',
    strokeJoin: 'round'
  };

  /** 按节点 ID 缓存已生成的图元，节点内容未变时 O(1) 复用 */
  private readonly pathCache = new Map<string, CachedInkPrimitives>();

  /** 清理指定节点或全部节点的运行时派生路径缓存 */
  clearCache(nodeId?: string): void {
    if (nodeId !== undefined) this.pathCache.delete(nodeId);
    else this.pathCache.clear();
  }

  /** 读取当前缓存条目数 (供测试与基准核验内存回收) */
  get cacheSize(): number {
    return this.pathCache.size;
  }

  validate(node: Readonly<NodeEntity>): string | null {
    return validateInkNode(node);
  }

  createContent(options: InkCreateOptions = {}): NodeCreateContent {
    const rawSamples = options.samples;
    const samples =
      Array.isArray(rawSamples) && rawSamples.length > 0
        ? rawSamples.map((s) => ({
            x: roundInkNum(s.x),
            y: roundInkNum(s.y),
            pressure: roundInkNum(s.pressure)
          }))
        : [
            { x: 0, y: 0, pressure: 0.5 },
            { x: Math.max(1, options.width ?? 100), y: Math.max(1, options.height ?? 100), pressure: 0.5 }
          ];

    let maxX = 0;
    let maxY = 0;
    for (const s of samples) {
      if (s.x > maxX) maxX = s.x;
      if (s.y > maxY) maxY = s.y;
    }

    const strokeWidth = options.strokeWidth ?? DEFAULT_INK_STROKE_WIDTH;
    const width = options.width !== undefined ? roundInkNum(Math.max(0, options.width)) : roundInkNum(maxX);
    const height = options.height !== undefined ? roundInkNum(Math.max(0, options.height)) : roundInkNum(maxY);
    const mode: InkBrushMode = options.mode ?? 'pressure';
    const style: NodeStyle = {
      strokeWidth,
      ...(options.stroke !== undefined && { stroke: options.stroke }),
      ...(options.strokeDashArray !== undefined && { strokeDashArray: options.strokeDashArray }),
      ...(options.strokeOpacity !== undefined && { strokeOpacity: options.strokeOpacity }),
      ...(options.opacity !== undefined && { opacity: options.opacity })
    };

    return {
      width,
      height,
      style,
      ink: {
        mode,
        samples,
        ...(options.thinning !== undefined && { thinning: options.thinning }),
        ...(options.smoothing !== undefined && { smoothing: options.smoothing }),
        ...(options.startCap !== undefined && { startCap: options.startCap }),
        ...(options.endCap !== undefined && { endCap: options.endCap })
      }
    };
  }

  /**
   * 笔迹占据范围：在外框 [0, width] × [0, height] 基础上外扩最大笔触半宽，
   * 确保单点圆点 (0×0) 或纯水平/垂直笔迹在空间索引中拥有完整描边包围盒
   */
  extent(node: NodeEntity): RectBounds {
    const pad = computeMaxInkRadius(resolveInkGeometryOptions(node, this));
    return {
      left: -pad,
      top: -pad,
      right: node.width + pad,
      bottom: node.height + pad
    };
  }

  hitTest(node: NodeEntity, localPoint: Point, tolerance: number): boolean {
    const ink = node.ink;
    if (!ink) return false;
    return hitTestInkStroke(ink.samples, resolveInkGeometryOptions(node, this), localPoint, tolerance);
  }

  intersectsBounds(node: NodeEntity, localBounds: RectBounds): boolean {
    const ink = node.ink;
    if (!ink) return false;
    return intersectsInkStrokeBounds(ink.samples, resolveInkGeometryOptions(node, this), localBounds);
  }

  /**
   * 缩放节点：基于手势开始快照计算新采样点坐标与线宽，不累积多帧浮点误差；
   * 对原跨度为 0 的轴 (如单点或水平/垂直直线) 优先使用 request.scale，严禁除以 0
   */
  applyResize(node: NodeEntity, request: NodeResizeRequest): Partial<NodeEntity> {
    const ink = node.ink;
    if (!ink) return {};
    const sx = node.width > 0 ? request.width / node.width : request.scale;
    const sy = node.height > 0 ? request.height / node.height : request.scale;
    const widthScale =
      request.scale !== 1
        ? request.scale
        : node.width > 0 && node.height > 0
          ? Math.hypot(sx, sy) / Math.SQRT2
          : node.width > 0
            ? sx
            : node.height > 0
              ? sy
              : 1;

    const baseWidth = resolveNodeStyle(node, this).strokeWidth ?? DEFAULT_INK_STROKE_WIDTH;
    const nextStrokeWidth = Math.max(0.5, roundInkNum(baseWidth * widthScale));
    const nextSamples: InkSample[] = ink.samples.map((s) => ({
      x: roundInkNum(s.x * sx),
      y: roundInkNum(s.y * sy),
      pressure: s.pressure
    }));

    return {
      style: {
        ...node.style,
        strokeWidth: nextStrokeWidth
      },
      ink: {
        ...ink,
        samples: nextSamples
      }
    };
  }

  compose(node: NodeEntity, { theme }: NodeComposeContext): CanvasPrimitive[] {
    const ink = node.ink;
    if (!ink || ink.samples.length === 0) return [];

    const style = resolveNodeStyle(node, this);
    const geomOptions = resolveInkGeometryOptions(node, this);
    const color = style.stroke ?? theme.textColor;
    const opacity = style.strokeOpacity ?? style.opacity;

    const cached = this.pathCache.get(node.id);
    if (
      cached &&
      cached.ink === ink &&
      cached.strokeWidth === geomOptions.strokeWidth &&
      cached.strokeDashArray === geomOptions.strokeDashArray &&
      cached.color === color &&
      cached.opacity === opacity
    ) {
      return cached.primitives;
    }

    const primitives = buildInkPrimitives(ink.samples, geomOptions, color, opacity);
    this.pathCache.set(node.id, {
      ink,
      strokeWidth: geomOptions.strokeWidth,
      strokeDashArray: geomOptions.strokeDashArray,
      color,
      opacity,
      primitives
    });
    return primitives;
  }

  /**
   * 切换端点样式时重新全包络计算外框与采样点归一化偏移，
   * 确保选中框、控制柄与空间索引立即紧致包裹手绘箭头两翼
   */
  updateCapStyle(node: Readonly<NodeEntity>, startCap: InkCapStyle, endCap: InkCapStyle): Partial<NodeEntity> {
    const ink = node.ink;
    if (!ink || ink.samples.length === 0) return {};
    const style = resolveNodeStyle(node, this);
    const strokeWidth = style.strokeWidth ?? DEFAULT_INK_STROKE_WIDTH;
    const parentSamples = ink.samples.map((s) => ({
      x: s.x + node.x,
      y: s.y + node.y,
      pressure: s.pressure
    }));
    const normalized = normalizeInkSamples(parentSamples, undefined, {
      mode: ink.mode,
      strokeWidth,
      thinning: ink.thinning,
      smoothing: ink.smoothing,
      startCap,
      endCap
    });
    return {
      x: normalized.x,
      y: normalized.y,
      width: normalized.width,
      height: normalized.height,
      ink: {
        ...ink,
        startCap,
        endCap,
        samples: normalized.samples
      }
    };
  }
}
