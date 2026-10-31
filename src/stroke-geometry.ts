/**
 * @file stroke-geometry.ts
 * @description 画笔笔迹纯几何与增量采样算法：重采样简化、局部坐标归一化、固定宽度平滑路径、压感可变轮廓生成、增量草稿缓冲及精确拾取
 *
 * 设计考量 (Why):
 * 1. 预览与落盘同源：草稿预览 (InkDraftBuffer) 与节点渲染 (InkNodeType.compose) 共用同一套中点二次贝塞尔与压感法线包络算法，
 *    保证松手提交前后视觉零跳变，且保存重载后仅凭 samples 与笔触参数即可重建完全一致的几何。
 * 2. 长笔迹增量更新：连续绘画时每帧只追加新增采样；固定宽度笔缓存已稳定的前段路径前缀，压感笔按 64 点分块缓存已定型的左右轮廓串，
 *    仅重算尾部最后 2~3 个采样点与端帽，避免长笔迹每帧全量扫描复制。
 * 3. 数值确定性与边界守卫：坐标与路径输出统一保留两位小数；显式处理单击圆点、共线折返、尖角法线退化及零宽/零高笔迹。
 */

import {
  applyMatrix,
  type CanvasPointerSample,
  type CanvasPrimitive,
  type Matrix2D,
  type Point,
  type RectBounds
} from '@skynote/core';

/** 画笔笔触模式：'fixed' 固定宽度中心线 | 'pressure' 压感可变宽度轮廓 */
export type InkBrushMode = 'fixed' | 'pressure';

/** 画笔端点样式：'round' 经典圆帽 | 'arrow' 手绘开放单/双翼箭头 | 'closed-arrow' 填充手绘三角形箭头 | 'taper' 尖峰收尾出锋 */
export type InkCapStyle = 'round' | 'arrow' | 'closed-arrow' | 'taper';

/** 单个笔迹采样点 (持久化于 node.ink.samples 时为节点局部坐标) */
export interface InkSample {
  readonly x: number;
  readonly y: number;
  /** 归一化压力 [0, 1] */
  readonly pressure: number;
}

/** 影响笔迹几何重建的参数 */
export interface InkStrokeGeometryOptions {
  readonly mode: InkBrushMode;
  readonly strokeWidth: number;
  /** 压感响应强度 [0, 1]，缺省 0.65 */
  readonly thinning?: number;
  /** 轨迹平滑系数 [0, 1]，缺省 0.5 */
  readonly smoothing?: number;
  /** 起点端点样式 (缺省 'round') */
  readonly startCap?: InkCapStyle;
  /** 终点端点样式 (缺省 'round') */
  readonly endCap?: InkCapStyle;
  /** 描边虚线模式 (仅在 mode === 'fixed' 时有效) */
  readonly strokeDashArray?: number[];
}

/** 世界或父容器采样归一化为节点外框与局部点列后的结果 */
export interface NormalizedInkStroke {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly samples: readonly InkSample[];
}

/** 单条笔迹持久化的最大采样点数上限 (防止异常外部载荷耗尽内存) */
export const INK_MAX_SAMPLES = 4096;
export const DEFAULT_INK_STROKE_WIDTH = 4;
export const DEFAULT_INK_THINNING = 0.65;
export const DEFAULT_INK_SMOOTHING = 0.5;

/** 自然出锋 (Taper) 算法核心比例常数 */
export const INK_TAPER_MIN_WIDTH_FACTOR = 0.75;
export const INK_TAPER_MAX_WIDTH_FACTOR = 2.5;
export const INK_TAPER_MAX_LENGTH_RATIO = 0.25;
export const INK_TAPER_MIN_FACTOR_FLOOR = 0.04;

/** 手绘箭头与端点几何比例常数 */
export const ARROW_MIN_LENGTH = 6;
export const ARROW_MAX_LENGTH = 120;
export const ARROW_RADIUS_SCALE = 5.0;
export const ARROW_SPREAD_RATIO = 0.52;
export const ARROW_MAX_TRIM_RATIO = 0.42;
export const CLOSED_ARROW_TRIM_RATIO = 0.75;
export const CLOSED_ARROW_STROKE_SCALE = 0.55;

/** 压感平滑加权与抬笔 0 压力保护常数 */
export const PRESSURE_UP_COLLAPSE_THRESHOLD = 0.02;
export const PRESSURE_UP_RECOVERY_RATIO = 0.7;
export const PRESSURE_SMOOTH_WEIGHT_CENTER = 0.6;
export const PRESSURE_SMOOTH_WEIGHT_SIDE = 0.2;

/** 判定为单点圆点的最大空间跨度阈值 */
const DOT_EPSILON = 0.05;
/** 压感草稿分块缓存大小：每满 64 个稳定点归档一段路径文本，避免每帧拼接整条长数组 */
const RAIL_CHUNK_SIZE = 64;

/** 坐标保留两位小数，兼顾亚像素平滑度与 JSON 持久化紧凑性 */
export function roundInkNum(value: number): number {
  return Math.round(value * 100) / 100;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function clampRange(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * 根据基础线宽、当前点压力与压感系数计算该点处的笔触半径
 * pressure = 0.5 时等于 strokeWidth / 2；thinning = 0 时退化为固定半径
 */
export function computePressureRadius(strokeWidth: number, pressure: number, thinning = DEFAULT_INK_THINNING): number {
  const half = Math.max(0.25, strokeWidth / 2);
  const t = clamp01(thinning);
  const p = clamp01(pressure);
  const factor = clampRange(1 - t * (0.5 - p) * 1.4, 0.15, 1.35);
  return half * factor;
}

/** 计算节点笔迹可能达到的最大半宽 (用于 extent 外扩与拾取粗筛) */
export function computeMaxInkRadius(options: InkStrokeGeometryOptions): number {
  const half = Math.max(0.25, options.strokeWidth / 2);
  if (options.mode !== 'pressure') return half;
  return computePressureRadius(options.strokeWidth, 1, options.thinning ?? DEFAULT_INK_THINNING);
}

/**
 * 计算折线序列各点沿中轴线的累积物理弧长
 */
export function computeCumulativeArcLengths(points: readonly Point[]): {
  readonly cumulative: readonly number[];
  readonly totalLength: number;
} {
  const n = points.length;
  if (n === 0) return { cumulative: [], totalLength: 0 };
  const cumulative = new Array<number>(n);
  cumulative[0] = 0;
  let total = 0;
  for (let i = 1; i < n; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    total += Math.hypot(dx, dy);
    cumulative[i] = total;
  }
  return { cumulative, totalLength: total };
}

/**
 * 基于物理弧长距离计算采样点 i 处的出锋收敛缩放因子
 * - 核心保证：无论采样点被抽稀到几个点，相同空间位置处的出锋因子恒定不变，草稿与正式实体零视觉跳变；
 * - 两端最大出锋距离各不超过总弧长的 25% 或 2.5 倍基础线宽，保证核心主干永远饱满。
 */
export function computeArcLengthTaperFactor(
  distFromStart: number,
  totalLength: number,
  strokeWidth: number,
  startCap: InkCapStyle,
  endCap: InkCapStyle
): number {
  if (totalLength <= 1e-4) return 1;

  // 出锋最大物理长度：基础线宽的倍数上限，且两端各至多占用总弧长的指定比例
  const maxTaperDistance = Math.max(
    strokeWidth * INK_TAPER_MIN_WIDTH_FACTOR,
    Math.min(strokeWidth * INK_TAPER_MAX_WIDTH_FACTOR, totalLength * INK_TAPER_MAX_LENGTH_RATIO)
  );

  let factor = 1;

  // 起端出锋收敛
  if (startCap === 'taper' && maxTaperDistance > 0 && distFromStart < maxTaperDistance) {
    const t = clamp01(distFromStart / maxTaperDistance);
    // 正弦平滑曲线过渡：避免线性折角突兀
    const startFactor = Math.sin((t * Math.PI) / 2);
    if (startFactor < factor) factor = startFactor;
  }

  // 终端出锋收敛
  const distFromEnd = totalLength - distFromStart;
  if (endCap === 'taper' && maxTaperDistance > 0 && distFromEnd < maxTaperDistance) {
    const t = clamp01(distFromEnd / maxTaperDistance);
    const endFactor = Math.sin((t * Math.PI) / 2);
    if (endFactor < factor) factor = endFactor;
  }

  return Math.max(INK_TAPER_MIN_FACTOR_FLOOR, factor);
}

/** 点到线段 AB 的最短距离及投影参数 t ∈ [0, 1] */
function projectPointToSegment(p: Point, a: Point, b: Point): { distance: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-8) {
    return { distance: Math.hypot(p.x - a.x, p.y - a.y), t: 0 };
  }
  const t = clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq);
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return { distance: Math.hypot(p.x - projX, p.y - projY), t };
}

