import type * as k8s from '@kubernetes/client-node';
import { instanceAppType, type Instance } from '../store.js';
import { realisticHostname } from '../identity.js';
import type { KubernetesRuntimeConfig } from './kubernetes-config.js';

export const INSTANCE_CONTAINER_NAME = 'instance';

export function instanceLabels(inst: Instance): Record<string, string> {
  return {
    'app.kubernetes.io/name': 'wechat-on-cloud',
    'app.kubernetes.io/component': 'instance',
    'woc.gloridust.io/instance-id': inst.id,
  };
}

function env(name: string, value: string): k8s.V1EnvVar {
  return { name, value };
}

function instanceEnv(inst: Instance, cfg: KubernetesRuntimeConfig): k8s.V1EnvVar[] {
  const out: k8s.V1EnvVar[] = [
    env('PUID', cfg.puid),
    env('PGID', cfg.pgid),
    env('TZ', cfg.timezone),
    env('CUSTOM_USER', inst.kasmUser),
    env('PASSWORD', inst.kasmPassword),
    env('WOC_SPOOF_OS', cfg.spoofOs ? '1' : '0'),
    env('WOC_APP_TYPE', instanceAppType(inst)),
  ];
  if (!cfg.enableGpu) out.push(env('DISABLE_DRI', '1'));
  if (instanceAppType(inst) === 'custom' && inst.customLaunch) {
    out.push(env('WOC_CUSTOM_LAUNCH', inst.customLaunch));
  }
  return out;
}

export function buildInstancePvc(inst: Instance, cfg: KubernetesRuntimeConfig): k8s.V1PersistentVolumeClaim {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: inst.volumeName,
      namespace: cfg.namespace,
      labels: instanceLabels(inst),
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: cfg.storageClassName,
      resources: {
        requests: {
          storage: cfg.storageSize,
        },
      },
    },
  };
}

export function buildInstanceService(inst: Instance, cfg: KubernetesRuntimeConfig): k8s.V1Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: inst.containerName,
      namespace: cfg.namespace,
      labels: instanceLabels(inst),
    },
    spec: {
      type: 'ClusterIP',
      selector: instanceLabels(inst),
      ports: [
        {
          name: 'http',
          protocol: 'TCP',
          port: 3000,
          targetPort: 3000,
        },
      ],
    },
  };
}

export function buildInstancePod(inst: Instance, cfg: KubernetesRuntimeConfig): k8s.V1Pod {
  // Always declare modest requests so instances are Burstable rather than BestEffort (first evicted
  // under node memory pressure). A memory limit is added only when WOC_INSTANCE_MEM_GB is set, matching
  // the Docker hard cap; the kubelet then OOM-kills + restarts on overrun.
  const resources: k8s.V1ResourceRequirements = {
    requests: { cpu: '250m', memory: '512Mi' },
  };
  if (cfg.memoryLimitBytes > 0) resources.limits = { memory: String(cfg.memoryLimitBytes) };

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: inst.containerName,
      namespace: cfg.namespace,
      labels: instanceLabels(inst),
    },
    spec: {
      restartPolicy: 'Always',
      // Internal hostname mimics a personal PC (not the woc-wx-<hex> server/container fingerprint),
      // mirroring the Docker runtime's anti-detection hostname. The Service name (containerName) remains
      // the addressable handle and is unaffected. Per-Pod MAC spoofing needs a CNI plugin and is a known
      // K8s gap (see doc/Kubernetes部署.md).
      hostname: realisticHostname(inst.id),
      imagePullSecrets: cfg.imagePullSecret ? [{ name: cfg.imagePullSecret }] : undefined,
      securityContext: {
        seccompProfile: { type: 'Unconfined' },
      },
      containers: [
        {
          name: INSTANCE_CONTAINER_NAME,
          image: cfg.instanceImage,
          imagePullPolicy: cfg.imagePullPolicy,
          env: instanceEnv(inst, cfg),
          ports: [{ name: 'http', containerPort: 3000, protocol: 'TCP' }],
          volumeMounts: [
            { name: 'config', mountPath: '/config' },
            { name: 'shm', mountPath: '/dev/shm' },
          ],
          resources,
          // Gate the Service endpoint on the port actually listening so the reverse proxy does not route
          // to a Pod whose KasmVNC is still starting (which would surface as a transient 502 on rebuild).
          readinessProbe: {
            tcpSocket: { port: 3000 },
            initialDelaySeconds: 10,
            periodSeconds: 10,
            timeoutSeconds: 3,
            failureThreshold: 6,
          },
        },
      ],
      volumes: [
        { name: 'config', persistentVolumeClaim: { claimName: inst.volumeName } },
        { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } },
      ],
    },
  };
}
