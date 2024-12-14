---
layout: post
title: "Node.js Multithreading!"
date: 2019-10-13
description: 'Multithreading in Node.js using the worker threads module!'
image: '/assets/images/posts/synchrony-vs-asynchrony-vs-multithreading.png'
tags:
- nodejs
excerpt: 'Multithreading in Node.js using the worker threads module!'
---

Node.js is traditionally known as a single-threaded, asynchronous, event-driven JavaScript runtime.

It’s designed for building scalable network applications using non-blocking I/O and an event-driven asynchronous paradigm rather than relying on multithreading.

Before diving into the details, let’s differentiate between the terms synchrony, asynchrony, and multithreading:

- **Synchrony**: Synchrony involves processing tasks sequentially, where each task must be completed before the next begins. A single thread handles one task at a time, often resulting in idle time if a task involves waiting (e.g., for I/O).

- **Asynchrony**: Asynchrony allows a single thread to manage multiple tasks without waiting for each task to complete. Tasks are split into smaller chunks or callbacks and rely on signals or event-driven mechanisms to notify the thread when they are complete.

- **Multithreading**: Multithreading uses multiple threads to execute tasks concurrently. Each thread can independently handle a task, enabling parallel execution and reducing idle time for CPU-bound or I/O-intensive operations.

<figure class="image-figure">
  <img src="/assets/images/posts/synchrony-vs-asynchrony-vs-multithreading.png" alt="Synchrony vs Asynchrony vs Multithreading">
  <figcaption>Synchrony vs Asynchrony vs Multithreading</figcaption>
</figure>

## Is multithreading useful for I/O-bound tasks?

Well, for network applications, having multiple threads simply waiting on I/O is often inefficient. Threads consume resources, active or not.

Idle threads waste CPU time that could otherwise be put to use by threads performing actual computation.

Context switching between threads also adds overhead, as the CPU must save the current thread’s data, application pointer, and other state information, then load the corresponding data for the next thread to execute.

Moreover, shared memory access by multiple threads can lead to concurrency issues like race conditions, deadlocks, or resource starvation.

Event-driven asynchronous I/O, on the other hand, eliminates the need to manage multiple threads, enhances scalability, and simplifies application design by avoiding thread management complexities.

<blockquote cite="https://nodejs.org/en/about/">
  <p>
    Thread-based networking is relatively inefficient and very difficult to use. Furthermore, users of Node.js are free from worries of dead-locking the process since there are no locks.
  </p>
  <p>
    Almost no function in Node.js directly performs I/O, so the process never blocks. Because nothing blocks, scalable systems are very reasonable to develop in Node.js.
  </p>
  <p>
    — <a href="https://nodejs.org/en/about/" target="_blank">Node.js Documentation</a>
  </p>
</blockquote>

<figure class="image-figure">
  <img src="/assets/images/posts/blocking-vs-nonblocking-io.png" alt="Blocking vs Non-Blocking I/O">
  <figcaption>Blocking vs Non-Blocking I/O</figcaption>
</figure>

## Does Node.js use threads? Yes, it does.

Node.js uses threads in two ways:

- The main **Event Loop** thread: Executes your JavaScript code (initialization and callbacks) and handles non-blocking asynchronous operations such as network I/O.

- The **Worker Pool** (a.k.a threadpool) threads: Offloads tasks for I/O APIs that the OS can’t handle asynchronously and certain CPU-intensive operations.