/**
 * 对原始采样序列执行保尖角与保压感峰值的 Ramer-Douglas-Peucker 简化
 * - 若整条笔迹落点几乎重合 (单击或原地轻点)，折叠为单个采样点并取峰值压力 (避免手写笔抬起瞬间 0 压力覆盖按下压力)。
 * - 显式栈迭代实现，避免超长笔迹递归爆栈。
 */
export function simplifyInkSamples(samples: readonly InkSample[], tolerance = 0.35): InkSample[] {
  if (samples.length === 0) return [];
  if (samples.length === 1) {
    const s = samples[0];
    return [{ x: roundInkNum(s.x), y: roundInkNum(s.y), pressure: roundInkNum(clamp01(s.pressure)) }];
  }

  // 1. 检查是否为原地单击/轻点
  const first = samples[0];
  let maxDist = 0;
  let peakPressure = clamp01(first.pressure);
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    const d = Math.hypot(s.x - first.x, s.y - first.y);
    if (d > maxDist) maxDist = d;
    const p = clamp01(s.pressure);
    if (p > peakPressure) peakPressure = p;
  }
  if (maxDist <= DOT_EPSILON) {
    return [{ x: roundInkNum(first.x), y: roundInkNum(first.y), pressure: roundInkNum(peakPressure) }];
  }

  // 2. 先剔除连续完全重合的冗余点 (保留较高压力)
  const deduped: InkSample[] = [{ x: first.x, y: first.y, pressure: clamp01(first.pressure) }];
  for (let i = 1; i < samples.length; i++) {
    const curr = samples[i];
    const prev = deduped[deduped.length - 1];
    if (Math.hypot(curr.x - prev.x, curr.y - prev.y) <= 1e-3) {
      if (curr.pressure > prev.pressure) {
        deduped[deduped.length - 1] = { x: prev.x, y: prev.y, pressure: clamp01(curr.pressure) };
      }
    } else {
      deduped.push({ x: curr.x, y: curr.y, pressure: clamp01(curr.pressure) });
    }
  }
  if (deduped.length <= 2 || tolerance <= 0) {
    return enforceSampleBudget(
      deduped.map((s) => ({ x: roundInkNum(s.x), y: roundInkNum(s.y), pressure: roundInkNum(s.pressure) }))
    );
  }

  // 3. 迭代式 RDP 简化 (兼顾空间垂距与压力突变)
  const keep = new Uint8Array(deduped.length);
  keep[0] = 1;
  keep[deduped.length - 1] = 1;
  const stack: [number, number][] = [[0, deduped.length - 1]];
  const pressureWeight = Math.max(0.2, tolerance * 1.5);

  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end - start <= 1) continue;
    const a = deduped[start];
    const b = deduped[end];
    let maxMetric = 0;
    let splitIndex = -1;

    for (let i = start + 1; i < end; i++) {
      const p = deduped[i];
      const { distance, t } = projectPointToSegment(p, a, b);
      const expectedPressure = a.pressure + (b.pressure - a.pressure) * t;
      const pressureDiff = Math.abs(p.pressure - expectedPressure) * pressureWeight;
      const metric = Math.max(distance, pressureDiff);
      if (metric > maxMetric) {
        maxMetric = metric;
        splitIndex = i;
      }
    }

    if (maxMetric > tolerance && splitIndex !== -1) {
      keep[splitIndex] = 1;
      stack.push([start, splitIndex], [splitIndex, end]);
    }
  }

  const result: InkSample[] = [];
  for (let i = 0; i < deduped.length; i++) {
    if (keep[i]) {
      const s = deduped[i];
      result.push({
        x: roundInkNum(s.x),
        y: roundInkNum(s.y),
        pressure: roundInkNum(s.pressure)
      });
    }
  }

  return enforceSampleBudget(result);
}

/** 超出 INK_MAX_SAMPLES 时均匀抽稀并保留首尾 */
function enforceSampleBudget(samples: InkSample[]): InkSample[] {
  if (samples.length <= INK_MAX_SAMPLES) return samples;
  const result: InkSample[] = [samples[0]];
  const innerCount = INK_MAX_SAMPLES - 2;
  const step = (samples.length - 1) / (innerCount + 1);
  for (let i = 1; i <= innerCount; i++) {
    result.push(samples[Math.round(i * step)]);
  }
  result.push(samples[samples.length - 1]);
  return result;
}

/**
 * 将世界坐标采样点转换到父容器坐标系，求解緊致包围盒并归一化为节点局部坐标
 * @param worldSamples 世界坐标系下的采样点列
 * @param toParentLocal 世界坐标到父容器局部坐标的逆矩阵 (根层级缺省)
 */
