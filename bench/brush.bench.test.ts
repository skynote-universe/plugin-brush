/**
 * @file brush.bench.test.ts
 * @description 阶段 B 商业画笔性能基准：长笔迹增量草稿更新、松手简化落盘、密集笔迹画布拾取与缓存命中
 */

import { describe, expect, it } from 'vitest';
import { SkyNoteEngine } from '@skynote/core';
import { BrushPlugin, InkDraftBuffer, InkNodeType } from '../src';

describe('商业画笔性能基准 (Stage B)', () => {
  it('长笔迹增量草稿更新 (1200 个采样点，分 200 帧追加并生成压感轮廓预览)', () => {
    const buffer = new InkDraftBuffer({
      mode: 'pressure',
      strokeWidth: 8,
      strokeColor: '$ink',
      thinning: 0.65,
      smoothing: 0.5
    });

    const frames = 200;
    const samplesPerFrame = 6;
    const frameTimes: number[] = [];

    for (let f = 0; f < frames; f++) {
      const batch = Array.from({ length: samplesPerFrame }, (_, s) => {
        const idx = f * samplesPerFrame + s;
        const pt = { x: idx * 2.2, y: Math.sin(idx * 0.08) * 60 + Math.cos(idx * 0.03) * 30 };
        return { point: pt, clientPoint: pt, pressure: 0.2 + 0.7 * Math.abs(Math.sin(idx * 0.05)) };
      });
      const t0 = performance.now();
      buffer.appendSamples(batch, 1.5);
      const primitives = buffer.toPrimitives();
      const elapsed = performance.now() - t0;
      frameTimes.push(elapsed);
      expect(primitives).toHaveLength(1);
    }

    frameTimes.sort((a, b) => a - b);
    const medianMs = frameTimes[Math.floor(frameTimes.length / 2)];
    const p95Ms = frameTimes[Math.floor(frameTimes.length * 0.95)];

    const tFinalize0 = performance.now();
    const finalized = buffer.finalize(0.45);
    const finalizeMs = performance.now() - tFinalize0;

    console.info(
      `[bench:brush] 1200 点压感长笔迹: 单帧增量预览中位 ${(medianMs * 1000).toFixed(1)}µs (P95 ${(p95Ms * 1000).toFixed(1)}µs), 松手简化落盘 ${finalizeMs.toFixed(2)}ms (${buffer.sampleCount} -> ${finalized.samples.length} 点)`
    );

    expect(medianMs).toBeLessThan(2);
    expect(finalizeMs).toBeLessThan(15);
  });

  it('密集笔迹画布 (1000 条笔迹节点)：缓存命中 compose 与精确空间拾取', () => {
    const brush = new BrushPlugin();
    const engine = new SkyNoteEngine().use(brush);
    const store = engine.documentStore;

    store.batch(() => {
      for (let i = 0; i < 1000; i++) {
        const col = i % 40;
        const row = Math.floor(i / 40);
        store.createNode({
          nodeType: InkNodeType.TYPE,
          x: col * 120,
          y: row * 120,
          width: 80,
          height: 60,
          options: {
            mode: i % 2 === 0 ? 'pressure' : 'fixed',
            strokeWidth: 6,
            samples: [
              { x: 0, y: 0, pressure: 0.3 },
              { x: 40, y: 50, pressure: 0.8 },
              { x: 80, y: 20, pressure: 0.4 }
            ]
          }
        });
      }
    }, '批量创建 1000 条笔迹');

    const nodes = Object.keys(store.getView().content.nodes).map((id) => store.getNode(id)!);
    // 预热一次 compose 缓存
    for (const node of nodes) {
      brush.nodeType.compose(node, { theme: engine.session.theme });
    }

    const tCompose0 = performance.now();
    for (const node of nodes) {
      brush.nodeType.compose(node, { theme: engine.session.theme });
    }
    const cachedComposeMs = performance.now() - tCompose0;

    const tHit0 = performance.now();
    let hits = 0;
    for (let i = 0; i < 200; i++) {
      const col = i % 40;
      const row = Math.floor(i / 40);
      if (engine.hitTestNode({ x: col * 120 + 40, y: row * 120 + 50 })) hits++;
    }
    const hitMs = (performance.now() - tHit0) / 200;

    console.info(
      `[bench:brush] 1000 条笔迹: 缓存命中全量 compose ${cachedComposeMs.toFixed(2)}ms, 单次精确拾取 ${(hitMs * 1000).toFixed(1)}µs`
    );

    expect(hits).toBe(200);
    expect(cachedComposeMs).toBeLessThan(10);
    expect(hitMs).toBeLessThan(1);
  });
});