*Note: we have no control over Worker Pool threads as they are managed by [`libuv`](http://docs.libuv.org/en/v1.x/threadpool.html).*

## Addressing CPU-intensive tasks beyond the Worker Pool

Consider a synchronous CPU-intensive task, such as hashing every element of a large array using the [`crypto`](https://nodejs.org/api/crypto.html) module.

```javascript
const crypto = require('crypto');

app.get('/hash-array', (req, res) => {
  const array = req.body.array; // large array
  
  // a CPU-intensive task
  for (const element of array) {
    const hash = crypto.createHmac('sha256', 'secret')
      .update(element)
      .digest('hex');

    console.log(hash);
  }
});
```

This blocking operation ties up the Event Loop thread, preventing it from handling other incoming requests until it’s done.

<blockquote cite="https://nodejs.org/en/docs/guides/dont-block-the-event-loop/">
  <p>
    Because Node handles many clients with few threads, if thread blocks handling one client’s request, then pending client requests may not get a turn until the thread finishes its callback or task.
  </p>
  <p>
    The fair treatment of clients is thus the responsibility of your application. This means you shouldn’t do too much work for any client in any single callback or task.
  </p>
  <p>
    — <a href="https://nodejs.org/en/docs/guides/dont-block-the-event-loop/" target="_blank">Node.js Documentation</a>
  </p>
</blockquote>

There are several examples of synchronous, CPU-intensive tasks or attacks that should be avoided from running continuously in the Event Loop thread:

- **ReDoS** (Regular expression Denial of Service): Using a vulnerable regular expression.
- **JSON DoS** (JSON Denial of Service): Using large JSON objects in `JSON.parse` or `JSON.stringify`.
- **Certain synchronous Node.js APIs**, such as `zlib.inflateSync`, `fs.readFileSync`, `child.execSync`, etc.
- **Computationally heavy algorithms** (e.g., `O(N²)` operations on large datasets).

## Introducing Node.js worker threads

[Node.js v12.11.0](https://nodejs.org/en/blog/release/v12.11.0/) has stabilised the [`worker_threads`](https://nodejs.org/docs/latest-v12.x/api/worker_threads.html) module after it has been experimental for the last two versions.

<blockquote cite="https://nodejs.org/docs/latest-v12.x/api/worker_threads.html">
  <p>
    Workers (threads) are useful for performing CPU-intensive JavaScript operations.
  </p>
  <p>
    They will help a little with I/O-intensive work. Node.js’s built-in asynchronous I/O operations are more efficient than Workers can be.
  </p>
  <p>
    — <a href="https://nodejs.org/docs/latest-v12.x/api/worker_threads.html" target="_blank">Node.js Documentation</a>
  </p>
</blockquote>

Let’s start with a simple example from the Node.js documentation to demonstrate how we can create worker threads:

```javascript
const crypto = require('crypto');
const { Worker, isMainThread } = require('worker_threads');

if (isMainThread) {
  console.log('Inside Main Thread!');
  
  // re-loads the current file inside a Worker instance.
  new Worker(__filename);
} else {
  console.log('Inside Worker Thread!');
  console.log(isMainThread);  // prints 'false'.
}
```

### How can worker threads communicate with their parent thread?

The `message` event is emitted for any incoming message whenever [`port.postMessage()`](https://nodejs.org/docs/latest-v12.x/api/worker_threads.html#worker_threads_port_postmessage_value_transferlist) sends data through the channel.

```javascript
const { Worker, isMainThread, parentPort } = require('worker_threads');

if (isMainThread) {
  const worker = new Worker(__filename);
  
  // receive messages from the worker thread
  worker.once('message', (message) => {
    console.log(message + ' received from the worker thread!');
  });

  // send a ping message to the spawned worker thread 
  worker.postMessage('ping');
} else {
  // when a ping message is received, send a pong message back.
  parentPort.once('message', (message) => {
    console.log(message + ' received from the parent thread!');
    parentPort.postMessage('pong');
  });
}
```

Internally, a [`Worker`](https://nodejs.org/docs/latest-v12.x/api/worker_threads.html#worker_threads_class_worker) object has a built-in pair of the [`worker.MessagePorts`](https://nodejs.org/docs/latest-v12.x/api/worker_threads.html#worker_threads_class_messageport) that are already associated with each other when the [`Worker`](https://nodejs.org/docs/latest-v12.x/api/worker_threads.html#worker_threads_class_worker) is created.

For more complex scenarios, you can create a custom `MessageChannel` instead of using the default channel.

Here is another example from the Node.js documentation that demonstrates creating a [`worker.MessageChannel`](https://nodejs.org/docs/latest-v12.x/api/worker_threads.html#worker_threads_class_messagechannel) object to be used as the underlying communication channel between the two threads:

```javascript
const assert = require('assert');

const { Worker, MessageChannel, MessagePort, isMainThread, parentPort } = require('worker_threads');

if (isMainThread) {
  const worker = new Worker(__filename);

  // create a channel in which further messages will be sent
  const subChannel = new MessageChannel();
  
  // send it through the pre-existing global channel
  worker.postMessage({ hereIsYourPort: subChannel.port1 }, [subChannel.port1]);
  
  // receive messages from the worker thread on the custom channel
  subChannel.port2.on('message', (value) => {
    console.log('received:', value);
  });
} else {
  // receive the custom channel info from the parent thread
  parentPort.once('message', (value) => {
    assert(value.hereIsYourPort instanceof MessagePort);

    // send a message to the parent thread through the channel
    value.hereIsYourPort.postMessage('the worker sent this');
    value.hereIsYourPort.close();
  });
}
```

### Worker thread standard channels

You can configure process.stderr and process.stdout to perform synchronous writes to a file, preventing issues like unexpectedly interleaved output from console.log() or console.error(), or output being lost if process.exit() is called before asynchronous write finishes.

- [`worker.stderr`](https://nodejs.org/docs/latest-v12.x/api/worker_threads.html#worker_threads_worker_stderr): If `stderr: true` wasn’t passed to the [`Worker`](https://nodejs.org/docs/latest-v12.x/api/worker_threads.html#worker_threads_class_worker) constructor, data pipes to the parent thread’s [`process.stderr`](https://nodejs.org/docs/latest-v12.x/api/process.html#process_process_stderr) [duplex stream](https://nodejs.org/docs/latest-v12.x/api/stream.html#stream_duplex_and_transform_streams).

- [`worker.stdin`](https://nodejs.org/docs/latest-v12.x/api/worker_threads.html#worker_threads_worker_stdin): If `stdin: true` was passed to the [`Worker`](https://nodejs.org/docs/latest-v12.x/api/worker_threads.html#worker_threads_class_worker) constructor, data written to this stream will be available in the worker thread as a [`process.stdin`](https://nodejs.org/docs/latest-v12.x/api/process.html#process_process_stdin).

- [`worker.stdout`](https://nodejs.org/docs/latest-v12.x/api/worker_threads.html#worker_threads_worker_stdout): If `stdout: true` wasn’t passed to the [`Worker`](https://nodejs.org/docs/latest-v12.x/api/worker_threads.html#worker_threads_class_worker) constructor, data will be piped to the parent thread's [`process.stdout`](https://nodejs.org/docs/latest-v12.x/api/process.html#process_process_stdout) [duplex stream](https://nodejs.org/docs/latest-v12.x/api/stream.html#stream_duplex_and_transform_streams).

## Let’s solve the problem we faced earlier

To avoid blocking the Event Loop with the CPU-intensive task of hashing the array elements, delegate the work to a worker thread. Once completed, the worker thread will return the hashed array to the main thread.

```javascript
// server.js
const { Worker } = require('worker_threads');

app.get('/hash-array', (req, res) => {
  const originalArray = req.body.array; // large array
  
  // create a worker thread and pass to it the originalArray
  const worker = new Worker('./worker.js', {
      workerData: originalArray
  });
  
  // receive messages from the worker thread
  worker.once('message', (hashedArray) => {
    console.log('Received the hashedArray from the worker thread!');

    // do anything with the received hashedArray
    ...
  });
});
```

And in the same folder, let’s create a `worker.js` file to write the worker logic on it:

```javascript
// worker.js
const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');

const hashedArray = [];
// perform the CPU-intensive task here
for (const element of workerData) {
  const hash = crypto.createHmac('sha256', 'secret')
    .update(element)
    .digest('hex');
  
  hashedArray.push(hash);
}

// send the hashedArray to the parent thread
parentPort.postMessage(hashedArray);
process.exit()
```

This approach prevents blocking the main Event Loop, allowing it to handle other requests concurrently.

## Conclusion

Offloading CPU-intensive synchronous tasks to worker threads and leaving only I/O-bound asynchronous tasks to the Event Loop can dramatically improve Node.js application performance.

Node.js worker threads operate in isolated contexts, minimizing traditional concurrency issues and relying on message passing for communication between the main thread and worker threads.

## Further readings

- [Tests and thoughts on asynchronous IO vs multithreading](https://www.ducons.com/blog/tests-and-thoughts-on-asynchronous-io-vs-multithreading).
- [Java concurrency (multi-threading)](https://www.vogella.com/tutorials/JavaConcurrency/article.html).
- [Node.js Worker Threads API](https://nodejs.org/docs/latest-v12.x/api/worker_threads.html).
- [Don’t Block the Event Loop (or the Worker Pool)](https://nodejs.org/en/docs/guides/dont-block-the-event-loop/).