export function normalizeInkSamples(
  worldSamples: readonly InkSample[],
  toParentLocal?: Matrix2D,
  options?: InkStrokeGeometryOptions
): NormalizedInkStroke {
  if (worldSamples.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0, samples: [{ x: 0, y: 0, pressure: 0.5 }] };
  }

  const transformed = toParentLocal
    ? worldSamples.map((s) => {
        const p = applyMatrix(toParentLocal, s.x, s.y);
        return { x: p.x, y: p.y, pressure: clamp01(s.pressure) };
      })
    : worldSamples;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  if (!options) {
    for (const s of transformed) {
      if (s.x < minX) minX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.x > maxX) maxX = s.x;
      if (s.y > maxY) maxY = s.y;
    }

    const x = roundInkNum(minX);
    const y = roundInkNum(minY);
    const width = roundInkNum(Math.max(0, maxX - minX));
    const height = roundInkNum(Math.max(0, maxY - minY));

    const samples = transformed.map((s) => ({
      x: roundInkNum(s.x - x),
      y: roundInkNum(s.y - y),
      pressure: roundInkNum(clamp01(s.pressure))
    }));

    return { x, y, width, height, samples };
  }

  // 含线宽与端帽的完整视觉包围盒 (Visual Bounding Box)
  const n = transformed.length;
  const strokeWidth = Math.max(0.5, options.strokeWidth);
  const thinning = options.thinning ?? DEFAULT_INK_THINNING;
  const mode = options.mode;

  const endCap = options.endCap ?? 'round';
  const startCap = options.startCap ?? 'round';
  const { cumulative, totalLength } = computeCumulativeArcLengths(transformed);

  for (let i = 0; i < n; i++) {
    const s = transformed[i];
    let r = mode === 'pressure' ? computeSmoothedSampleRadius(transformed, i, strokeWidth, thinning) : strokeWidth / 2;
    if (startCap === 'taper' || endCap === 'taper') {
      const taperFactor = computeArcLengthTaperFactor(cumulative[i], totalLength, strokeWidth, startCap, endCap);
      r *= taperFactor;
    }
    if (s.x - r < minX) minX = s.x - r;
    if (s.y - r < minY) minY = s.y - r;
    if (s.x + r > maxX) maxX = s.x + r;
    if (s.y + r > maxY) maxY = s.y + r;
  }

  const totalDist =
    n >= 2 ? Math.hypot(transformed[n - 1].x - transformed[0].x, transformed[n - 1].y - transformed[0].y) : 0;

  if (n >= 2 && (endCap === 'arrow' || endCap === 'closed-arrow')) {
    const tangent = computeEndTangent(transformed);
    const rEnd =
      mode === 'pressure' ? computeSmoothedSampleRadius(transformed, n - 1, strokeWidth, thinning) : strokeWidth / 2;
    const radius = Math.max(rEnd, strokeWidth / 2);
    const tip = {
      x: roundInkNum(transformed[n - 1].x + tangent.x * radius),
      y: roundInkNum(transformed[n - 1].y + tangent.y * radius)
    };
    const arrow = computeArrowHeadGeometry(tip, tangent, radius, totalDist);
    const wingPadding = endCap === 'closed-arrow' ? Math.max(radius, strokeWidth * 0.35 + 2) : radius;
    for (const pt of [arrow.tip, arrow.left, arrow.right]) {
      if (pt.x - wingPadding < minX) minX = pt.x - wingPadding;
      if (pt.y - wingPadding < minY) minY = pt.y - wingPadding;
      if (pt.x + wingPadding > maxX) maxX = pt.x + wingPadding;
      if (pt.y + wingPadding > maxY) maxY = pt.y + wingPadding;
    }
  }

  if (n >= 2 && (startCap === 'arrow' || startCap === 'closed-arrow')) {
    const tangent = computeStartTangent(transformed);
    const rStart =
      mode === 'pressure' ? computeSmoothedSampleRadius(transformed, 0, strokeWidth, thinning) : strokeWidth / 2;
    const radius = Math.max(rStart, strokeWidth / 2);
    const tip = {
      x: roundInkNum(transformed[0].x + tangent.x * radius),
      y: roundInkNum(transformed[0].y + tangent.y * radius)
    };
    const arrow = computeArrowHeadGeometry(tip, tangent, radius, totalDist);
    const wingPadding = startCap === 'closed-arrow' ? Math.max(radius, strokeWidth * 0.35 + 2) : radius;
    for (const pt of [arrow.tip, arrow.left, arrow.right]) {
      if (pt.x - wingPadding < minX) minX = pt.x - wingPadding;
      if (pt.y - wingPadding < minY) minY = pt.y - wingPadding;
      if (pt.x + wingPadding > maxX) maxX = pt.x + wingPadding;
      if (pt.y + wingPadding > maxY) maxY = pt.y + wingPadding;
    }
  }

  const x = roundInkNum(minX);
  const y = roundInkNum(minY);
  const width = roundInkNum(Math.max(0, maxX - minX));
  const height = roundInkNum(Math.max(0, maxY - minY));

  const samples = transformed.map((s) => ({
    x: roundInkNum(s.x - x),
    y: roundInkNum(s.y - y),
    pressure: roundInkNum(clamp01(s.pressure))
  }));

  return { x, y, width, height, samples };
}

/** 生成圆形闭合 SVG Path (用于单点圆点，保证预览与落盘图元一致) */
export function buildDotPathData(cx: number, cy: number, r: number): string {
  const rad = roundInkNum(Math.max(0.25, r));
  const left = roundInkNum(cx - rad);
  const right = roundInkNum(cx + rad);
  const y = roundInkNum(cy);
  return `M ${left} ${y} A ${rad} ${rad} 0 1 0 ${right} ${y} A ${rad} ${rad} 0 1 0 ${left} ${y} Z`;
}

/** 计算终点处加权平均的单位切向量 (向外伸出方向) */
export function computeEndTangent(samples: readonly Point[]): Point {
  const n = samples.length;
  if (n <= 1) return { x: 1, y: 0 };
  const last = samples[n - 1];
  const base = samples[Math.max(0, n - 4)];
  const dx = last.x - base.x;
  const dy = last.y - base.y;
  const len = Math.hypot(dx, dy);
  if (len <= 1e-4) return { x: 1, y: 0 };
  return { x: dx / len, y: dy / len };
}

/** 计算起点处加权平均的单位切向量 (向外伸出离开起点的方向) */
export function computeStartTangent(samples: readonly Point[]): Point {
  const n = samples.length;
  if (n <= 1) return { x: -1, y: 0 };
  const first = samples[0];
  const next = samples[Math.min(n - 1, 3)];
  const dx = first.x - next.x;
  const dy = first.y - next.y;
  const len = Math.hypot(dx, dy);
  if (len <= 1e-4) return { x: -1, y: 0 };
  return { x: dx / len, y: dy / len };
}

export interface ArrowHeadGeometry {
  readonly tip: Point;
  readonly left: Point;
  readonly right: Point;
  readonly barb: Point;
  readonly length: number;
}

/** 求解手绘质感箭头的关键几何点 (顶点、左翼端点、右翼端点、倒刺中心点) */
export function computeArrowHeadGeometry(
  tip: Point,
  tangent: Point,
  radius: number,
  maxSpan?: number
): ArrowHeadGeometry {
  const nx = -tangent.y;
  const ny = tangent.x;
  // 箭头尺寸与线宽粗细严格正相关：base 保证细线清晰精炼，动态缩放保证粗线大气协调且不被线身吞没
  let length = Math.max(ARROW_MIN_LENGTH, Math.min(ARROW_MAX_LENGTH, ARROW_MIN_LENGTH + radius * ARROW_RADIUS_SCALE));
  if (maxSpan !== undefined && maxSpan > 0) {
    length = Math.min(length, maxSpan * ARROW_MAX_TRIM_RATIO);
  }
  const spread = length * ARROW_SPREAD_RATIO;
  const left: Point = {
    x: roundInkNum(tip.x - tangent.x * length + nx * spread),
    y: roundInkNum(tip.y - tangent.y * length + ny * spread)
  };
  const right: Point = {
    x: roundInkNum(tip.x - tangent.x * length - nx * spread),
    y: roundInkNum(tip.y - tangent.y * length - ny * spread)
  };
  const barb: Point = {
    x: roundInkNum(tip.x - tangent.x * length),
    y: roundInkNum(tip.y - tangent.y * length)
  };
  return { tip, left, right, barb, length };
}

/** 格式化手绘开放双翼箭头线段 SVG 命令序列 (strokeCap/Join 均为 round 时自然连缀) */
export function formatFixedArrowCommands(arrow: { tip: Point; left: Point; right: Point }): string {
  return ` M ${arrow.left.x} ${arrow.left.y} L ${arrow.tip.x} ${arrow.tip.y} L ${arrow.right.x} ${arrow.right.y}`;
}

/** 格式化闭合三角形箭头 SVG 命令序列 (在开放箭头双翼基础上直接首尾闭合连接) */
export function formatClosedArrowCommands(arrow: { tip: Point; left: Point; right: Point }): string {
  return ` M ${arrow.tip.x} ${arrow.tip.y} L ${arrow.left.x} ${arrow.left.y} L ${arrow.right.x} ${arrow.right.y} Z`;
}

/** 求解折线总弧长 */
export function computePolylineLength(pts: readonly Point[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return len;
}

function extractPointPressure(point: unknown): number {
  if (typeof point === 'object' && point !== null && 'pressure' in point) {
    const raw = (point as { pressure: unknown }).pressure;
    const num = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(num)) return num;
  }
  return 0.5;
}

