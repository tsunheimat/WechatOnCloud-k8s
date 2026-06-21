import test from 'node:test';
import assert from 'node:assert/strict';
import {
  podPhaseToRuntimeState,
  isNotFoundError,
  selectOrphanWorkloads,
  selectOrphanVolumes,
  mountedDataPvcNames,
  templateDataPvcNames,
} from './kubernetes-runtime.js';

test('pod phase maps to runtime state', () => {
  assert.equal(podPhaseToRuntimeState('Running'), 'running');
  assert.equal(podPhaseToRuntimeState('Pending'), 'stopped');
  assert.equal(podPhaseToRuntimeState('Succeeded'), 'stopped');
  assert.equal(podPhaseToRuntimeState('Failed'), 'stopped');
  assert.equal(podPhaseToRuntimeState(undefined), 'stopped');
});

test('isNotFoundError recognizes kubernetes 404 shapes', () => {
  assert.equal(isNotFoundError({ response: { statusCode: 404 } }), true);
  assert.equal(isNotFoundError({ statusCode: 404 }), true);
  assert.equal(isNotFoundError({ code: 404 }), true);
  assert.equal(isNotFoundError({ response: { statusCode: 500 } }), false);
});

test('selectOrphanWorkloads: registered StatefulSet (and its -0 pod) is NOT an orphan', () => {
  const orphans = selectOrphanWorkloads(
    [{ metadata: { name: 'woc-wx-registered' } }] as any,
    [
      // The registered instance's pod is woc-wx-registered-0 — owned by the StatefulSet, never an orphan
      // even though its name is not literally in knownContainerNames (which holds the workload name).
      { metadata: { name: 'woc-wx-registered-0', ownerReferences: [{ kind: 'StatefulSet', name: 'woc-wx-registered' }] } },
    ] as any,
    new Set(['woc-wx-registered']),
  );
  assert.deepEqual(orphans, []);
});

test('selectOrphanWorkloads: unregistered StatefulSet is an orphan with id = StatefulSet name', () => {
  const orphans = selectOrphanWorkloads(
    [
      {
        metadata: { name: 'woc-wx-ghost' },
        spec: {
          replicas: 1,
          template: { spec: { volumes: [{ persistentVolumeClaim: { claimName: 'woc-data-ghost' } }] } },
        },
      },
    ] as any,
    [{ metadata: { name: 'woc-wx-ghost-0', ownerReferences: [{ kind: 'StatefulSet', name: 'woc-wx-ghost' }] }, status: { phase: 'Running' } }] as any,
    new Set(['woc-wx-registered']),
  );
  assert.equal(orphans.length, 1);
  // id must be the StatefulSet name so removeContainerById deletes the controller, not a pod it recreates.
  assert.equal(orphans[0].id, 'woc-wx-ghost');
  assert.equal(orphans[0].name, 'woc-wx-ghost');
  assert.equal(orphans[0].status, 'Running');
  assert.equal(orphans[0].volumeName, 'woc-data-ghost');
});

test('selectOrphanWorkloads: a stopped (replicas 0, no pod) orphan StatefulSet still reports its PVC', () => {
  const orphans = selectOrphanWorkloads(
    [
      {
        metadata: { name: 'woc-wx-stopped' },
        spec: { replicas: 0, template: { spec: { volumes: [{ persistentVolumeClaim: { claimName: 'woc-data-stopped' } }] } } },
      },
    ] as any,
    [],
    new Set(),
  );
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].status, 'Stopped');
  assert.equal(orphans[0].volumeName, 'woc-data-stopped');
});

test('selectOrphanWorkloads: a legacy bare Pod (no StatefulSet owner) is still deletable as an orphan', () => {
  const orphans = selectOrphanWorkloads(
    [],
    [
      { metadata: { name: 'woc-wx-legacy' }, status: { phase: 'Failed' }, spec: { volumes: [{ persistentVolumeClaim: { claimName: 'woc-data-legacy' } }] } },
      { metadata: { name: 'kube-dns-xyz' } },
    ] as any,
    new Set(['woc-wx-registered']),
  );
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].id, 'woc-wx-legacy');
  assert.equal(orphans[0].status, 'Failed');
  assert.equal(orphans[0].volumeName, 'woc-data-legacy');
});

test('mountedDataPvcNames collects woc-data-* claims across all pods', () => {
  const names = mountedDataPvcNames([
    { spec: { volumes: [{ persistentVolumeClaim: { claimName: 'woc-data-a' } }, { emptyDir: {} }] } },
    { spec: { volumes: [{ persistentVolumeClaim: { claimName: 'woc-data-b' } }] } },
    { spec: { volumes: [{ persistentVolumeClaim: { claimName: 'unrelated-claim' } }] } },
    { spec: {} },
  ] as any);
  assert.deepEqual([...names].sort(), ['woc-data-a', 'woc-data-b']);
});

test('templateDataPvcNames collects woc-data-* claims from StatefulSet pod templates', () => {
  const names = templateDataPvcNames([
    { spec: { template: { spec: { volumes: [{ persistentVolumeClaim: { claimName: 'woc-data-tmpl' } }] } } } },
    { spec: { template: { spec: { volumes: [{ emptyDir: {} }] } } } },
  ] as any);
  assert.deepEqual([...names], ['woc-data-tmpl']);
});

test('selectOrphanVolumes excludes a PVC still mounted by an unregistered Pod', () => {
  // 残留 Pod 仍挂着 woc-data-used，即便它不在 store 引用里也不能算孤儿（否则删了会卡 Terminating / 丢数据）。
  const orphans = selectOrphanVolumes(
    [{ metadata: { name: 'woc-data-used' } }, { metadata: { name: 'woc-data-free' } }] as any,
    [{ metadata: { name: 'woc-wx-ghost-0' }, spec: { volumes: [{ persistentVolumeClaim: { claimName: 'woc-data-used' } }] } }] as any,
    [],
    new Set(),
  );
  assert.deepEqual(orphans.map((o) => o.name), ['woc-data-free']);
});

test('selectOrphanVolumes excludes a PVC claimed by a stopped StatefulSet template (no running pod)', () => {
  const orphans = selectOrphanVolumes(
    [{ metadata: { name: 'woc-data-stopped' } }, { metadata: { name: 'woc-data-free' } }] as any,
    [],
    [{ spec: { replicas: 0, template: { spec: { volumes: [{ persistentVolumeClaim: { claimName: 'woc-data-stopped' } }] } } } }] as any,
    new Set(),
  );
  assert.deepEqual(orphans.map((o) => o.name), ['woc-data-free']);
});

test('selectOrphanVolumes still unions the store-provided references', () => {
  const orphans = selectOrphanVolumes(
    [{ metadata: { name: 'woc-data-store' } }, { metadata: { name: 'woc-data-loose' } }] as any,
    [],
    [],
    new Set(['woc-data-store']),
  );
  assert.deepEqual(orphans.map((o) => o.name), ['woc-data-loose']);
});
