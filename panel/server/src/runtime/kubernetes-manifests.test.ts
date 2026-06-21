import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInstanceHeadlessService,
  buildInstancePvc,
  buildInstanceService,
  buildInstanceStatefulSet,
  headlessServiceName,
  instanceLabels,
  podName,
  workloadName,
} from './kubernetes-manifests.js';
import type { KubernetesRuntimeConfig } from './kubernetes-config.js';
import { realisticMac } from '../identity.js';
import type { Instance } from '../store.js';

const inst: Instance = {
  id: 'abc123def0',
  name: '测试实例',
  appType: 'chromium',
  containerName: 'woc-wx-abc123def0',
  volumeName: 'woc-data-abc123def0',
  kasmUser: 'woc',
  kasmPassword: 'secret',
  createdAt: '2026-06-18T00:00:00.000Z',
  createdBy: 'admin',
};

const cfg: KubernetesRuntimeConfig = {
  namespace: 'wechat',
  instanceImage: 'example.com/wechat-on-cloud:1.2.3',
  puid: '1000',
  pgid: '1000',
  timezone: 'Asia/Hong_Kong',
  enableGpu: false,
  spoofOs: true,
  imagePullPolicy: 'IfNotPresent',
  storageSize: '20Gi',
  storageClassName: 'fast',
  memoryLimitBytes: 2147483648,
  ciliumMacSpoof: false,
};

test('instance labels are stable and searchable', () => {
  assert.deepEqual(instanceLabels(inst), {
    'app.kubernetes.io/name': 'wechat-on-cloud',
    'app.kubernetes.io/component': 'instance',
    'woc.gloridust.io/instance-id': 'abc123def0',
  });
});

test('naming helpers: pod is the workload name plus -0; service names stay stable', () => {
  assert.equal(workloadName(inst), 'woc-wx-abc123def0');
  assert.equal(podName(inst), 'woc-wx-abc123def0-0');
  assert.equal(headlessServiceName(inst), 'woc-wx-abc123def0-headless');
});

test('buildInstancePvc creates persistent config storage', () => {
  const pvc = buildInstancePvc(inst, cfg);
  assert.equal(pvc.metadata?.name, 'woc-data-abc123def0');
  assert.equal(pvc.metadata?.namespace, 'wechat');
  assert.equal(pvc.spec?.resources?.requests?.storage, '20Gi');
  assert.equal(pvc.spec?.storageClassName, 'fast');
});

test('buildInstanceService exposes KasmVNC HTTP inside the namespace (name unchanged)', () => {
  const svc = buildInstanceService(inst, cfg);
  assert.equal(svc.metadata?.name, 'woc-wx-abc123def0');
  assert.equal(svc.spec?.ports?.[0]?.port, 3000);
  assert.equal(svc.spec?.selector?.['woc.gloridust.io/instance-id'], 'abc123def0');
});

test('buildInstanceHeadlessService is clusterIP:None governing service', () => {
  const svc = buildInstanceHeadlessService(inst, cfg);
  assert.equal(svc.metadata?.name, 'woc-wx-abc123def0-headless');
  assert.equal(svc.spec?.clusterIP, 'None');
  assert.equal(svc.spec?.selector?.['woc.gloridust.io/instance-id'], 'abc123def0');
});

test('buildInstanceStatefulSet wires workload, pod template, PVC and probe', () => {
  const ss = buildInstanceStatefulSet(inst, cfg, 1);
  assert.equal(ss.apiVersion, 'apps/v1');
  assert.equal(ss.kind, 'StatefulSet');
  assert.equal(ss.metadata?.name, 'woc-wx-abc123def0');
  assert.equal(ss.spec?.replicas, 1);
  assert.equal(ss.spec?.serviceName, 'woc-wx-abc123def0-headless');
  // selector must match the pod template labels or the controller rejects the object.
  assert.equal(ss.spec?.selector?.matchLabels?.['woc.gloridust.io/instance-id'], 'abc123def0');
  assert.equal(ss.spec?.template?.metadata?.labels?.['woc.gloridust.io/instance-id'], 'abc123def0');
  // explicit-recreate model: a template change only takes effect when the pod is deleted.
  assert.equal(ss.spec?.updateStrategy?.type, 'OnDelete');
  // NOT volumeClaimTemplates — the PVC is referenced by its stable woc-data-<id> name for reuse/orphan logic.
  assert.equal(ss.spec?.volumeClaimTemplates, undefined);

  const pod = ss.spec?.template?.spec;
  const container = pod?.containers?.[0];
  assert.equal(pod?.restartPolicy, 'Always');
  assert.equal(container?.name, 'instance');
  assert.equal(container?.image, 'example.com/wechat-on-cloud:1.2.3');
  assert.equal(container?.imagePullPolicy, 'IfNotPresent');
  assert.equal(container?.ports?.[0]?.containerPort, 3000);
  assert.equal(container?.env?.some((e) => e.name === 'DISABLE_DRI' && e.value === '1'), true);
  assert.equal(container?.env?.some((e) => e.name === 'WOC_APP_TYPE' && e.value === 'chromium'), true);
  assert.equal(container?.resources?.limits?.memory, '2147483648');
  assert.equal(container?.readinessProbe?.tcpSocket?.port, 3000);
  assert.equal(pod?.securityContext?.seccompProfile?.type, 'Unconfined');
  assert.equal(pod?.volumes?.some((v) => v.name === 'config' && v.persistentVolumeClaim?.claimName === 'woc-data-abc123def0'), true);
  assert.equal(pod?.volumes?.some((v) => v.name === 'shm' && v.emptyDir?.medium === 'Memory'), true);
});

test('buildInstanceStatefulSet encodes runtime state in replicas', () => {
  assert.equal(buildInstanceStatefulSet(inst, cfg, 0).spec?.replicas, 0);
  assert.equal(buildInstanceStatefulSet(inst, cfg, 1).spec?.replicas, 1);
});

test('forcePull flips the image pull policy to Always for upgrades', () => {
  const ss = buildInstanceStatefulSet(inst, cfg, 1, true);
  assert.equal(ss.spec?.template?.spec?.containers?.[0]?.imagePullPolicy, 'Always');
});

test('Cilium MAC annotation is present only when enabled and equals realisticMac(inst.id)', () => {
  const off = buildInstanceStatefulSet(inst, cfg, 1);
  assert.equal(off.spec?.template?.metadata?.annotations, undefined);

  const on = buildInstanceStatefulSet(inst, { ...cfg, ciliumMacSpoof: true }, 1);
  assert.equal(on.spec?.template?.metadata?.annotations?.['cni.cilium.io/mac-address'], realisticMac(inst.id));
});