/** 沿采样点折线沿弧长裁剪首尾指定距离，裁剪掉进入箭头头部的中间过冲采样点 */
export function trimPolylinePoints<T extends Point>(pts: readonly T[], trimStart: number, trimEnd: number): T[] {
  const n = pts.length;
  if (n < 2) return pts.slice();

  const totalLen = computePolylineLength(pts);
  const maxAllowedTrim = totalLen * ARROW_MAX_TRIM_RATIO;
  const safeTrimEnd = Math.min(trimEnd, maxAllowedTrim);
  const safeTrimStart = Math.min(trimStart, maxAllowedTrim);

  const result = pts.slice();

  // 1. 裁剪尾部
  if (safeTrimEnd > 0 && result.length >= 2) {
    let rem = safeTrimEnd;
    while (result.length >= 2 && rem > 0) {
      const last = result[result.length - 1];
      const prev = result[result.length - 2];
      const d = Math.hypot(last.x - prev.x, last.y - prev.y);
      if (d <= 1e-4) {
        result.pop();
        continue;
      }
      if (d <= rem) {
        rem -= d;
        result.pop();
      } else {
        const t = (d - rem) / d;
        const lastPressure = extractPointPressure(last);
        const prevPressure = extractPointPressure(prev);
        const trimmedLast = {
          ...last,
          x: roundInkNum(prev.x + (last.x - prev.x) * t),
          y: roundInkNum(prev.y + (last.y - prev.y) * t),
          ...('pressure' in last && {
            pressure: roundInkNum(prevPressure + (lastPressure - prevPressure) * t)
          })
        };
        result[result.length - 1] = trimmedLast as T;
        rem = 0;
        break;
      }
    }
  }

  // 2. 裁剪首部
  if (safeTrimStart > 0 && result.length >= 2) {
    let rem = safeTrimStart;
    while (result.length >= 2 && rem > 0) {
      const first = result[0];
      const next = result[1];
      const d = Math.hypot(next.x - first.x, next.y - first.y);
      if (d <= 1e-4) {
        result.shift();
        continue;
      }
      if (d <= rem) {
        rem -= d;
        result.shift();
      } else {
        const t = rem / d;
        const firstPressure = extractPointPressure(first);
        const nextPressure = extractPointPressure(next);
        const trimmedFirst = {
          ...first,
          x: roundInkNum(first.x + (next.x - first.x) * t),
          y: roundInkNum(first.y + (next.y - first.y) * t),
          ...('pressure' in first && {
            pressure: roundInkNum(firstPressure + (nextPressure - firstPressure) * t)
          })
        };
        result[0] = trimmedFirst as T;
        rem = 0;
        break;
      }
    }
  }

  return result.length >= 2 ? result : pts.slice();
}

/**
 * 生成固定宽度中心线的平滑 SVG Path (二次贝塞尔中点插值)
 * smoothing ∈ [0, 1]：0 为折线，> 0 时以采样点为控制点、相邻点中点为锚点平滑过渡
 */
export function buildFixedStrokePathData(
  samples: readonly Point[],
  strokeWidth = DEFAULT_INK_STROKE_WIDTH,
  smoothing = DEFAULT_INK_SMOOTHING,
  startCap: InkCapStyle = 'round',
  endCap: InkCapStyle = 'round'
): string {
  const n = samples.length;
  if (n === 0) return '';
  const p0 = samples[0];
  if (n === 1) {
    const x = roundInkNum(p0.x);
    const y = roundInkNum(p0.y);
    return `M ${x} ${y} L ${x} ${y}`;
  }

  const pLast = samples[n - 1];
  const radius = strokeWidth / 2;
  const totalDist = Math.hypot(pLast.x - p0.x, pLast.y - p0.y);

  // 1. 计算终点箭头与主干缩进截断点
  const endHasClosedArrow = endCap === 'closed-arrow';
  const startHasClosedArrow = startCap === 'closed-arrow';
  const endHasArrow = endCap === 'arrow' || endHasClosedArrow;
  const startHasArrow = startCap === 'arrow' || startHasClosedArrow;

  let endTip = pLast;
  let endTangent = { x: 1, y: 0 };
  let endArrow: ArrowHeadGeometry | null = null;

  if (endHasArrow && n >= 2) {
    endTangent = computeEndTangent(samples);
    endTip = {
      x: roundInkNum(pLast.x + endTangent.x * radius),
      y: roundInkNum(pLast.y + endTangent.y * radius)
    };
    endArrow = computeArrowHeadGeometry(endTip, endTangent, radius, totalDist);
  }

  // 2. 计算起点箭头与主干缩进起始点
  let startTip = p0;
  let startTangent = { x: -1, y: 0 };
  let startArrow: ArrowHeadGeometry | null = null;

  if (startHasArrow && n >= 2) {
    startTangent = computeStartTangent(samples);
    startTip = {
      x: roundInkNum(p0.x + startTangent.x * radius),
      y: roundInkNum(p0.y + startTangent.y * radius)
    };
    startArrow = computeArrowHeadGeometry(startTip, startTangent, radius, totalDist);
  }

  // 裁剪主干首尾：闭合箭头缩进到箭头后腹部，彻底裁剪中间采样点，避免主干在箭头窄前端凸出鼓包
  const endTrim = endArrow
    ? endHasClosedArrow
      ? Math.max(0, endArrow.length * CLOSED_ARROW_TRIM_RATIO - radius)
      : radius * 0.2
    : 0;
  const startTrim = startArrow
    ? startHasClosedArrow
      ? Math.max(0, startArrow.length * CLOSED_ARROW_TRIM_RATIO - radius)
      : radius * 0.2
    : 0;

  const trimmed = trimPolylinePoints(samples, startTrim, endTrim);
  const m = trimmed.length;

  // 3. 构建中心平滑曲线
  const s = clamp01(smoothing);
  let d = `M ${roundInkNum(trimmed[0].x)} ${roundInkNum(trimmed[0].y)}`;
  if (m === 2 || s <= 0.01) {
    d += ` L ${roundInkNum(trimmed[m - 1].x)} ${roundInkNum(trimmed[m - 1].y)}`;
  } else {
    for (let i = 1; i < m - 1; i++) {
      const curr = trimmed[i];
      const next = trimmed[i + 1];
      const midX = curr.x + (next.x - curr.x) * (0.5 * s + (1 - s));
      const midY = curr.y + (next.y - curr.y) * (0.5 * s + (1 - s));
      d += ` Q ${roundInkNum(curr.x)} ${roundInkNum(curr.y)} ${roundInkNum(midX)} ${roundInkNum(midY)}`;
    }
    d += ` L ${roundInkNum(trimmed[m - 1].x)} ${roundInkNum(trimmed[m - 1].y)}`;
  }

  // 4. 连缀开放箭头翼展 (双翼开放箭头使用描边与主线一体成型)
  if (endArrow && endCap === 'arrow') {
    d += formatFixedArrowCommands(endArrow);
  }
  if (startArrow && startCap === 'arrow') {
    d += formatFixedArrowCommands(startArrow);
  }

  return d;
}

/** 计算采样点 i 处的单位切向量与左法向量 */
function computeSampleNormal(samples: readonly InkSample[], index: number): Point {
  const n = samples.length;
  const curr = samples[index];
  const prev = index > 0 ? samples[index - 1] : curr;
  const next = index < n - 1 ? samples[index + 1] : curr;

  let dx = next.x - prev.x;
  let dy = next.y - prev.y;
  let len = Math.hypot(dx, dy);
  if (len <= 1e-5) {
    // 若前后点重合 (如快速折返尖角)，退化取单侧方向
    dx = index < n - 1 ? next.x - curr.x : curr.x - prev.x;
    dy = index < n - 1 ? next.y - curr.y : curr.y - prev.y;
    len = Math.hypot(dx, dy);
  }
  if (len <= 1e-5) return { x: 0, y: -1 };
  return { x: -dy / len, y: dx / len };
}

