---
layout: post
title: "How TLS Neutralizes Intermediaries on the Web"
date: 2025-03-15
description: 'How TLS ensures intermediaries can’t inspect, modify, or disrupt the web traffic'
image: '/assets/images/posts/tls-and-intermediaries/preview.png'
tags:
- tls
excerpt: 'How TLS ensures intermediaries can’t inspect, modify, or disrupt the web traffic'
---

Transport Layer Security (TLS) secures most of today’s internet traffic by encrypting data in transit to create secure communication channels. While its encryption is often celebrated for privacy, one of its most critical roles is **preventing unintended interference** from intermediaries, devices or software that inspect, modify, or block traffic between clients and servers.

## The Role of Intermediaries

Web traffic rarely, if ever, travels directly from a client to a server. It passes through a lot of intermediaries such as firewalls, load balancers, proxies, and caches and many more.

<figure class="image-figure">
  <img src="/assets/images/posts/tls-and-intermediaries/web-intermediaries.png" alt="Web Intermediaries">
  <figcaption>A simplified view of intermediaries between a client and server</figcaption>
</figure>

These intermediaries serve different purposes (some of them are bad ones!), from optimizing performance (e.g., caching, compression) to enforcing policies (e.g., content filtering). However, their involvement can lead to unintended consequences, especially when they misinterpret or mishandle modern protocols (or protocols they don't support).

The [RFC3234](https://datatracker.ietf.org/doc/html/rfc3234) provides a useful definition and categorization of middleboxes, a term often used interchangeably with intermediaries.

<blockquote cite="https://datatracker.ietf.org/doc/html/rfc3234">
  <p>
    A middlebox is defined as any intermediary device performing functions other than the normal, standard functions of an IP router on the datagram path between a source host and destination host.
  </p>
  <p>
    — <a href="https://datatracker.ietf.org/doc/html/rfc3234" target="_blank">RFC3234</a>
  </p>
</blockquote>

These intermediaries can:

- **Alter traffic** (e.g., injecting ads, stripping headers).
- **Filter content** (e.g. blocking malware or phishing domains).
- **Enforce protocol** (e.g., enforcing a specific TLS version).
- **Optimize performance** (e.g., compressing data).

However, they can also introduce latency, security vulnerabilities, and compatibility issues. For example, an intermediary might not support the latest TLS version or cipher suites, leading to connection failures.

## The WebSocket Case

Since WebSocket connections use ports 80 (`ws://`) and 443 (`wss://`), the same as regular HTTP/HTTPS traffic (for obvious compatibility reasons), some intermediaries, especially the ones with outdated protocol versions, may mishandle WebSocket traffic as follows:

- **Blind upgrades**: Proxies might allow WebSocket upgrades without understanding the protocol.
- **Buffering**: Intermediaries might delay WebSocket frames, breaking real-time communication.
- **Misclassification**: Firewalls might flag WebSocket traffic as malicious, terminating connections.

## TLS Solves That

By encrypting traffic, TLS makes application-layer data (e.g., headers, payloads) **opaque to intermediaries**, preventing them from inspecting or modifying it.

However, this also creates a trade-off as it comes at the cost of losing the benefits of those intermediaries, many of which offer useful services such as caching, security scanning, and more.

The next time you wonder why most WebSocket guides recommend using TLS (`wss://`) instead of plain WebSocket (`ws://`), especially for mobile clients that often route traffic through various proxy services, this is the why.

## Conclusion

TLS doesn’t just encrypt data, it redefines the relationship between applications and the network. By preventing intermediaries from inspecting or altering traffic, TLS ensures that web communication remains intact, predictable, and free from unintended interference.
