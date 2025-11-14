---
layout: post
title: "Extending Kubernetes: How to Automate Sidecar Injection with Admission Controller Webhooks"
date: 2022-11-29
description: 'Automating Sidecar Container Injection with Kubernetes Admission Controllers!'
image: '/assets/images/posts/extending-kubernetes-with-admission-controller/preview.png'
tags:
- kubernetes
- cloud-native
excerpt: 'Automating Sidecar Container Injection with Kubernetes Admission Controllers!'
---

This article explains how to build a Kubernetes admission controller webhook that automatically injects sidecar containers into pods based on specific annotations or labels.

## Understanding the sidecar pattern

A **sidecar container** is a container that runs alongside the primary application container (a.k.a the application container), sharing resources such as network and storage interfaces, to enhance or extend the functionality of the primary container without modifying its core responsibilities.

<figure class="image-figure">
  <img src="/assets/images/posts/extending-kubernetes-with-admission-controller/sidecar-container.png" alt="Sidecar Container">
  <figcaption>Sidecar Container</figcaption>
</figure>

## What are admission controllers?

Starting in Kubernetes v1.7, alpha support for [external admission controllers](https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/) was introduced. These controllers allow you to add custom business logic to the Kubernetes API server to modify or validate objects as they are created.

<blockquote cite="https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/">
  <p>
    An admission controller is a piece of code that intercepts requests to the Kubernetes API server before the persistence of the object but after the request is authenticated and authorised.
  </p>
  <p>
    — <a href="https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/" target="_blank">Kubernetes Documentation</a>
  </p>
</blockquote>

Kubernetes provides two webhook-based admission controllers:

