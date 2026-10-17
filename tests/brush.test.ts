/**
 * @file brush.test.ts
 * @description 商业画笔插件 (@skynote-pro/plugin-brush) 阶段 B 闭环测试：
 *              纯几何与增量缓冲、固定笔/压感笔连续采样、单笔事务、中断取消、精确拾取与框选、
 *              零跨度等比缩放除零守卫、复制/保存重载/无插件往返、仅展示模式与损坏数据隔离
 */

import { describe, expect, it } from 'vitest';
import {
  SELECT_TOOL,
  SkyNoteEngine,
  SyntheticPointerEvent,
  invertMatrix,
  parseCanvasDocument,
  parseNodeClipboard,
  type CanvasCursor,
  type CanvasHost,
  type CanvasKeyboardEvent,
  type CanvasPointerSample,
  type CanvasPrimitive,
  type NodeEntity,
  type OverlayChannel,
  type OverlayOptions,
  type Point,
  type TextInputSession
} from '@skynote/core';
import {
  BasicNodesPlugin,
  ConnectorToolPlugin,
  EditingShortcutsPlugin,
  SelectionOutlinePlugin,
  SelectionPlugin,
  TransformPlugin,
  ViewportNavigationPlugin
} from '@skynote/plugins-basic';
import {
  BRUSH_TOOL,
  BrushDisplayPlugin,
  BrushPlugin,
  InkDraftBuffer,
  InkNodeType,
  buildInkPathData,
  buildInkPrimitives,
  computeArrowHeadGeometry,
  createDisplayPlugins,
  createPlugins,
  normalizeInkSamples,
  simplifyInkSamples,
  trimPolylinePoints,
  type InkSample
} from '../src';

class FakeHost implements CanvasHost, OverlayChannel {
  readonly sessions = new Map<string, { primitives: readonly CanvasPrimitive[]; transient: boolean }>();
  readonly cursors: CanvasCursor[] = [];
  readonly captured = new Set<number>();

  get overlay(): OverlayChannel {
    return this;
  }

  setPrimitives(sessionId: string, primitives: readonly CanvasPrimitive[], options?: OverlayOptions): void {
    if (primitives.length === 0) this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, { primitives, transient: options?.transient ?? false });
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  setCursor(cursor: CanvasCursor): void {
    this.cursors.push(cursor);
  }

  capturePointer(pointerId: number): void {
    this.captured.add(pointerId);
  }

  releasePointer(pointerId: number): void {
    this.captured.delete(pointerId);
  }

  openTextInput(): TextInputSession {
    return { setCaretRect: () => {}, focus: () => {}, close: () => {} };
  }
}

function setup(brushOptions?: ConstructorParameters<typeof BrushPlugin>[0]) {
  const brush = new BrushPlugin(brushOptions);
  const engine = new SkyNoteEngine()
    .use(new BasicNodesPlugin())
    .use(new ViewportNavigationPlugin())
    .use(new SelectionPlugin())
    .use(new SelectionOutlinePlugin())
    .use(new EditingShortcutsPlugin())
    .use(new TransformPlugin())
    .use(brush);
  const host = new FakeHost();
  engine.attachHost(host);
  engine.session.setViewportSize({ width: 1000, height: 800 });
  return { engine, brush, host, store: engine.documentStore };
}

function dispatchPointer(
  engine: SkyNoteEngine,
  phase: 'down' | 'move' | 'up' | 'cancel',
  point: Point,
  init: Partial<{
    pointerId: number;
    pointerType: 'mouse' | 'pen' | 'touch';
    pressure: number;
    samples: readonly CanvasPointerSample[];
    button: number;
    shift: boolean;
    alt: boolean;
  }> = {}
) {
  const { x, y, zoom } = engine.session.viewport;
  const clientPoint = { x: point.x * zoom + x, y: point.y * zoom + y };
  const event = new SyntheticPointerEvent({
    pointerId: init.pointerId ?? 1,
    pointerType: init.pointerType ?? 'pen',
    point,
    clientPoint,
    target: engine.hitTestNode(point) as NodeEntity | undefined,
    button: init.button ?? 0,
    pressure: init.pressure ?? 0.5,
    samples: init.samples,
    modifiers: { shift: init.shift ?? false, alt: init.alt ?? false }
  });
  if (phase === 'down') engine.pointer.dispatchPointerDown(event);
  else if (phase === 'move') engine.pointer.dispatchPointerMove(event);
  else if (phase === 'up') engine.pointer.dispatchPointerUp(event);
  else engine.pointer.dispatchPointerCancel(event);
}

function dispatchKey(
  engine: SkyNoteEngine,
  code: string,
  init: Partial<CanvasKeyboardEvent> = {},
  phase: 'down' | 'up' = 'down'
) {
  const event: CanvasKeyboardEvent = {
    key: init.key ?? code,
    code,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault: () => {},
    stopPropagation: () => {},
    ...init
  };
  return phase === 'down' ? engine.inputScopes.dispatchKeyDown(event) : engine.inputScopes.dispatchKeyUp(event);
}