/** 计算点 i 处经邻域平滑后的有效半径 */
function computeSmoothedSampleRadius(
  samples: readonly InkSample[],
  index: number,
  strokeWidth: number,
  thinning: number
): number {
  const n = samples.length;
  const curr = samples[index].pressure;

  // 抬笔末点采样平滑保护：
  // 若末点由于 W3C pointerup 离屏规范上报为 0 压力，而前序点有正常按压 (> 0.05)，
  // 在平滑计算中末点压感参考倒数第二点平稳过渡，避免抬笔假 0 压力污染倒数第二点和末点有效粗细
  let pEnd = samples[n - 1].pressure;
  if (n >= 2 && pEnd <= PRESSURE_UP_COLLAPSE_THRESHOLD && samples[n - 2].pressure > 0.05) {
    pEnd = samples[n - 2].pressure * PRESSURE_UP_RECOVERY_RATIO;
  }

  const prev = index === 0 ? curr : index - 1 === n - 1 ? pEnd : samples[index - 1].pressure;
  const curP = index === n - 1 ? pEnd : curr;
  const next = index >= n - 1 ? curP : index + 1 === n - 1 ? pEnd : samples[index + 1].pressure;

  const smoothedPressure =
    prev * PRESSURE_SMOOTH_WEIGHT_SIDE + curP * PRESSURE_SMOOTH_WEIGHT_CENTER + next * PRESSURE_SMOOTH_WEIGHT_SIDE;
  return computePressureRadius(strokeWidth, smoothedPressure, thinning);
}

/** 计算采样点 i 对应的左右轮廓包络点与半径 */
function computeEnvelopePair(
  samples: readonly InkSample[],
  index: number,
  strokeWidth: number,
  thinning: number
): { left: Point; right: Point; radius: number } {
  const s = samples[index];
  const normal = computeSampleNormal(samples, index);
  const radius = computeSmoothedSampleRadius(samples, index, strokeWidth, thinning);
  return {
    left: { x: roundInkNum(s.x + normal.x * radius), y: roundInkNum(s.y + normal.y * radius) },
    right: { x: roundInkNum(s.x - normal.x * radius), y: roundInkNum(s.y - normal.y * radius) },
    radius: roundInkNum(radius)
  };
}

/** 将轮廓轨点列格式化为平滑二次贝塞尔或直线段命令序列 (不含起点 M) */
function formatRailSegmentCommands(
  rail: readonly Point[],
  startIdx: number,
  endIdx: number,
  smoothing: number
): string {
  if (endIdx <= startIdx) return '';
  const useCurve = smoothing > 0.01;
  let cmd = '';
  for (let i = startIdx; i < endIdx; i++) {
    const curr = rail[i];
    const next = rail[i + 1];
    if (useCurve && i < rail.length - 1) {
      const midX = roundInkNum((curr.x + next.x) / 2);
      const midY = roundInkNum((curr.y + next.y) / 2);
      cmd += ` Q ${curr.x} ${curr.y} ${midX} ${midY}`;
    } else {
      cmd += ` L ${next.x} ${next.y}`;
    }
  }
  return cmd;
}

/**
 * 生成压感笔触的闭合可变宽度轮廓 SVG Path
 * 单点或极短点迹自动生成圆点闭合路径；多点轨迹生成 左轨 + 终点圆帽 + 右轨逆序 + 起点圆帽 的平滑包络
 */
export function buildPressureOutlinePathData(
  samples: readonly InkSample[],
  strokeWidth: number,
  thinning = DEFAULT_INK_THINNING,
  smoothing = DEFAULT_INK_SMOOTHING,
  startCap: InkCapStyle = 'round',
  endCap: InkCapStyle = 'round'
): string {
  const n = samples.length;
  if (n === 0) return '';
  if (n === 1) {
    const r = computePressureRadius(strokeWidth, samples[0].pressure, thinning);
    return buildDotPathData(samples[0].x, samples[0].y, r);
  }

  let maxSpan = 0;
  let peakPressure = samples[0].pressure;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(samples[i].x - samples[0].x, samples[i].y - samples[0].y);
    if (d > maxSpan) maxSpan = d;
    if (samples[i].pressure > peakPressure) peakPressure = samples[i].pressure;
  }
  if (maxSpan <= DOT_EPSILON) {
    const r = computePressureRadius(strokeWidth, peakPressure, thinning);
    return buildDotPathData(samples[0].x, samples[0].y, r);
  }

  const { cumulative, totalLength } = computeCumulativeArcLengths(samples);

  const leftRail: Point[] = new Array(n);
  const rightRail: Point[] = new Array(n);
  const radii: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const normal = computeSampleNormal(samples, i);
    let radius = computeSmoothedSampleRadius(samples, i, strokeWidth, thinning);
    if (startCap === 'taper' || endCap === 'taper') {
      const taperFactor = computeArcLengthTaperFactor(cumulative[i], totalLength, strokeWidth, startCap, endCap);
      radius = roundInkNum(radius * taperFactor);
    }
    leftRail[i] = { x: roundInkNum(s.x + normal.x * radius), y: roundInkNum(s.y + normal.y * radius) };
    rightRail[i] = { x: roundInkNum(s.x - normal.x * radius), y: roundInkNum(s.y - normal.y * radius) };
    radii[i] = roundInkNum(radius);
  }

  const s = clamp01(smoothing);
  const startLeft = leftRail[0];
  const endLeft = leftRail[n - 1];
  const endRight = rightRail[n - 1];
  const startRight = rightRail[0];
  const rStart = radii[0];
  const rEnd = radii[n - 1];

  let d = `M ${startLeft.x} ${startLeft.y}`;
  d += formatRailSegmentCommands(leftRail, 0, n - 1, s);
  if (endCap === 'taper') {
    d += ` L ${roundInkNum(samples[n - 1].x)} ${roundInkNum(samples[n - 1].y)}`;
  } else if (endCap === 'arrow' || endCap === 'closed-arrow') {
    // 箭头模式下主干平滑截断于箭头基座交界处，避免圆帽外露鼓包
    d += ` L ${endLeft.x} ${endLeft.y} L ${endRight.x} ${endRight.y}`;
  } else {
    d += ` L ${endLeft.x} ${endLeft.y} A ${rEnd} ${rEnd} 0 0 0 ${endRight.x} ${endRight.y}`;
  }

  // 右轨逆序返回起点
  if (s > 0.01 && n > 2) {
    for (let i = n - 1; i > 0; i--) {
      const curr = rightRail[i];
      const prev = rightRail[i - 1];
      const midX = roundInkNum((curr.x + prev.x) / 2);
      const midY = roundInkNum((curr.y + prev.y) / 2);
      d += ` Q ${curr.x} ${curr.y} ${midX} ${midY}`;
    }
  } else {
    for (let i = n - 2; i >= 0; i--) {
      d += ` L ${rightRail[i].x} ${rightRail[i].y}`;
    }
  }
  if (startCap === 'taper') {
    d += ` L ${roundInkNum(samples[0].x)} ${roundInkNum(samples[0].y)} Z`;
  } else if (startCap === 'arrow' || startCap === 'closed-arrow') {
    d += ` L ${startRight.x} ${startRight.y} L ${startLeft.x} ${startLeft.y} Z`;
  } else {
    d += ` L ${startRight.x} ${startRight.y} A ${rStart} ${rStart} 0 0 0 ${startLeft.x} ${startLeft.y} Z`;
  }

  return d;
}

