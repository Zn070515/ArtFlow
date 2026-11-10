#!/usr/bin/env bash
# Cluster-wide lab bootstrap. Run as root on k8s-control.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "bootstrap-control.sh must run as root" >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GH_PROXY="${GH_PROXY:-https://ghproxy.net}"
LOGIN_USER="${LOGIN_USER:-xuxin}"
LOCAL_PATH_VERSION="v0.0.31"
METRICS_SERVER_VERSION="v0.7.2"

kubectl apply -f "${DIR}/namespaces.yaml"
kubectl apply -f "${DIR}/rbac.yaml"

# The upstream helper pod uses Docker Hub, which is unreachable here.
curl -fsSL \
  "${GH_PROXY}/https://raw.githubusercontent.com/rancher/local-path-provisioner/${LOCAL_PATH_VERSION}/deploy/local-path-storage.yaml" |
  sed 's#image: rancher/local-path-provisioner:#image: docker.m.daocloud.io/rancher/local-path-provisioner:#; s#image: busybox#image: docker.m.daocloud.io/library/busybox:1.36#' \
    >/tmp/local-path.yaml
kubectl apply -f /tmp/local-path.yaml
kubectl -n local-path-storage rollout status deploy/local-path-provisioner --timeout=300s
kubectl patch storageclass local-path \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

curl -fsSL \
  "${GH_PROXY}/https://github.com/kubernetes-sigs/metrics-server/releases/download/${METRICS_SERVER_VERSION}/components.yaml" \
  >/tmp/metrics-server.yaml
kubectl apply -f /tmp/metrics-server.yaml
if ! kubectl -n kube-system get deployment metrics-server \
  -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q -- '--kubelet-insecure-tls'; then
  kubectl -n kube-system patch deployment metrics-server --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
fi
kubectl -n kube-system rollout status deploy/metrics-server --timeout=300s

kubectl apply -f "${DIR}/registry.yaml"
kubectl -n artflow-system rollout status deploy/artflow-registry --timeout=300s

TOKEN="$(kubectl -n artflow-system create token artflow-deployer --duration=8760h)"
CA="$(kubectl config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
SERVER="$(kubectl config view --raw -o jsonpath='{.clusters[0].cluster.server}')"
KUBECONFIG_PATH="/home/${LOGIN_USER}/artflow-lab.kubeconfig"
cat >"${KUBECONFIG_PATH}" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: artflow-lab
    cluster:
      server: ${SERVER}
      certificate-authority-data: ${CA}
users:
  - name: artflow-deployer
    user:
      token: ${TOKEN}
contexts:
  - name: artflow-lab
    context:
      cluster: artflow-lab
      user: artflow-deployer
      namespace: artflow-dev
current-context: artflow-lab
EOF
chown "${LOGIN_USER}:${LOGIN_USER}" "${KUBECONFIG_PATH}"
chmod 600 "${KUBECONFIG_PATH}"

echo "bootstrap complete; deployer kubeconfig at ${KUBECONFIG_PATH}"