- [`MutatingAdmissionWebhook`](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/#mutatingadmissionwebhook): Alters (mutates) incoming requests before they are persisted.
- [`ValidatingAdmissionWebhook`](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/#validatingadmissionwebhook): Validates incoming requests and can reject them if necessary.

<figure class="image-figure">
  <img src="/assets/images/posts/extending-kubernetes-with-admission-controller/admission-controller-phases.png" alt="Admission Controller Phases">
  <figcaption>Admission Controller Phases</figcaption>
</figure>

There are many use cases where admission webhook/s can be helpful:

- Implementing image scanning to detect vulnerabilities in container images.
- Enforcing policies, such as requiring specific annotations or labels on resources.
- Injecting sidecar containers into pods (e.g., Istio-style proxies for service mesh functionalities).
- And many, many others...

This article focuses on the *MutatingAdmissionWebhook* to create a sidecar injection controller using a simple [`busybox-curl`](https://hub.docker.com/r/yauritux/busybox-curl) sidecar container.

## Setting up Your Kubernetes cluster for webhooks

First, ensure that `admissionregistration.k8s.io/v1` API is enabled on your Kubernetes cluster using this command:

```bash
kubectl api-versions | grep admissionregistration.k8s.io/v1
```

If the output is empty, you need to enable the API by adding the following line to the `--enable-admission-plugins` flag in your Kubernetes API server configuration.

```yaml
--enable-admission-plugins=...,MutatingAdmissionWebhook,ValidatingAdmissionWebhook,...
```

## Implementation

*Note: The following code snippets have been edited to fit the article format better. The complete code is available on [this repo](https://github.com/mohllal/kubernetes-sidecar-injector).*

The sidecar injection controller requires an HTTP API server to handle webhook requests from the Kubernetes API server and mutate pod specifications accordingly.

Let’s first understand the structure of admission webhook requests and responses.

### Webhook request

Kubernetes sends admission webhook requests as HTTP POST requests containing an `AdmissionReview` object serialized to JSON.

In the [`AdmissionReview`](https://github.com/mohllal/kubernetes-sidecar-injector/blob/main/src/types/kubernetes.ts#L178) object, the request key with the type [`AdmissionRequest`](https://github.com/mohllal/kubernetes-sidecar-injector/blob/main/src/types/kubernetes.ts#L111) contains all the details for the admission request.

```json
{
  "apiVersion": "admission.k8s.io/v1",
  "kind": "AdmissionReview",
  "request": {
    "uid": "075a1336-0165-41e0-b0ac-8705883f1c41",
    "dryRun": false,
    "namespace": "default",
    "object": {
      "apiVersion": "v1",
      "kind": "Pod",
      "...": "..."
    }
  }
}
```

### Webhook response

The webhook API should respond with:

- **HTTP status code**: `2xx` for success, non-`2xx` for failure.
- **Body**: An [`AdmissionReview`](https://github.com/mohllal/kubernetes-sidecar-injector/blob/main/src/types/kubernetes.ts#L178) object containing the [`AdmissionResponse`](https://github.com/mohllal/kubernetes-sidecar-injector/blob/main/src/types/kubernetes.ts#L157), which specifies the mutation changes as a base64-encoded array of JSON patch operations.

```json
{
  "apiVersion": "admission.k8s.io/v1",
  "kind": "AdmissionReview",
  "response": {
    "uid": "075a1336-0165-41e0-b0ac-8705883f1c41",
    "allowed": true,
    "patch": "W3sib3AiOiJhZGQiLCJwYXRoIjoiL3NwZWMvY29udG...",
    "patchType": "JSONPatch"
  }
}
```

You can check the [JSON patch](https://jsonpatch.com/) documentation for more details about how it can be used to describe JSON object changes.

### Mutation logic

Here’s how the mutation function works:

1. **Add the sidecar container**: Appends a [`busybox-curl`](https://hub.docker.com/r/yauritux/busybox-curl) container to the pod’s containers array.
2. **Generate the JSON Patch**: Uses a library like [`fast-json-patch`](https://www.npmjs.com/package/fast-json-patch) to create an array of JSON patch operations.
3. **Encode the Patch**: Serializes the JSON patch and encodes it as a base64 string.

```typescript
// An example of the injection mutation function (snipped code)

import { V1AdmissionRequest, V1AdmissionResponse, V1Container, V1Pod } from '@kubernetes/client-node';
import * as jsonpatch from 'fast-json-patch';

const mutate = (admissionReviewRequest: V1AdmissionRequest<V1Pod>): V1AdmissionResponse => {
  const admissionReviewResponse: V1AdmissionResponse = {
    allowed: true,
    uid: admissionReviewRequest.uid,
  };

  // get the pod object and clone it
  const originalPod = admissionReviewRequest.object as V1Pod;
  const mutatedPod = JSON.parse(JSON.stringify(originalPod)) as V1Pod;

  // update the mutated pod spec with the new containers array
  const mutatedPodContainers = injectContainer(originalPod.spec?.containers);
  mutatedPod.spec = { ...mutatedPod.spec, containers: mutatedPodContainers };

  // generate json patch string
  const patchArray = jsonpatch.compare(originalPod, mutatedPod);
  const patchArrayJsonStr = JSON.stringify(patchArray);

  admissionReviewResponse.patchType = "JSONPatch";
  admissionReviewResponse.patch = Buffer.from(patchArrayJsonStr).toString('base64');

  return admissionReviewResponse;
}

const injectContainer = (containers: V1Container[] = []): V1Container[] => {
  const sidecarContainer: V1Container = {
    name: 'curl',
    image: 'yauritux/busybox-curl:latest'
  };

  return [...containers, sidecarContainer];
};
```

Well, but how can we deploy it?

## Deploying the sidecar injection webhook

The admission webhook server is deployed as a regular [Kubernetes Deployment](https://github.com/mohllal/kubernetes-sidecar-injector/blob/main/charts/kubernetes-sidecar-injector/templates/deployment.yaml).

```yaml
# An example of Kubernetes Deployment that runs the admission webhook server (snipped YAML)

apiVersion: apps/v1
kind: Deployment
metadata:
  name: kubernetes-sidecar-injector
  labels:
    app.kubernetes.io/instance: kubernetes-sidecar-injector
spec:
  selector:
    matchLabels:
      app.kubernetes.io/instance: kubernetes-sidecar-injector
  template:
    metadata:
      labels:
        app.kubernetes.io/instance: kubernetes-sidecar-injector
    spec:
      containers:
        - name: kubernetes-sidecar-injector
          image: "mohllal/kubernetes-sidecar-injector:latest"
          env:
            - name: TLS_CERT_FILE
              value: "/var/run/secrets/certs/tls-cert-file"
            - name: TLS_PRIVATE_KEY_FILE
              value: "/var/run/secrets/certs/tls-private-key-file"
          volumeMounts:
          - name: admission-controller-cert
            mountPath: "/var/run/secrets/certs"
            readOnly: true
      volumes:
      - name: admission-controller-cert
        secret:
          secretName: kubernetes-sidecar-injector
```

And to make the Deployment’s pods accessible by the Kubernetes API server, we need a [Kubernetes Service](https://github.com/mohllal/kubernetes-sidecar-injector/blob/main/charts/kubernetes-sidecar-injector/templates/service.yaml).

```yaml
# An example of Kubernetes Service for the admission webhook server (snipped YAML)

apiVersion: v1
kind: Service
metadata:
  name: kubernetes-sidecar-injector
  labels:
    app.kubernetes.io/instance: kubernetes-sidecar-injector
spec:
  type: ClusterIP
  ports:
    - port: 443
      targetPort: 8443
      protocol: TCP
      name: https
  selector:
    app.kubernetes.io/instance: kubernetes-sidecar-injector
```

Admission webhooks are served via HTTPS, so we need proper certificates for the server. The certificate can be self-signed and stored in a Kubernetes secret.

The certificate’s *Common Name (CN)* must match the service’s fully qualified domain name (e.g., `<service-name>.<namespace>.svc`).

Here is an example of a [Kubernetes Secret](https://github.com/mohllal/kubernetes-sidecar-injector/blob/main/charts/kubernetes-sidecar-injector/templates/admission-controller.yaml#L3) that holds the TLS certificate cert and private key.

```yaml
# An example of Kubernetes Secret for the TLS certificate of the admission server (snipped YAML)

apiVersion: v1
kind: Secret
metadata:
  name: kubernetes-sidecar-injector
type: Opaque
data:
  tls-cert-file: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JS...
  tls-private-key-file: LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0t...
```

*More about generating the certificate comes later in the demo section below. Still, if you don’t want to use Helm, you can generate a self-signed certificate using the openssl CLI tool and put it manually inside a Kubernetes Secret.*

Finally, the *[Kubernetes MutatingWebhookConfiguration](https://github.com/mohllal/kubernetes-sidecar-injector/blob/main/charts/kubernetes-sidecar-injector/templates/admission-controller.yaml#L19)* defines the admission webhook and determines which objects will be processed by the webhook server.

```yaml
# An example of Kubernetes MutatingWebhookConfiguration for the admission controller webhook server (snipped YAML)

apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: kubernetes-sidecar-injector
webhooks:
- name: kubernetes-sidecar-injector.default.svc
  admissionReviewVersions:
    - v1
  sideEffects: "NoneOnDryRun"
  reinvocationPolicy: "Never"
  timeoutSeconds: 10
  objectSelector:
    matchExpressions:
    - key: sidecar.me/inject
      operator: In
      values:
      - "True"
      - "true"
  rules:
  - apiGroups:
    - ""
    apiVersions:
    - v1
    operations:
    - CREATE
    resources:
    - pods
    scope: '*'
  clientConfig:
    service:
      namespace: default
      name: kubernetes-sidecar-injector
      path: "/mutation/pod"
    caBundle: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0t...
```

Here are the key components of the *MutatingWebhookConfiguration*:

- `objectSelector` and `rules`: Configure the webhook to apply only to pod objects labelled with `sidecar.me/inject: True` during creation.
- `clientConfig`: Defines the webhook server's hostname (`kubernetes-sidecar-injector` in the `default` namespace) and the API endpoint (/mutation/pod).
- `caBundle`: Specifies the PEM-encoded CA bundle used by the Kubernetes API server to validate the webhook server's TLS certificate.

For more information on the various configurations available for the admission webhook, refer to the [official Kubernetes documentation](https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/#webhook-configuration).

## Demo

For the demo, we use [Helm](https://helm.sh/) to package and deploy the following:

- [`kubernetes-sidecar-injector`](https://github.com/mohllal/kubernetes-sidecar-injector/tree/main/charts/kubernetes-sidecar-injector) chart: Deploys the webhook server and related resources.
- [`httpbin`](https://github.com/mohllal/kubernetes-sidecar-injector/tree/main/charts/httpbin) chart: Deploys an [echo HTTP server](https://github.com/postmanlabs/httpbin) to test sidecar injection.

I used both [`genSignedCert`](https://helm.sh/docs/chart_template_guide/function_list/#gensignedcert) and [`genCA`](https://helm.sh/docs/chart_template_guide/function_list/#genca) helm functions to generate an x509 certificate with both *Subject Common Name (CN)* and *Subject Alternative Name (SAN)* set to the service fully qualified hostname.

{% raw %}

```smarty
{* An example of Helm helper file for generating an x509 certificate (snipped code) *}

{{- define "kubernetes-sidecar-injector.service.fullname" -}}
{{- default ( printf "%s.%s.svc" (include "kubernetes-sidecar-injector.serviceName" .) .Release.Namespace ) }}
{{- end }}

{{- define "kubernetes-sidecar-injector.gen-certs" -}}
{{- $expiration := (.Values.admission.ca.expiration | int) -}}
{{- if (or (empty .Values.admission.ca.cert) (empty .Values.admission.ca.key)) -}}
{{- $ca :=  genCA "kubernetes-sidecar-injector-ca" $expiration -}}
{{- template "kubernetes-sidecar-injector.gen-client-tls" (dict "RootScope" . "CA" $ca) -}}
{{- end -}}
{{- end -}}

{{- define "kubernetes-sidecar-injector.gen-client-tls" -}}
{{- $altNames := list ( include "kubernetes-sidecar-injector.service.fullname" .RootScope) -}}
{{- $expiration := (.RootScope.Values.admission.ca.expiration | int) -}}
{{- $cert := genSignedCert ( include "kubernetes-sidecar-injector.fullname" .RootScope) nil $altNames $expiration .CA -}}
{{- $clientCert := $cert.Cert | b64enc -}}
{{- $clientKey := $cert.Key | b64enc -}}
caCert: {{ .CA.Cert | b64enc }}
clientCert: {{ $clientCert }}
clientKey: {{ $clientKey }}
{{- end -}}
```

{% endraw %}

Let’s install both charts:

```bash
# Install the kubernetes-sidecar-injector chart
helm install kubernetes-sidecar-injector charts/kubernetes-sidecar-injector/ \
--values charts/kubernetes-sidecar-injector/values.yaml \
--namespace default

# Install the httpbin chart
helm install httpbin charts/httpbin/ \
--values charts/httpbin/values.yaml \
--namespace default
```

To verify the sidecar injection, list all containers in the `httpbin` Deployment’s Pod, you should see an additional container named `curl`.

```bash
# Export the pod name
export POD_NAME=$(kubectl get pods \
--namespace default \
-l "app.kubernetes.io/name=httpbin,app.kubernetes.io/instance=httpbin" \
-o jsonpath="{.items[0].metadata.name}")

# List all containers running inside the pod 
kubectl get pods $POD_NAME \
--namespace default \
-o jsonpath='{.spec.containers[*].name}'
```

Accessing the `httpbin` HTTP server from inside the `curl` container.

```bash
# Export the pod name
export POD_NAME=$(kubectl get pods \
--namespace default \
-l "app.kubernetes.io/name=httpbin,app.kubernetes.io/instance=httpbin" \
-o jsonpath="{.items[0].metadata.name}")

# Curl from the sidecar container
kubectl exec $POD_NAME \
--namespace default \
-c curl \
-- curl http://localhost/anything
```

Woohoo! The pod has been successfully mutated to include an additional sidecar container, sharing the same network interface as the primary container.

## Conclusion

Kubernetes admission controllers are powerful tools for extending cluster functionality. By implementing a custom webhook, you can add domain-specific logic to mutate or validate resources at runtime before the object state persists.

## Further reading

- [Sidecar pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/sidecar).
- [Using Admission Controllers](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/).
- [Dynamic Admission Control](https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/).
- [A Guide to Kubernetes Admission Controllers](https://kubernetes.io/blog/2019/03/21/a-guide-to-kubernetes-admission-controllers/).
