---
layout: post
title: "Batch or Burst? Disabling Nagle’s Algorithm with TCP_NODELAY for Better Latency"
date: 2025-01-01
description: 'When latency matters, switch off Nagle’s Algorithm: TCP_NODELAY delivers small packets without delay.'
image: '/assets/images/posts/tcp-nagle-algorithm/preview.png'
tags:
- networking
- tcp
- performance
excerpt: 'When latency matters, switch off Nagle’s Algorithm: TCP_NODELAY delivers small packets without delay.'
---

<blockquote cite="https://hpbn.co/">
  <p>
    Speed is a feature, and in fact, for some applications it is the feature.
  </p>
  <p>
    — <a href="https://hpbn.co/" target="_blank">Ilya Grigorik - High Performance Browser Networking</a>
  </p>
</blockquote>

Like everything in software engineering, every decision involves trade-offs. TCP’s Nagle’s algorithm is a perfect example of balancing latency and throughput.

This post explains how Nagle’s algorithm works, why disabling it might be beneficial, and how to go about it.

## What is Nagle's algorithm?

Nagle’s algorithm was introduced by John Nagle, [RFC 896](https://datatracker.ietf.org/doc/html/rfc896), to address the *"Small-Packet Problem"* in TCP, which arises when a stream of very small data segments (e.g., keystrokes or one-byte messages) flood the network, causing excessive network overhead.

Each TCP packet carries headers (TCP, IP, Ethernet) that can amount to 40+ bytes of overhead on top of the actual payload. If an application sends many small packets (e.g., 1-byte payloads each time), network overhead skyrockets.

Nagle’s algorithm addresses this by buffering small outgoing packets until one of two conditions is met:

1. The previously sent data **has been acknowledged (ACKed)** by the receiver.
2. The outgoing buffer has enough data to **fill a full TCP segment** up to the Maximum Segment Size (MSS) — often around 1,460 bytes on typical Ethernet networks or constrained by the network’s MTU.

<figure class="image-figure">
  <img src="/assets/images/posts/tcp-nagle-algorithm/network-data-packet.png" alt="Data Packet">
  <figcaption>Network Data Packet</figcaption>
</figure>

By waiting for these triggers, Nagle’s Algorithm **coalesces multiple small writes into fewer, larger packets**, reducing the total number of packets transmitted.

The net effect is fewer TCP packets on the wire, saving bandwidth and reducing overall network congestion. However, the trade-off is added latency for small, time-sensitive messages because data may not be sent immediately while waiting for an ACK or enough buffered data to fill a segment.

## Understanding the kernel’s socket buffers

Let’s first understand how data travels from the application to the network through the kernel’s socket buffers.

### Outgoing socket buffer

When an application writes data to a TCP socket, that data first lands in the kernel’s socket buffer. The TCP stack (in the OS kernel) controls how and when data is packaged and sent on the network.

Nagle’s algorithm is part of that process. If data is small and there’s outstanding unacknowledged data, TCP will typically wait briefly to coalesce further bytes before sending them as one larger segment.

### Inbound buffer and ACK

Once data is sent, the receiver’s TCP stack eventually sends back an ACK for the data it has received.

Upon receiving the ACK on the sender side, the socket buffer can purge the acknowledged data and can also decide to send the next batch if any is queued up and waiting.

## Nagle’s problem with Delayed ACK

Even with Nagle’s Algorithm doing its job of batching small packets to optimize throughput, the situation can get trickier when Delayed ACK enters the mix.

Delayed ACK is a common TCP feature, [RFC813](https://datatracker.ietf.org/doc/html/rfc813), implemented in most TCP stacks, that allows the receiver to wait briefly - typically around 200 ms in some TCP stacks - before sending an acknowledgment. This wait helps the receiver combine multiple ACKs into a single packet, reducing overhead and network chatter.

However, mixing Nagle’s Algorithm with Delayed ACK may create **a feedback loop of waiting**:

1. Sender Side (Nagle’s Algorithm): The sender may hold back on transmitting more data if it hasn’t received an ACK for the previous packet, especially if the data being sent is small.
2. Receiver Side (Delayed ACK): The receiver might hold off on sending the ACK right away, hoping to bundle multiple ACKs or piggyback the ACK with outgoing data.

Result: Both sides wait- **Nagle's Algorithm waits for the ACK to send more data, and Delayed ACK waits to send the ACK**, creating latency spikes.

This is sometimes referred to as the *"Silly Window Syndrome"* or an extension of it, where neither side proceeds quickly due to mismatched waiting strategies.

<blockquote cite="https://news.ycombinator.com/item?id=10608356">
  <p>
    A delayed ACK is a bet that the other end will reply to what you just sent almost immediately. Except for some RPC protocols, this is unlikely. So the ACK delay mechanism loses the bet over and over, delaying the ACK, waiting for a packet on which the ACK can be piggybacked, not getting it, and then sending the ACK delayed.
  </p>
  <p>
    — <a href="https://news.ycombinator.com/item?id=10608356" target="_blank">John Nagle</a>
  </p>
</blockquote>

In high-latency or real-time scenarios, this feedback loop can degrade application responsiveness. This is often addressed by disabling either Nagle’s Algorithm (`TCP_NODELAY`) or Delayed ACK where possible (`TCP_QUICKACK`) to prevent the two mechanisms from interfering with each other and causing undesirable delay.

<figure class="image-figure">
  <img src="/assets/images/posts/tcp-nagle-algorithm/tcp-with-nagle-algorithm-and-delayed-ack.png" alt="TCP with Nagle's Algorithm and Delayed ACK">
  <figcaption>TCP with Nagle's Algorithm and Delayed ACK</figcaption>
</figure>

## Disabling Nagle’s algorithm with TCP_NODELAY

When latency is more important than bandwidth efficiency, we can disable Nagle’s algorithm on a per-socket basis by using the `TCP_NODELAY` socket option. This tells the kernel to send out packets as soon as possible, regardless of whether there is unacknowledged data.

In Python's socket library, you can set the `TCP_NODELAY` option like this:

```python
import socket
import http.client


class CustomHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.create_connection((self.host, self.port), self.timeout)
        # Disable Nagle's Algorithm by setting TCP_NODELAY to 1
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)


conn = CustomHTTPConnection('example.com')

try:
    conn.connect()
    conn.request('GET', '/')
    res = conn.getresponse()

    body = res.read()
    print(body.decode())
finally:
    conn.close()
```

Other languages have similar mechanisms. For instance, in Ruby’s with the `net/http` library, you can do:

```ruby
require 'net/http'

class CustomHTTP < Net::HTTP
  def on_connect()
    # Disable Nagle's Algorithm by setting TCP_NODELAY to 1
    @socket.io.setsockopt(Socket::IPPROTO_TCP, Socket::TCP_NODELAY, 1)
  end
end

CustomHTTP.new('example.com').start do |http|
  req = Net::HTTP::Get.new('/')

  res = http.request(req)
  puts res.body
end
```

In curl, you can use the `--tcp-nodelay` option like this:

```bash
curl --tcp-nodelay http://example.com
```

## Conclusion

Nagle’s Algorithm enhances network efficiency for bulk data transfers by batching small TCP packets, thereby optimizing throughput. However, in latency-sensitive applications, this batching can introduce undesirable delays.

The `TCP_NODELAY` option addresses this issue by disabling Nagle’s Algorithm, enabling the immediate transmission of small packets as soon as they arrive. Deciding whether to enable or disable it depends on the application's traffic patterns and performance requirements.

## Further readings

- [The Caveats of TCP_NODELAY](https://eklitzke.org/the-caveats-of-tcp-nodelay)
- [In search of performance - how we shaved 200ms off every POST request](https://gocardless.com/blog/in-search-of-performance-how-we-shaved-200ms-off-every-post-request/)
- [It’s always TCP_NODELAY. Every damn time](https://brooker.co.za/blog/2024/05/09/nagle.html)