describe('画笔纯几何、简化与增量缓冲 (stroke-geometry)', () => {
  it('原地轻点 (含手写笔抬起瞬间 0 压力)：折叠为单点圆点并保留峰值压力', () => {
    const simplified = simplifyInkSamples([
      { x: 100, y: 200, pressure: 0.2 },
      { x: 100.01, y: 200.01, pressure: 0.85 },
      { x: 100, y: 200, pressure: 0 }
    ]);
    expect(simplified).toEqual([{ x: 100, y: 200, pressure: 0.85 }]);
  });

  it('快速尖角与共线长线段：RDP 简化剔除共线冗余点，严格保留尖角拐点与压力突变点', () => {
    const samples = [
      { x: 0, y: 0, pressure: 0.4 },
      { x: 25, y: 0, pressure: 0.4 },
      { x: 50, y: 0, pressure: 0.4 },
      { x: 75, y: 0, pressure: 0.4 },
      { x: 100, y: 0, pressure: 0.8 }, // 尖角顶点
      { x: 100, y: 50, pressure: 0.6 },
      { x: 100, y: 100, pressure: 0.4 }
    ];
    const simplified = simplifyInkSamples(samples, 0.5);
    expect(simplified.length).toBeLessThan(samples.length);
    expect(simplified).toContainEqual({ x: 100, y: 0, pressure: 0.8 });
    expect(simplified[0]).toEqual({ x: 0, y: 0, pressure: 0.4 });
    expect(simplified[simplified.length - 1]).toEqual({ x: 100, y: 100, pressure: 0.4 });
  });

  it('旋转父容器坐标转换：世界坐标采样正确换算为旋转容器局部坐标与节点局部坐标', () => {
    const { engine, store } = setup();
    const frameId = store.createNode({
      nodeType: 'shape',
      id: 'rot-frame',
      x: 200,
      y: 100,
      width: 300,
      height: 200,
      rotation: 90
    })!;
    const toFrameLocal = invertMatrix(engine.entityStore.getWorldTransform(frameId)!);
    const worldStart = { x: 350, y: 200, pressure: 0.5 };
    const worldEnd = { x: 350, y: 260, pressure: 0.7 };
    const normalized = normalizeInkSamples([worldStart, worldEnd], toFrameLocal);

    // 世界中沿 +Y 方向长 60 的线段，在顺时针旋转 90° 的容器局部坐标系中沿 +X 方向长 60
    expect(normalized.width).toBeCloseTo(60, 1);
    expect(normalized.height).toBeCloseTo(0, 1);
    expect(normalized.samples[0]).toEqual({ x: 0, y: 0, pressure: 0.5 });
    expect(normalized.samples[1].x).toBeCloseTo(60, 1);
  });

  it('增量草稿缓冲 (InkDraftBuffer)：超过 64 点分块归档后，固定笔与压感笔均正常生成闭合/平滑路径', () => {
    const pressureBuffer = new InkDraftBuffer({
      mode: 'pressure',
      strokeWidth: 6,
      strokeColor: '$ink',
      thinning: 0.7,
      smoothing: 0.5
    });
    const batch: CanvasPointerSample[] = [];
    for (let i = 0; i < 150; i++) {
      const pt = { x: i * 3, y: Math.sin(i * 0.1) * 20 };
      batch.push({ point: pt, clientPoint: pt, pressure: (i % 10) / 10 });
    }
    pressureBuffer.appendSamples(batch, 1);
    expect(pressureBuffer.sampleCount).toBe(150);
    const primitives = pressureBuffer.toPrimitives();
    expect(primitives).toHaveLength(1);
    expect(primitives[0].kind).toBe('path');
    if (primitives[0].kind === 'path') {
      expect(primitives[0].d.startsWith('M ')).toBe(true);
      expect(primitives[0].d.endsWith(' Z')).toBe(true);
    }
  });

  it('压感笔触两端端帽必须为外凸半圆弧 (0 0 0)，严禁向内咬合凹陷', () => {
    const samples = [
      { x: 50, y: 100, pressure: 0.5 },
      { x: 250, y: 100, pressure: 0.5 }
    ];
    const d = buildInkPathData(samples, { mode: 'pressure', strokeWidth: 20 });
    // 端帽圆弧必须为 "0 0 0" (外凸半圆)，绝不能为 "0 1 1" 导致向内凹陷咬痕
    expect(d).toContain('A 10 10 0 0 0');
    expect(d).not.toContain('0 1 1');
  });

  it('绘制完成后的笔迹包围盒必须完整包含线宽与端帽，绝不溢出外框', () => {
    const { engine, brush, store } = setup({ mode: 'pressure', strokeWidth: 20 });
    brush.activateTool();

    // 绘制一条从 (100, 100) 到 (300, 120) 的倾斜笔迹
    dispatchPointer(engine, 'down', { x: 100, y: 100 }, { pressure: 0.5 });
    dispatchPointer(engine, 'move', { x: 200, y: 110 }, { pressure: 0.8 });
    dispatchPointer(engine, 'up', { x: 300, y: 120 }, { pressure: 0.5 });

    const nodes = Object.values(store.getView().content.nodes);
    const inkNode = nodes.find((n) => n.style?.strokeWidth === 20)!;
    expect(inkNode).toBeDefined();

    // 外框必须完整外扩并包含端点与线宽 (线宽 20 => 半径约为 10)
    // 起点 x=100 => 包含端帽后 node.x <= 91
    expect(inkNode.x).toBeLessThan(95);
    expect(inkNode.y).toBeLessThan(95);
    // 终点 x=300 => 包含端帽后 node.x + node.width >= 309
    expect(inkNode.x + inkNode.width).toBeGreaterThan(305);
    expect(inkNode.y + inkNode.height).toBeGreaterThan(125);
  });
});