/** 统一根据笔触模式生成 SVG 路径 d 字符串 */
export function buildInkPathData(samples: readonly InkSample[], options: InkStrokeGeometryOptions): string {
  const n = samples.length;
  if (n === 0) return '';
  const smoothing = options.smoothing ?? DEFAULT_INK_SMOOTHING;
  const startCap = options.startCap ?? 'round';
  const endCap = options.endCap ?? 'round';
  if (options.mode === 'pressure') {
    const strokeWidth = options.strokeWidth;
    const thinning = options.thinning ?? DEFAULT_INK_THINNING;
    const totalDist = n >= 2 ? Math.hypot(samples[n - 1].x - samples[0].x, samples[n - 1].y - samples[0].y) : 0;

    let pressureSamples = samples;
    if (n >= 2 && (endCap === 'closed-arrow' || startCap === 'closed-arrow')) {
      const rEnd = computeSmoothedSampleRadius(samples, n - 1, strokeWidth, thinning);
      const radiusEnd = Math.max(rEnd, strokeWidth / 2);
      const rStart = computeSmoothedSampleRadius(samples, 0, strokeWidth, thinning);
      const radiusStart = Math.max(rStart, strokeWidth / 2);

      const arrowEnd =
        endCap === 'closed-arrow'
          ? computeArrowHeadGeometry(samples[n - 1], { x: 1, y: 0 }, radiusEnd, totalDist)
          : null;
      const arrowStart =
        startCap === 'closed-arrow'
          ? computeArrowHeadGeometry(samples[0], { x: -1, y: 0 }, radiusStart, totalDist)
          : null;

      const endTrim = arrowEnd ? Math.max(0, arrowEnd.length * 0.75 - radiusEnd) : 0;
      const startTrim = arrowStart ? Math.max(0, arrowStart.length * 0.75 - radiusStart) : 0;
      pressureSamples = trimPolylinePoints(samples, startTrim, endTrim);
    }

    let d = buildPressureOutlinePathData(pressureSamples, strokeWidth, thinning, smoothing, startCap, endCap);
    if (n >= 2 && (endCap === 'closed-arrow' || startCap === 'closed-arrow')) {
      if (endCap === 'closed-arrow') {
        const tangent = computeEndTangent(samples);
        const rEnd = computeSmoothedSampleRadius(samples, n - 1, strokeWidth, thinning);
        const radius = Math.max(rEnd, strokeWidth / 2);
        const tip = {
          x: roundInkNum(samples[n - 1].x + tangent.x * radius),
          y: roundInkNum(samples[n - 1].y + tangent.y * radius)
        };
        const arrow = computeArrowHeadGeometry(tip, tangent, radius, totalDist);
        d += formatClosedArrowCommands(arrow);
      }
      if (startCap === 'closed-arrow') {
        const tangent = computeStartTangent(samples);
        const rStart = computeSmoothedSampleRadius(samples, 0, strokeWidth, thinning);
        const radius = Math.max(rStart, strokeWidth / 2);
        const tip = {
          x: roundInkNum(samples[0].x + tangent.x * radius),
          y: roundInkNum(samples[0].y + tangent.y * radius)
        };
        const arrow = computeArrowHeadGeometry(tip, tangent, radius, totalDist);
        d += formatClosedArrowCommands(arrow);
      }
    }
    return d;
  }
  if (n === 1) {
    return buildDotPathData(samples[0].x, samples[0].y, options.strokeWidth / 2);
  }
  return buildFixedStrokePathData(samples, options.strokeWidth, smoothing, startCap, endCap);
}