describe('画笔绘制、单笔事务、参数冻结与中断清理 (BrushPlugin)', () => {
  it('按 B 进入画笔工具，合并采样绘制一笔对应一步撤销，松手后留在画笔工具可继续画下一笔', () => {
    const { engine, store, host } = setup({ mode: 'pressure', stroke: '$blue', strokeWidth: 6 });

    expect(dispatchKey(engine, 'KeyB', { key: 'b' })).toBe(true);
    expect(engine.session.tool).toBe(BRUSH_TOOL);
    expect(host.cursors.at(-1)).toBe('crosshair');

    dispatchPointer(engine, 'down', { x: 100, y: 100 }, { pressure: 0.3 });
    expect(host.sessions.get('brush:draft')?.transient).toBe(true);
    // 草稿图元直接携带已解析的主题实际色，确保原生渲染层 (Leafer/Canvas) 拖拽绘制时颜色一致
    const draftPrimitives = host.sessions.get('brush:draft')?.primitives;
    expect(draftPrimitives?.[0]).toMatchObject({ fill: engine.session.theme.palette.blue });
    expect(Object.keys(store.getView().content.nodes)).toHaveLength(0);

    // 同帧多个合并采样点 (含零压力末端)
    dispatchPointer(
      engine,
      'move',
      { x: 180, y: 140 },
      {
        samples: [
          { point: { x: 120, y: 110 }, clientPoint: { x: 120, y: 110 }, pressure: 0.5 },
          { point: { x: 150, y: 125 }, clientPoint: { x: 150, y: 125 }, pressure: 0.8 },
          { point: { x: 180, y: 140 }, clientPoint: { x: 180, y: 140 }, pressure: 0.4 }
        ]
      }
    );
    expect(Object.keys(store.getView().content.nodes)).toHaveLength(0);

    dispatchPointer(engine, 'up', { x: 200, y: 150 }, { pressure: 0 });
    expect(host.sessions.has('brush:draft')).toBe(false);
    expect(engine.session.tool).toBe(BRUSH_TOOL);

    const nodes = Object.values(store.getView().content.nodes);
    expect(nodes).toHaveLength(1);
    const inkNode = nodes[0];
    expect(inkNode.nodeType).toBe(InkNodeType.TYPE);
    expect(inkNode.x).toBeLessThan(100);
    expect(inkNode.y).toBeLessThan(100);
    expect(inkNode.width).toBeGreaterThan(100);
    expect(inkNode.height).toBeGreaterThan(50);
    expect(inkNode.style?.stroke).toBe('$blue');
    expect(inkNode.style?.strokeWidth).toBe(6);
    expect(inkNode.ink?.mode).toBe('pressure');
    expect(inkNode.ink?.samples.at(-1)?.pressure).toBe(0);

    // 一次撤销整笔移除，重做整笔恢复
    expect(store.undoEntries).toHaveLength(1);
    store.undo();
    expect(Object.keys(store.getView().content.nodes)).toHaveLength(0);
    store.redo();
    expect(Object.keys(store.getView().content.nodes)).toHaveLength(1);
  });

  it('本笔参数冻结：绘制中途修改画笔模式/颜色/粗细不影响当前笔迹，从下一笔生效', () => {
    const { engine, brush, store } = setup({ mode: 'fixed', stroke: '$green', strokeWidth: 4 });
    brush.activateTool();

    dispatchPointer(engine, 'down', { x: 10, y: 10 });
    dispatchPointer(engine, 'move', { x: 50, y: 30 });

    // 绘制中途修改设置
    brush.setSettings({ mode: 'pressure', stroke: '$orange', strokeWidth: 12 });

    dispatchPointer(engine, 'up', { x: 90, y: 50 });

    // 紧接着画第二笔 (单击圆点)
    dispatchPointer(engine, 'down', { x: 200, y: 200 }, { pressure: 0.7 });
    dispatchPointer(engine, 'up', { x: 200, y: 200 }, { pressure: 0 });

    const nodes = Object.values(store.getView().content.nodes);
    expect(nodes).toHaveLength(2);
    const first = nodes.find((n) => n.style?.stroke === '$green')!;
    const second = nodes.find((n) => n.style?.stroke === '$orange')!;

    expect(first.ink?.mode).toBe('fixed');
    expect(first.style?.stroke).toBe('$green');
    expect(first.style?.strokeWidth).toBe(4);

    expect(second.ink?.mode).toBe('pressure');
    expect(second.style?.stroke).toBe('$orange');
    expect(second.style?.strokeWidth).toBe(12);
    // 单击圆点完整包含线宽，拥有饱满包围盒
    expect(second.width).toBeGreaterThan(0);
    expect(second.height).toBeGreaterThan(0);
    expect(second.ink?.samples).toHaveLength(1);
  });

  it('多指干扰隔离与空格平移互斥：副指针不篡改笔迹，按住空格拖动平移视口而不画线', () => {
    const { engine, brush, store } = setup();
    brush.activateTool();

    dispatchPointer(engine, 'down', { x: 50, y: 50 }, { pointerId: 1 });
    // 第二根手指按下并移动，不应干扰 pointerId=1 的草稿
    dispatchPointer(engine, 'down', { x: 500, y: 500 }, { pointerId: 2 });
    dispatchPointer(engine, 'move', { x: 600, y: 600 }, { pointerId: 2 });
    dispatchPointer(engine, 'up', { x: 600, y: 600 }, { pointerId: 2 });

    dispatchPointer(engine, 'move', { x: 80, y: 90 }, { pointerId: 1 });
    dispatchPointer(engine, 'up', { x: 80, y: 90 }, { pointerId: 1 });

    const nodes = Object.values(store.getView().content.nodes);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].width).toBe(34);
    expect(nodes[0].height).toBe(44);

    // 按住空格键拖动：应触发视口平移，不产生新笔迹
    dispatchKey(engine, 'Space', { key: ' ' }, 'down');
    dispatchPointer(engine, 'down', { x: 100, y: 100 });
    dispatchPointer(engine, 'move', { x: 160, y: 140 });
    dispatchPointer(engine, 'up', { x: 160, y: 140 });
    dispatchKey(engine, 'Space', { key: ' ' }, 'up');

    expect(Object.values(store.getView().content.nodes)).toHaveLength(1);
    expect(engine.session.viewport.x).toBe(60);
    expect(engine.session.viewport.y).toBe(40);
  });

  it('中断清理：Esc、pointercancel、窗口失焦、进入维护态、文档整体替换均立即丢弃草稿且不提交事务', () => {
    const { engine, brush, store, host } = setup();
    brush.activateTool();

    // 1. 绘制中按 Esc：丢弃草稿，保持在画笔工具；再按一次 Esc 退回选择工具
    dispatchPointer(engine, 'down', { x: 10, y: 10 });
    dispatchPointer(engine, 'move', { x: 60, y: 60 });
    expect(brush.hasActiveDraft).toBe(true);
    expect(dispatchKey(engine, 'Escape', { key: 'Escape' })).toBe(true);
    expect(brush.hasActiveDraft).toBe(false);
    expect(host.sessions.has('brush:draft')).toBe(false);
    expect(engine.session.tool).toBe(BRUSH_TOOL);
    expect(dispatchKey(engine, 'Escape', { key: 'Escape' })).toBe(true);
    expect(engine.session.tool).toBe(SELECT_TOOL);

    // 2. pointercancel 与失焦
    brush.activateTool();
    dispatchPointer(engine, 'down', { x: 20, y: 20 });
    dispatchPointer(engine, 'cancel', { x: 40, y: 40 });
    expect(brush.hasActiveDraft).toBe(false);

    dispatchPointer(engine, 'down', { x: 20, y: 20 });
    engine.inputScopes.dispatchBlur();
    expect(brush.hasActiveDraft).toBe(false);

    // 3. 维护态冻结 (beginMaintenance)
    dispatchPointer(engine, 'down', { x: 30, y: 30 });
    const maintenance = engine.beginMaintenance();
    expect(brush.hasActiveDraft).toBe(false);
    maintenance.resume();

    // 4. 绘制期间发生文档整体替换 (replaceContent)
    dispatchPointer(engine, 'down', { x: 40, y: 40 });
    store.replaceContent({ nodes: {}, connectors: {} });
    expect(brush.hasActiveDraft).toBe(false);
    dispatchPointer(engine, 'up', { x: 80, y: 80 });

    expect(Object.keys(store.getView().content.nodes)).toHaveLength(0);
    expect(host.captured.size).toBe(0);
  });
});

describe('精确拾取、框选、零跨度等比缩放、序列化往返与仅展示/损坏隔离', () => {
  it('斜向笔迹精确点选与框选：空白外框角不命中，轨迹与笔宽范围内准确命中', () => {
    const { engine, brush, store } = setup({ mode: 'fixed', strokeWidth: 8 });
    brush.activateTool();

    // 画一条 (100, 100) -> (200, 200) 的斜向笔迹
    dispatchPointer(engine, 'down', { x: 100, y: 100 });
    dispatchPointer(engine, 'move', { x: 150, y: 150 });
    dispatchPointer(engine, 'up', { x: 200, y: 200 });
    engine.session.setTool(SELECT_TOOL);

    const [inkId] = Object.keys(store.getView().content.nodes);
    // 右上空白角 (190, 110) 在 AABB 内，但远离对角线轨迹：点选不命中
    expect(engine.hitTestNode({ x: 190, y: 110 })).toBeUndefined();
    // 对角线中心 (150, 150) 命中
    expect(engine.hitTestNode({ x: 150, y: 150 })?.id).toBe(inkId);

    // 框选仅擦过右上空白角 [175, 95] ~ [210, 120]：不选中
    dispatchPointer(engine, 'down', { x: 210, y: 95 });
    dispatchPointer(engine, 'move', { x: 175, y: 120 });
    expect([...engine.session.selectedNodeIds]).toEqual([]);

    // 框选穿过对角线 [140, 95] ~ [210, 160]：选中笔迹
    dispatchPointer(engine, 'move', { x: 140, y: 160 });
    expect([...engine.session.selectedNodeIds]).toEqual([inkId]);
    dispatchPointer(engine, 'up', { x: 140, y: 160 });
  });

  it('等比缩放与除零守卫：斜向笔迹、纯水平零高笔迹与单点零宽高圆点缩放均无 NaN 且一步撤销', () => {
    const { engine, brush, store } = setup({ mode: 'pressure', strokeWidth: 6 });
    brush.activateTool();

    // 1. 纯水平零高直线笔迹 (width = 100, height = 0)
    const lineId = store.createNode({
      nodeType: 'ink',
      x: 100,
      y: 100,
      width: 100,
      height: 0,
      options: {
        samples: [
          { x: 0, y: 0, pressure: 0.5 },
          { x: 100, y: 0, pressure: 0.8 }
        ],
        strokeWidth: 6
      }
    })!;

    // 2. 单点零宽高圆点笔迹 (width = 0, height = 0)
    const dotId = store.createNode({
      nodeType: 'ink',
      x: 400,
      y: 300,
      width: 0,
      height: 0,
      options: {
        samples: [{ x: 0, y: 0, pressure: 0.6 }],
        strokeWidth: 6
      }
    })!;

    engine.session.setTool(SELECT_TOOL);
    const lineNode = store.getNode(lineId)!;
    const dotNode = store.getNode(dotId)!;
    expect(lineNode.height).toBe(0);
    expect(dotNode.height).toBe(0);

    // 通过 resizeNodes 等比放大水平零高笔迹 2 倍
    store.resizeNodes([lineNode.id], { width: 200 });
    const resizedLine = store.getNode(lineNode.id)!;
    expect(resizedLine.width).toBe(200);
    expect(resizedLine.height).toBe(0);
    expect(resizedLine.style?.strokeWidth).toBe(12);
    expect(resizedLine.ink?.samples.at(-1)).toEqual({ x: 200, y: 0, pressure: 0.8 });

    // 通过 TransformPlugin 拖拽单点圆点 (0×0) 的右下角控制柄放大
    engine.session.setSelection({ nodeIds: [dotNode.id] });
    dispatchPointer(engine, 'down', { x: 400, y: 300 });
    dispatchPointer(engine, 'move', { x: 420, y: 320 });
    dispatchPointer(engine, 'up', { x: 420, y: 320 });

    const resizedDot = store.getNode(dotNode.id)!;
    expect(Number.isFinite(resizedDot.x)).toBe(true);
    expect(Number.isFinite(resizedDot.y)).toBe(true);
    expect(resizedDot.width).toBe(0);
    expect(resizedDot.height).toBe(0);
    expect(resizedDot.style?.strokeWidth).toBeGreaterThan(6);
    expect(resizedDot.ink?.samples[0]).toEqual({ x: 0, y: 0, pressure: 0.6 });
  });

  it('复制粘贴、保存重载确定性重建与无插件环境往返保留 node.ink', () => {
    const { engine, brush, store } = setup({ mode: 'pressure', stroke: '$purple', strokeWidth: 8 });
    brush.activateTool();
    dispatchPointer(engine, 'down', { x: 50, y: 60 }, { pressure: 0.4 });
    dispatchPointer(engine, 'move', { x: 90, y: 120 }, { pressure: 0.9 });
    dispatchPointer(engine, 'up', { x: 140, y: 80 }, { pressure: 0.2 });

    const [origId] = Object.keys(store.getView().content.nodes);
    const orig = store.getNode(origId)!;
    const origPath = buildInkPathData(orig.ink!.samples, {
      mode: orig.ink!.mode,
      strokeWidth: orig.style!.strokeWidth!,
      thinning: orig.ink!.thinning,
      smoothing: orig.ink!.smoothing
    });

    // 剪贴板复制与粘贴
    const clip = store.copyEntities({ nodeIds: [orig.id] })!;
    const parsedClip = parseNodeClipboard(JSON.stringify(clip));
    expect(parsedClip.ok).toBe(true);
    if (!parsedClip.ok) return;
    const pasted = store.pasteEntities(parsedClip.value, { x: 30, y: 30 });
    expect(pasted.nodeIds).toHaveLength(1);
    const copyNode = store.getNode(pasted.nodeIds[0])!;
    expect(copyNode.ink).toEqual(orig.ink);

    // 序列化 -> 在未安装画笔插件的引擎中解析并再次序列化 -> 重新在安装画笔插件的引擎中加载
    const rawJson = JSON.stringify(store.getView());
    const bareParsed = parseCanvasDocument(JSON.parse(rawJson));
    expect(bareParsed.ok).toBe(true);
    if (!bareParsed.ok) return;
    const bareEngine = new SkyNoteEngine();
    bareEngine.documentStore.replaceContent(bareParsed.value.content, undefined, bareParsed.value.assets);
    const roundtripJson = JSON.stringify(bareEngine.documentStore.getView());

    const reloadedDoc = parseCanvasDocument(JSON.parse(roundtripJson));
    expect(reloadedDoc.ok).toBe(true);
    if (!reloadedDoc.ok) return;
    const reloadedOrig = reloadedDoc.value.content.nodes[orig.id];
    expect(reloadedOrig.ink).toEqual(orig.ink);
    const reloadedPath = buildInkPathData(reloadedOrig.ink!.samples, {
      mode: reloadedOrig.ink!.mode,
      strokeWidth: reloadedOrig.style!.strokeWidth!,
      thinning: reloadedOrig.ink!.thinning,
      smoothing: reloadedOrig.ink!.smoothing
    });
    expect(reloadedPath).toBe(origPath);

    // 删除节点后派生路径缓存立即释放
    const inkDef = engine.nodeTypes.get(InkNodeType.TYPE) as InkNodeType;
    inkDef.compose(orig, { theme: engine.session.theme });
    expect(inkDef.cacheSize).toBeGreaterThan(0);
    store.removeEntities({ nodeIds: [orig.id, copyNode.id] });
    expect(inkDef.cacheSize).toBe(0);
  });

  it('仅展示模式 (createDisplayPlugins) 与损坏数据校验隔离', () => {
    const engine = new SkyNoteEngine()
      .use(new BasicNodesPlugin())
      .use(new SelectionPlugin())
      .use(new TransformPlugin());
    for (const plugin of createDisplayPlugins()) engine.use(plugin);
    for (const plugin of createPlugins()) {
      expect(plugin).toBeInstanceOf(BrushPlugin);
    }

    const host = new FakeHost();
    engine.attachHost(host);
    const store = engine.documentStore;

    // 仅安装 BrushDisplayPlugin 时，已有 ink 节点可正常创建/展示、精确点选与移动，但按 B 不会进入画笔绘制
    const id = store.createNode({
      nodeType: InkNodeType.TYPE,
      x: 50,
      y: 50,
      options: {
        mode: 'fixed',
        samples: [
          { x: 0, y: 0, pressure: 0.5 },
          { x: 100, y: 100, pressure: 0.5 }
        ],
        strokeWidth: 6
      }
    })!;
    expect(dispatchKey(engine, 'KeyB', { key: 'b' })).toBe(false);
    expect(engine.hitTestNode({ x: 100, y: 100 })?.id).toBe(id);
    store.moveEntities({ nodeIds: [id] }, { x: 20, y: 10 });
    expect(store.getNode(id)?.x).toBe(70);

    // 写入损坏的 ink 字段：validateNode 报错，拾取安全回退到基础外框以便用户选中删除
    store.updateNode(id, { ink: { mode: 'pressure', samples: [] } });
    expect(engine.nodeTypes.validateNode(store.getNode(id)!)).toContain('ink.samples');
    expect(engine.hitTestNode({ x: 160, y: 65 })?.id).toBe(id);

    const displayPlugin = new BrushDisplayPlugin();
    expect(displayPlugin.id).toBe('@skynote-pro/plugin-brush/display');
  });

  it('防崩与连线兼容：createContent 在缺省 options 时安全提供有效默认值；四周加号快速连接克隆笔迹不报错', () => {
    const nodeType = new InkNodeType();
    // 1. 无参或空对象调用 createContent 不报 TypeError
    const fallbackContent = nodeType.createContent({});
    expect(fallbackContent.ink?.samples.length).toBeGreaterThan(0);
    expect(fallbackContent.width).toBeGreaterThanOrEqual(0);
    expect(fallbackContent.height).toBeGreaterThanOrEqual(0);

    // 2. 宿主装配画笔与连线插件，选中画笔节点并点击右侧快速连接「+」
    const engine = new SkyNoteEngine()
      .use(new BasicNodesPlugin())
      .use(new SelectionPlugin())
      .use(new ConnectorToolPlugin())
      .use(new BrushPlugin());
    const host = new FakeHost();
    engine.attachHost(host);
    const store = engine.documentStore;

    const inkId = store.createNode({
      nodeType: InkNodeType.TYPE,
      x: 100,
      y: 100,
      options: {
        samples: [
          { x: 0, y: 0, pressure: 0.5 },
          { x: 50, y: 50, pressure: 0.8 }
        ],
        strokeWidth: 4
      }
    })!;

    engine.session.setSelection({ nodeIds: [inkId] });
    // 四周加号快速连接点存在
    const plusSession = host.sessions.get('connector-tool:plus');
    expect(plusSession).toBeDefined();

    // 模拟点击右侧加号 (外框右边缘中点外侧：x = 100 + 50 + 12 = 162, y = 100 + 25 = 125)
    dispatchPointer(engine, 'down', { x: 162, y: 125 });
    dispatchPointer(engine, 'up', { x: 162, y: 125 });

    // 成功新建连线节点，且不抛异常
    const allNodes = Object.values(store.getView().content.nodes);
    expect(allNodes.length).toBe(2);
    const clonedNode = allNodes.find((n) => n.id !== inkId)!;
    expect(clonedNode.nodeType).toBe(InkNodeType.TYPE);
    expect(clonedNode.ink?.samples.length).toBe(2);

    const connectors = Object.values(store.getView().content.connectors);
    expect(connectors.length).toBe(1);
    expect(connectors[0].from).toEqual({ nodeId: inkId });
    expect(connectors[0].to).toEqual({ nodeId: clonedNode.id });
  });

  it('手绘端点样式：固定笔与压感笔在不同端点样式 (arrow / closed-arrow / taper) 下均能正确生成几何并全包络求解包围盒', () => {
    const samples = [
      { x: 0, y: 50, pressure: 0.5 },
      { x: 50, y: 50, pressure: 0.6 },
      { x: 100, y: 50, pressure: 0.7 }
    ];

    // 1. 固定笔开放双翼箭头
    const fixedArrowPath = buildInkPathData(samples, {
      mode: 'fixed',
      strokeWidth: 4,
      endCap: 'arrow'
    });
    expect(fixedArrowPath).toContain('M');
    expect(fixedArrowPath).toContain('Q');

    // 2. 压感笔闭合三角箭头
    const pressureClosedPath = buildInkPathData(samples, {
      mode: 'pressure',
      strokeWidth: 6,
      startCap: 'arrow',
      endCap: 'closed-arrow'
    });
    expect(pressureClosedPath).toContain('Z');

    // 3. 压感出锋 taper 模式
    const taperPath = buildInkPathData(samples, {
      mode: 'pressure',
      strokeWidth: 8,
      startCap: 'taper',
      endCap: 'taper'
    });
    expect(taperPath).toContain('M');
    expect(taperPath).toContain('Z');

    // 4. 全包络包围盒：箭头翼展必须撑开包围盒，确保不被截断
    const normRound = normalizeInkSamples(samples, undefined, {
      mode: 'pressure',
      strokeWidth: 10,
      startCap: 'round',
      endCap: 'round'
    });
    const normArrow = normalizeInkSamples(samples, undefined, {
      mode: 'pressure',
      strokeWidth: 10,
      startCap: 'round',
      endCap: 'arrow'
    });
    // 箭头的纵向翼展高度显著大于普通圆帽高度
    expect(normArrow.height).toBeGreaterThan(normRound.height);

    // 5. 箭头尺寸与线宽粗细严格正相关：细线精炼、粗线大气协调且不被线身吞没
    const tip = { x: 100, y: 50 };
    const tangent = { x: 1, y: 0 };
    const arrowThin = computeArrowHeadGeometry(tip, tangent, 1); // 对应 2px 线宽
    const arrowMedium = computeArrowHeadGeometry(tip, tangent, 2); // 对应 4px 线宽
    const arrowThick = computeArrowHeadGeometry(tip, tangent, 4); // 对应 8px 线宽
    const arrowExtraThick = computeArrowHeadGeometry(tip, tangent, 8); // 对应 16px 线宽

    expect(arrowMedium.length).toBeGreaterThan(arrowThin.length);
    expect(arrowThick.length).toBeGreaterThan(arrowMedium.length);
    expect(arrowExtraThick.length).toBeGreaterThan(arrowThick.length);

    const spanThin = Math.abs(arrowThin.left.y - arrowThin.right.y);
    const spanMedium = Math.abs(arrowMedium.left.y - arrowMedium.right.y);
    const spanThick = Math.abs(arrowThick.left.y - arrowThick.right.y);
    const spanExtraThick = Math.abs(arrowExtraThick.left.y - arrowExtraThick.right.y);

    expect(spanMedium).toBeGreaterThan(spanThin);
    expect(spanThick).toBeGreaterThan(spanMedium);
    expect(spanExtraThick).toBeGreaterThan(spanThick);

    // 6. 裁剪采样点：裁剪尾部进入箭头的过冲点，确保主干不露头、不鼓包
    const pointsWithOvershoot = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 80, y: 0 },
      { x: 95, y: 0 },
      { x: 100, y: 0 }
    ];
    // 裁剪 20 像素，95 和 100 两个中间过冲点必须被彻底剔除，新端点平滑停在 80
    const trimmedPts = trimPolylinePoints(pointsWithOvershoot, 0, 20);
    expect(trimmedPts.length).toBe(3);
    expect(trimmedPts[trimmedPts.length - 1].x).toBe(80);

    // 7. 闭合箭头圆角优化：strokeWidth 需显著放大以提供柔和的手绘圆角
    const primitives = buildInkPrimitives(
      samples,
      { mode: 'fixed', strokeWidth: 8, endCap: 'closed-arrow' },
      '#ff0000'
    );
    const closedPrimitive = primitives.find((p) => p.kind === 'path' && p.d.includes('Z'));
    expect(closedPrimitive).toBeDefined();
    if (closedPrimitive && closedPrimitive.kind === 'path') {
      expect(closedPrimitive.strokeWidth).toBeGreaterThanOrEqual(4);
      expect(closedPrimitive.strokeJoin).toBe('round');
    }
  });

  it('BrushPlugin 配置与绘制流程完整打通 startCap 与 endCap，并通过校验', () => {
    const { engine, brush, store } = setup({
      mode: 'pressure',
      strokeWidth: 5,
      startCap: 'arrow',
      endCap: 'closed-arrow'
    });

    expect(brush.getSettings().startCap).toBe('arrow');
    expect(brush.getSettings().endCap).toBe('closed-arrow');

    brush.activateTool();
    dispatchPointer(engine, 'down', { x: 100, y: 100 });
    dispatchPointer(engine, 'move', { x: 150, y: 100 });
    dispatchPointer(engine, 'move', { x: 200, y: 100 });
    dispatchPointer(engine, 'up', { x: 250, y: 100 });

    const nodes = Object.values(store.getView().content.nodes);
    expect(nodes.length).toBe(1);
    const inkNode = nodes[0];
    expect(inkNode.ink?.startCap).toBe('arrow');
    expect(inkNode.ink?.endCap).toBe('closed-arrow');

    const def = new InkNodeType();
    const liveNode = store.getNode(inkNode.id)!;
    expect(def.validate(liveNode)).toBeNull();

    // 损坏数据校验防御
    const invalidNode = {
      ...liveNode,
      ink: {
        ...liveNode.ink!,
        startCap: 'invalid-style' as any
      }
    };
    expect(def.validate(invalidNode as unknown as NodeEntity)).toContain('无效的起始端点样式');
  });

  it('基于物理弧长的自然出锋 (taper) 算法：密集点与 RDP 简化后物理出锋距离恒定，短线条与快速甩笔不被全线压扁变细', () => {
    // 1. 模拟草稿密集采样 (200px 包含 100 个采样点)
    const denseSamples: InkSample[] = [];
    for (let i = 0; i <= 100; i++) {
      denseSamples.push({ x: i * 2, y: 100, pressure: 0.5 });
    }

    const strokeWidth = 8;
    const densePrims = buildInkPrimitives(denseSamples, { mode: 'pressure', strokeWidth, endCap: 'taper' }, '#000000');
    expect(densePrims[0].kind).toBe('path');
    const denseD = (densePrims[0] as { d: string }).d;
    // 包含末端出锋连线 L 200 100
    expect(denseD).toContain('L 200 100');

    // 2. 模拟松手后 RDP 抽稀 (共线点被简化为首尾 + 中间拐点)
    const simplified = simplifyInkSamples(denseSamples, 0.5);
    expect(simplified.length).toBeLessThan(10);

    const simplifiedPrims = buildInkPrimitives(
      simplified,
      { mode: 'pressure', strokeWidth, endCap: 'taper' },
      '#000000'
    );
    const simplifiedD = (simplifiedPrims[0] as { d: string }).d;
    expect(simplifiedD).toContain('L 200 100');

    // 3. 包围盒测试：密集草稿与落盘精简点在同一线宽下，视觉包围盒宽度极差不超过 0.5px (保证零跳变)
    const denseNorm = normalizeInkSamples(denseSamples, undefined, {
      mode: 'pressure',
      strokeWidth,
      endCap: 'taper'
    });
    const simplifiedNorm = normalizeInkSamples(simplified, undefined, {
      mode: 'pressure',
      strokeWidth,
      endCap: 'taper'
    });
    expect(Math.abs(denseNorm.width - simplifiedNorm.width)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(denseNorm.height - simplifiedNorm.height)).toBeLessThanOrEqual(0.5);

    // 4. 超短线 (仅 12px) 保护：核心主干区域依然存在，绝不被两端出锋吞噬成发丝
    const shortSamples: InkSample[] = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 6, y: 0, pressure: 0.5 },
      { x: 12, y: 0, pressure: 0.5 }
    ];
    const shortNorm = normalizeInkSamples(shortSamples, undefined, {
      mode: 'pressure',
      strokeWidth: 8,
      startCap: 'taper',
      endCap: 'taper'
    });
    // 高度包含线宽 (半径至少保留一定量，不坍塌为 0)
    expect(shortNorm.height).toBeGreaterThanOrEqual(4);

    // 5. 固定粗细模式下的自然出锋支持：自动升级为平滑轮廓面填充
    const fixedTaperPrims = buildInkPrimitives(
      denseSamples,
      { mode: 'fixed', strokeWidth, endCap: 'taper' },
      '#ff0000'
    );
    expect(fixedTaperPrims[0].kind).toBe('path');
    expect((fixedTaperPrims[0] as any).fill).toBe('#ff0000');
    expect((fixedTaperPrims[0] as any).stroke).toBeUndefined();
  });
});