/** 统一根据笔触模式与端点样式生成渲染图元集合 (图元间零裁切与零互斥) */
export function buildInkPrimitives(
  samples: readonly InkSample[],
  options: InkStrokeGeometryOptions,
  color: string,
  opacity?: number
): CanvasPrimitive[] {
  const n = samples.length;
  if (n === 0) return [];
  const strokeWidth = options.strokeWidth ?? DEFAULT_INK_STROKE_WIDTH;
  const smoothing = options.smoothing ?? DEFAULT_INK_SMOOTHING;
  const startCap = options.startCap ?? 'round';
  const endCap = options.endCap ?? 'round';
  const mode = options.mode;

  if (n === 1) {
    const r =
      mode === 'pressure' ? computePressureRadius(strokeWidth, samples[0].pressure, options.thinning) : strokeWidth / 2;
    return [
      {
        kind: 'path',
        d: buildDotPathData(samples[0].x, samples[0].y, r),
        fill: color,
        ...(opacity !== undefined && { fillOpacity: opacity })
      }
    ];
  }

  const totalDist = Math.hypot(samples[n - 1].x - samples[0].x, samples[n - 1].y - samples[0].y);

  if (mode === 'fixed') {
    // 若开启了自然出锋 (taper) 且无虚线：使用 thinning=0 的均匀轮廓面实现首尾自然出锋
    if (
      (startCap === 'taper' || endCap === 'taper') &&
      (!options.strokeDashArray || options.strokeDashArray.length === 0)
    ) {
      const taperOutlineD = buildPressureOutlinePathData(samples, strokeWidth, 0, smoothing, startCap, endCap);
      return [
        {
          kind: 'path',
          d: taperOutlineD,
          fill: color,
          ...(opacity !== undefined && { fillOpacity: opacity })
        }
      ];
    }

    const fixedD = buildFixedStrokePathData(samples, strokeWidth, smoothing, startCap, endCap);
    const primitives: CanvasPrimitive[] = [
      {
        kind: 'path',
        d: fixedD,
        stroke: color,
        strokeWidth,
        strokeCap: 'round',
        strokeJoin: 'round',
        ...(options.strokeDashArray && { strokeDashArray: options.strokeDashArray }),
        ...(opacity !== undefined && { strokeOpacity: opacity })
      }
    ];
    if (n >= 2 && (endCap === 'closed-arrow' || startCap === 'closed-arrow')) {
      const radius = strokeWidth / 2;
      let closedD = '';
      if (endCap === 'closed-arrow') {
        const tangent = computeEndTangent(samples);
        const tip = {
          x: roundInkNum(samples[n - 1].x + tangent.x * radius),
          y: roundInkNum(samples[n - 1].y + tangent.y * radius)
        };
        const arrow = computeArrowHeadGeometry(tip, tangent, radius, totalDist);
        closedD += formatClosedArrowCommands(arrow);
      }
      if (startCap === 'closed-arrow') {
        const tangent = computeStartTangent(samples);
        const tip = {
          x: roundInkNum(samples[0].x + tangent.x * radius),
          y: roundInkNum(samples[0].y + tangent.y * radius)
        };
        const arrow = computeArrowHeadGeometry(tip, tangent, radius, totalDist);
        closedD += formatClosedArrowCommands(arrow);
      }
      if (closedD) {
        const closedStrokeWidth = Math.max(4, strokeWidth * 0.55);
        primitives.push({
          kind: 'path',
          d: closedD,
          fill: color,
          stroke: color,
          strokeWidth: closedStrokeWidth,
          strokeCap: 'round',
          strokeJoin: 'round',
          ...(opacity !== undefined && { fillOpacity: opacity, strokeOpacity: opacity })
        });
      }
    }
    return primitives;
  }

  // mode === 'pressure'
  const thinning = options.thinning ?? DEFAULT_INK_THINNING;
  let pressureSamples = samples;
  if (n >= 2 && (endCap === 'closed-arrow' || startCap === 'closed-arrow')) {
    const rEnd = computeSmoothedSampleRadius(samples, n - 1, strokeWidth, thinning);
    const radiusEnd = Math.max(rEnd, strokeWidth / 2);
    const rStart = computeSmoothedSampleRadius(samples, 0, strokeWidth, thinning);
    const radiusStart = Math.max(rStart, strokeWidth / 2);

    const arrowEnd =
      endCap === 'closed-arrow' ? computeArrowHeadGeometry(samples[n - 1], { x: 1, y: 0 }, radiusEnd, totalDist) : null;
    const arrowStart =
      startCap === 'closed-arrow'
        ? computeArrowHeadGeometry(samples[0], { x: -1, y: 0 }, radiusStart, totalDist)
        : null;

    const endTrim = arrowEnd ? Math.max(0, arrowEnd.length * 0.75 - radiusEnd) : 0;
    const startTrim = arrowStart ? Math.max(0, arrowStart.length * 0.75 - radiusStart) : 0;
    pressureSamples = trimPolylinePoints(samples, startTrim, endTrim);
  }

  const bodyD = buildPressureOutlinePathData(pressureSamples, strokeWidth, thinning, smoothing, startCap, endCap);
  const primitives: CanvasPrimitive[] = [
    {
      kind: 'path',
      d: bodyD,
      fill: color,
      ...(opacity !== undefined && { fillOpacity: opacity })
    }
  ];

  if (n >= 2 && (endCap === 'arrow' || startCap === 'arrow')) {
    let wingsD = '';
    let arrowWidth = strokeWidth;

    if (endCap === 'arrow') {
      const tangent = computeEndTangent(samples);
      const rEnd = computeSmoothedSampleRadius(samples, n - 1, strokeWidth, thinning);
      const radius = Math.max(rEnd, strokeWidth / 2);
      arrowWidth = Math.max(1, Math.min(strokeWidth, radius * 2));
      const tip = {
        x: roundInkNum(samples[n - 1].x + tangent.x * radius),
        y: roundInkNum(samples[n - 1].y + tangent.y * radius)
      };
      const arrow = computeArrowHeadGeometry(tip, tangent, radius, totalDist);
      wingsD += formatFixedArrowCommands(arrow);
    }
    if (startCap === 'arrow') {
      const tangent = computeStartTangent(samples);
      const rStart = computeSmoothedSampleRadius(samples, 0, strokeWidth, thinning);
      const radius = Math.max(rStart, strokeWidth / 2);
      arrowWidth = Math.max(1, Math.min(strokeWidth, radius * 2));
      const tip = {
        x: roundInkNum(samples[0].x + tangent.x * radius),
        y: roundInkNum(samples[0].y + tangent.y * radius)
      };
      const arrow = computeArrowHeadGeometry(tip, tangent, radius, totalDist);
      wingsD += formatFixedArrowCommands(arrow);
    }

    if (wingsD) {
      primitives.push({
        kind: 'path',
        d: wingsD,
        stroke: color,
        strokeWidth: arrowWidth,
        strokeCap: 'round',
        strokeJoin: 'round',
        ...(opacity !== undefined && { strokeOpacity: opacity })
      });
    }
  }

  if (n >= 2 && (endCap === 'closed-arrow' || startCap === 'closed-arrow')) {
    let closedD = '';
    if (endCap === 'closed-arrow') {
      const tangent = computeEndTangent(samples);
      const rEnd = computeSmoothedSampleRadius(samples, n - 1, strokeWidth, thinning);
      const radius = Math.max(rEnd, strokeWidth / 2);
      const tip = {
        x: roundInkNum(samples[n - 1].x + tangent.x * radius),
        y: roundInkNum(samples[n - 1].y + tangent.y * radius)
      };
      const arrow = computeArrowHeadGeometry(tip, tangent, radius, totalDist);
      closedD += formatClosedArrowCommands(arrow);
    }
    if (startCap === 'closed-arrow') {
      const tangent = computeStartTangent(samples);
      const rStart = computeSmoothedSampleRadius(samples, 0, strokeWidth, thinning);
      const radius = Math.max(rStart, strokeWidth / 2);
      const tip = {
        x: roundInkNum(samples[0].x + tangent.x * radius),
        y: roundInkNum(samples[0].y + tangent.y * radius)
      };
      const arrow = computeArrowHeadGeometry(tip, tangent, radius, totalDist);
      closedD += formatClosedArrowCommands(arrow);
    }
    if (closedD) {
      const closedStrokeWidth = Math.max(4, strokeWidth * CLOSED_ARROW_STROKE_SCALE);
      primitives.push({
        kind: 'path',
        d: closedD,
        fill: color,
        stroke: color,
        strokeWidth: closedStrokeWidth,
        strokeCap: 'round',
        strokeJoin: 'round',
        ...(opacity !== undefined && { fillOpacity: opacity, strokeOpacity: opacity })
      });
    }
  }

  return primitives;
}

/**
 * 连续绘画增量草稿缓冲：
 * - 按最小间距阈值接纳新样本，保留最新末端位置与压力峰值。
 * - 固定宽度模式：递增拼接稳定前段路径前缀 (`stableFixedPrefix`)，每帧仅计算尾部 2 点。
 * - 压感模式：增量定型 `index <= length - 3` 的左右轮廓点，并按 64 点分块缓存正反向路径片段，
 *   避免长笔迹在高频 pointermove 中全量重算或全量拼接数组。
 */
interface InkDraftBufferResolvedOptions {
  readonly mode: InkBrushMode;
  readonly strokeWidth: number;
  readonly thinning: number;
  readonly smoothing: number;
  readonly startCap: InkCapStyle;
  readonly endCap: InkCapStyle;
  readonly strokeDashArray?: number[];
}

export class InkDraftBuffer {
  private readonly rawSamples: InkSample[] = [];
  private readonly options: InkDraftBufferResolvedOptions;
  private readonly strokeColor: string;
  private readonly opacity: number;

  // 固定宽度增量前缀状态
  private fixedCommittedIndex = 0;
  private fixedPrefix = '';

  // 压感轮廓增量缓存状态
  private readonly leftRail: Point[] = [];
  private readonly rightRail: Point[] = [];
  private readonly radii: number[] = [];
  private pressureCommittedCount = 0;
  private readonly leftChunks: string[] = [];
  private readonly rightChunksReverse: string[] = [];

  constructor(
    options: InkStrokeGeometryOptions & {
      readonly strokeColor: string;
      readonly opacity?: number;
    }
  ) {
    this.options = {
      mode: options.mode,
      strokeWidth: Math.max(0.5, options.strokeWidth),
      thinning: options.thinning ?? DEFAULT_INK_THINNING,
      smoothing: options.smoothing ?? DEFAULT_INK_SMOOTHING,
      startCap: options.startCap ?? 'round',
      endCap: options.endCap ?? 'round',
      strokeDashArray: options.strokeDashArray
    };
    this.strokeColor = options.strokeColor;
    this.opacity = options.opacity ?? 1;
  }

  get sampleCount(): number {
    return this.rawSamples.length;
  }

  get samples(): readonly InkSample[] {
    return this.rawSamples;
  }

  /**
   * 追加同帧指针采样批次
   * @param batch CanvasPointerEvent.samples
   * @param minDistance 最小世界坐标采样间距 (过滤抖动噪声，末点或压力明显变化时仍更新)
   */
  appendSamples(batch: readonly CanvasPointerSample[], minDistance: number): void {
    for (let i = 0; i < batch.length; i++) {
      const s = batch[i];
      const pressure = clamp01(s.pressure);
      const n = this.rawSamples.length;
      if (n === 0) {
        this.rawSamples.push({ x: s.point.x, y: s.point.y, pressure });
        continue;
      }
      const prev = this.rawSamples[n - 1];
      const dist = Math.hypot(s.point.x - prev.x, s.point.y - prev.y);
      if (dist >= minDistance) {
        if (this.rawSamples.length < INK_MAX_SAMPLES) {
          this.rawSamples.push({ x: s.point.x, y: s.point.y, pressure });
        } else {
          this.rawSamples[n - 1] = { x: s.point.x, y: s.point.y, pressure };
        }
      } else if (Math.abs(pressure - prev.pressure) >= 0.08) {
        // 位置几乎未动但压力显著变化 (如原地按压)：就地更新末点为峰值压力
        this.rawSamples[n - 1] = {
          x: s.point.x,
          y: s.point.y,
          pressure: Math.max(prev.pressure, pressure)
        };
      }
    }
    this.advanceStableCache();
  }

  /** 将已远离尾部的稳定采样点推进到定型缓存中 */
  private advanceStableCache(): void {
    const n = this.rawSamples.length;
    const { mode, strokeWidth, thinning, smoothing } = this.options;

    if (mode === 'fixed') {
      // 固定宽度：前 n - 2 个点之间的中点二次曲线段已完全固定
      const targetIndex = n - 2;
      if (targetIndex <= this.fixedCommittedIndex) return;
      if (this.fixedCommittedIndex === 0) {
        const p0 = this.rawSamples[0];
        this.fixedPrefix = `M ${roundInkNum(p0.x)} ${roundInkNum(p0.y)}`;
      }
      const s = clamp01(smoothing);
      for (let i = Math.max(1, this.fixedCommittedIndex + 1); i <= targetIndex; i++) {
        const curr = this.rawSamples[i];
        const next = this.rawSamples[i + 1];
        if (s <= 0.01) {
          this.fixedPrefix += ` L ${roundInkNum(curr.x)} ${roundInkNum(curr.y)}`;
        } else {
          const midX = curr.x + (next.x - curr.x) * (0.5 * s + (1 - s));
          const midY = curr.y + (next.y - curr.y) * (0.5 * s + (1 - s));
          this.fixedPrefix += ` Q ${roundInkNum(curr.x)} ${roundInkNum(curr.y)} ${roundInkNum(midX)} ${roundInkNum(midY)}`;
        }
      }
      this.fixedCommittedIndex = targetIndex;
      return;
    }

    // 压感模式：点 i 的切线与平滑半径只依赖 [i - 1, i + 1]，故 i <= n - 3 的包络点已完全定型
    const safeCount = Math.max(0, n - 2);
    while (this.pressureCommittedCount < safeCount) {
      const idx = this.pressureCommittedCount;
      const env = computeEnvelopePair(this.rawSamples, idx, strokeWidth, thinning);
      this.leftRail[idx] = env.left;
      this.rightRail[idx] = env.right;
      this.radii[idx] = env.radius;
      this.pressureCommittedCount++;

      // 每满一个 64 点分块，归档该分块的正向(左轨)与逆向(右轨) SVG 片段
      const chunkEnd = this.pressureCommittedCount - 1;
      if (chunkEnd > 0 && chunkEnd % RAIL_CHUNK_SIZE === 0) {
        const chunkStart = chunkEnd - RAIL_CHUNK_SIZE;
        this.leftChunks.push(formatRailSegmentCommands(this.leftRail, chunkStart, chunkEnd, smoothing));
        this.rightChunksReverse.push(this.formatRightChunkReverse(chunkStart, chunkEnd, smoothing));
      }
    }
  }

  private formatRightChunkReverse(startIdx: number, endIdx: number, smoothing: number): string {
    const useCurve = clamp01(smoothing) > 0.01;
    let cmd = '';
    for (let i = endIdx; i > startIdx; i--) {
      const curr = this.rightRail[i];
      const prev = this.rightRail[i - 1];
      if (useCurve) {
        const midX = roundInkNum((curr.x + prev.x) / 2);
        const midY = roundInkNum((curr.y + prev.y) / 2);
        cmd += ` Q ${curr.x} ${curr.y} ${midX} ${midY}`;
      } else {
        cmd += ` L ${prev.x} ${prev.y}`;
      }
    }
    return cmd;
  }

  /** 生成当前草稿的世界坐标声明式预览图元 */
  /** 生成当前草稿的世界坐标声明式预览图元 (保证草稿预览与落盘图元完全同源同构) */
  toPrimitives(): CanvasPrimitive[] {
    return buildInkPrimitives(this.rawSamples, this.options, this.strokeColor, this.opacity);
  }

  /** 结束绘制时对采样点执行简化与局部坐标归一化 */
  finalize(simplifyTolerance: number, toParentLocal?: Matrix2D): NormalizedInkStroke {
    const simplified = simplifyInkSamples(this.rawSamples, simplifyTolerance);
    return normalizeInkSamples(simplified, toParentLocal, this.options);
  }
}

/**
 * 精确点选命中判定 (局部坐标系)：
 * 点到任一笔迹折线段的距离 <= 该处笔触半径 + 屏幕容差时命中，空白外框角不命中
 */
export function hitTestInkStroke(
  samples: readonly InkSample[],
  options: InkStrokeGeometryOptions,
  localPoint: Point,
  tolerance: number
): boolean {
  const n = samples.length;
  if (n === 0) return false;
  const maxR = computeMaxInkRadius(options);
  const tol = Math.max(0, tolerance);

  if (n === 1) {
    const r =
      options.mode === 'pressure'
        ? computePressureRadius(options.strokeWidth, samples[0].pressure, options.thinning)
        : Math.max(0.25, options.strokeWidth / 2);
    return Math.hypot(localPoint.x - samples[0].x, localPoint.y - samples[0].y) <= r + tol;
  }

  for (let i = 0; i < n - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    // 线段级 AABB 快速排斥
    const pad = maxR + tol;
    if (
      localPoint.x < Math.min(a.x, b.x) - pad ||
      localPoint.x > Math.max(a.x, b.x) + pad ||
      localPoint.y < Math.min(a.y, b.y) - pad ||
      localPoint.y > Math.max(a.y, b.y) + pad
    ) {
      continue;
    }
    const { distance, t } = projectPointToSegment(localPoint, a, b);
    const radius =
      options.mode === 'pressure'
        ? computePressureRadius(options.strokeWidth, a.pressure + (b.pressure - a.pressure) * t, options.thinning)
        : Math.max(0.25, options.strokeWidth / 2);
    if (distance <= radius + tol) return true;
  }
  return false;
}

/** 判定线段 AB 是否与轴对齐矩形 rect 相交 (Liang-Barsky 裁剪算法) */
function segmentIntersectsRect(a: Point, b: Point, rect: RectBounds): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - rect.left, rect.right - a.x, a.y - rect.top, rect.bottom - a.y];

  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) <= 1e-8) {
      if (q[i] < 0) return false;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0 <= t1;
}

/**
 * 局部坐标系下选框与笔迹的精确相交判定：
 * 将选框外扩笔迹半宽后，检查是否有采样点或折线段穿过选框，避免擦过斜向笔迹的空白外框角时误选
 */
export function intersectsInkStrokeBounds(
  samples: readonly InkSample[],
  options: InkStrokeGeometryOptions,
  localBounds: RectBounds
): boolean {
  const n = samples.length;
  if (n === 0) return false;
  const pad = computeMaxInkRadius(options);
  const expanded: RectBounds = {
    left: localBounds.left - pad,
    top: localBounds.top - pad,
    right: localBounds.right + pad,
    bottom: localBounds.bottom + pad
  };

  if (n === 1) {
    const s = samples[0];
    return s.x >= expanded.left && s.x <= expanded.right && s.y >= expanded.top && s.y <= expanded.bottom;
  }

  for (let i = 0; i < n - 1; i++) {
    if (segmentIntersectsRect(samples[i], samples[i + 1], expanded)) return true;
  }
  return false;
}
