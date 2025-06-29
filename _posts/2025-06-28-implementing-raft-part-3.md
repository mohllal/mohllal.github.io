---
layout: post
title: "Implementing Raft: Part 3 - Log Replication"
date: 2025-06-28
description: "From heartbeats to data synchronization: implementing the core logic that keeps distributed nodes in perfect sync, even when networks fail and servers crash."
image: '/assets/images/posts/implementing-raft-part-3/preview.png'
tags:
- raft
- distributed consensus
excerpt: "From heartbeats to data synchronization: implementing the core logic that keeps distributed nodes in perfect sync, even when networks fail and servers crash."
---

In [Part 2](/implementing-raft-part-2), we implemented leader election and got our cluster to choose a leader and maintain leadership through heartbeats. But a leader that can't do anything useful isn't much of a leader!

Now it's time to implement the heart of any distributed system: **log replication**. This is how Raft ensures that every node in your cluster has the exact same data, in the exact same order, even when networks partition and servers crash.

> **Note:** The code snippets in this post are simplified to focus on the core concepts. You can find the complete working implementation on [GitHub](https://github.com/mohllal/raft-ruby).

## What is log replication, and why do we need it?

Think of Raft's log as a journal of events. Every change to your system's state gets written down as an entry in this journal. The leader's job is to make sure every follower has an identical copy of this journal.

Here's why this matters: imagine you're building a distributed key-value store. A client wants to set `username = "alice"`. Without log replication:

- The leader might apply this change
- But if the leader crashes before telling the followers...
- A new leader gets elected who has never heard of Alice
- Alice's data is gone forever! ❌

With log replication, the leader won't apply the change until a majority of nodes have safely written it to their logs. This way, even if the servers crash, Alice's data survives.

## Building the foundation

Let's first build some of the data structures that will help us implement log replication and its persistence.

### Log entries

Let's start with the basic structure of a log entry:

```ruby
module Raft
  module Models
    LogEntry = Struct.new(
      :term,      # When this entry was created
      :index,     # Position in the log (starts at 1)
      :command,   # The actual operation to perform
      keyword_init: true
    )
  end
end
```

Each entry has three key pieces of information:

- **Term**: Tells us which leader created this entry
- **Index**: The entry's position in the log (like a page number)
- **Command**: The actual operation, like `{ type: 'SET', key: 'username', value: 'alice' }`

### Keeping track of log replication progress

Now we need to extend our `RaftNode` class from Part 2 with new attributes to track log state and replication progress.

```ruby
module Raft
  class RaftNode
    # ... existing attributes from Part 2 ...

    def initialize(id, cluster_nodes = [], port = nil)
      # ... existing initialization ...

      # Log storage
      @log = []                    # Array of LogEntry objects
      @highest_committed_index = 0 # Index of highest log entry known to be committed
      @applied_up_to_index = 0     # Index of highest log entry applied to state machine

      # Leader-only state
      @follower_next_replication_index = {} # For each follower, index of next log entry to send
      @follower_confirmed_index = {}        # For each follower, index of highest log entry confirmed

      # State machine for applying committed entries (we will come back to this later)
      @state_machine = StateMachine.new(id)
    end

    private

    attr_accessor :log, :applied_up_to_index, :follower_next_replication_index,
      :follower_confirmed_index, :highest_committed_index
    attr_reader :state_machine
  end
end
```

Let's understand what each of these does:

- **`log`**: The heart of Raft - stores all log entries in order.
- **`highest_committed_index`**: Tracks which entries are "safe" (replicated to the majority of nodes).
- **`applied_up_to_index`**: Tracks which entries we've actually executed.
- **`follower_next_replication_index`**: The leader's best guess of what to send each follower next.
- **`follower_confirmed_index`**: The leader's confirmed knowledge of what each follower has.

The separation between `highest_committed_index` and `applied_up_to_index` is important. An entry being committed (safe) doesn't mean it's been applied to the state machine yet.

### Keeping data safe across crashes

To ensure that committed data survives crashes, we need to persist both log entries and metadata (such as the current term and the last applied index) to disk.

```ruby
module Raft
  class LogPersistence
    def initialize(node_id)
      @log_dir = File.join('/logs', node_id.to_s)
      @log_file = File.join(log_dir, 'log.json')
      @metadata_file = File.join(log_dir, 'metadata.json')
      
      FileUtils.mkdir_p(log_dir)
    end

    def save_log(log_entries)
      File.write(log_file, JSON.pretty_generate(log_entries.map(&:to_h)))
    end

    def load_log
      return [] unless File.exist?(log_file)
      
      data = JSON.parse(File.read(log_file))
      data.map { |entry_data| Models::LogEntry.from_hash(entry_data) }
    end

    def save_metadata(metadata)
      File.write(metadata_file, JSON.pretty_generate(metadata.to_h))
    end

    def load_metadata
      return {} unless File.exist?(metadata_file)
      
      JSON.parse(File.read(metadata_file))
    end

    private

    attr_reader :log_dir, :log_file, :metadata_file
  end
end
```

Our simple approach writes the entire log on every change, which works for demos but would be too slow for real workloads.

Production Raft implementations like `etcd` use sophisticated storage engines optimized for append-heavy workloads.

## Beyond heartbeats: AppendEntries with actual data

Remember heartbeats from Part 2? They were just empty `AppendEntries` messages. Now we'll use the same RPC to send actual log entries:

```ruby
def replicate_to_follower(follower_id, follower_node)
  next_idx = follower_next_replication_index[follower_id] || 1

  # For log consistency, we need to include the previous entry info
  prev_log_index = next_idx - 1
  prev_log_term = 0
  if prev_log_index > 0 && prev_log_index <= log.length
    prev_log_term = log[prev_log_index - 1].term
  end

  # Send entries from next_idx onwards
  entries_to_send = []
  if next_idx <= log.length
    entries_to_send = [log[next_idx - 1]]
  end

  request = Models::AppendEntries::Request.new(
    leader_id: id,
    term: current_term,
    prev_log_index: prev_log_index,    # "Before this entry..."
    prev_log_term: prev_log_term,      # "...you should have an entry from term X"
    log_entries: entries_to_send,      # The actual data!
    leader_commit: highest_committed_index
  )

  response = follower_node.append_entries(request)
  handle_append_entries_response(follower_id, request, response)
end
```

The `prev_log_index` and `prev_log_term` fields are Raft's **consistency check**. The leader is saying: "Before you accept this new entry, make sure your log matches mine up to this point."

## Followers: Accepting or rejecting log entries

When a follower receives an `AppendEntries` request with actual log entries, it has to do some careful checking:

```ruby
def append_entries(request)
  mutex.synchronize do
    # ... term checking logic from Part 2 ...

    # The key addition: handle log conflicts
    success = handle_log_conflicts(
      request.prev_log_index, 
      request.prev_log_term, 
      request.log_entries
    )

    if success
      # Update our commit index if the leader has advanced
      if request.leader_commit > highest_committed_index
        old_commit = highest_committed_index
        self.highest_committed_index = [request.leader_commit, last_log_index].min
        
        logger.info "Updated commit index from #{old_commit} to #{highest_committed_index}"
        apply_committed_entries  # Apply to state machine!
      end
      
      Models::AppendEntries::Response.new(
        term: current_term, success: true, last_log_index: last_log_index
      )
    else
      Models::AppendEntries::Response.new(
        term: current_term, success: false, last_log_index: last_log_index
      )
    end
  end
end
```

But what if a follower's log doesn't match the leader's? This can happen after network partitions or leader changes. Raft's solution: **when in doubt, the leader wins**.

Here is the code that handles log conflicts:

```ruby
def handle_log_conflicts(prev_log_index, prev_log_term, new_entries)
  # Check if we have the previous entry the leader expects
  if prev_log_index > 0
    if prev_log_index > log.length
      # We're missing entries - reject this request
      logger.debug "Missing entries: our log ends at #{log.length}, " \
                   "but prev_log_index is #{prev_log_index}"
      return false
    end

    # Check if the previous entry matches what leader expects
    prev_entry = log[prev_log_index - 1]
    if prev_entry.term != prev_log_term
      # Conflict! Remove this entry and everything after it
      logger.info "Log conflict at index #{prev_log_index}: " \
                  "expected term #{prev_log_term}, got #{prev_entry.term}"
      self.log = log[0...prev_log_index - 1]
      persist_state
      return false  # Leader will retry with earlier entries
    end
  end

  # If we get here, we can safely append the new entries
  if new_entries && !new_entries.empty?
    # Remove any conflicting entries first
    insert_index = prev_log_index
    new_entries.each_with_index do |new_entry, idx|
      current_index = insert_index + idx
      if current_index < log.length && log[current_index].term != new_entry.term
        # Truncate our log at the conflict point
        self.log = log[0...current_index]
        break
      end
    end

    # Append the new entries
    self.log = log[0...insert_index] + new_entries
    persist_state
    logger.info "Appended #{new_entries.length} entries to log"
  end

  true
end
```

This looks complex, but the logic is simple:

1. **Check consistency**: Do we have the entry that the leader expects at `prev_log_index`?
2. **Handle conflicts**: If our log differs, remove the conflicting entries and everything after them
3. **Append new entries**: Add the leader's entries to our log

## When is an entry "committed"?

A log entry becomes **committed** when a majority of nodes have it safely stored. Only committed entries get applied to the state machine.

```ruby
def advance_highest_committed_index
  return unless state == NodeState::LEADER

  # Find the highest index that a majority of nodes have
  confirmed_indices = follower_confirmed_index.values + [log.length]  # Include our own log
  sorted_indices = confirmed_indices.sort.reverse

  majority_size = (cluster_size / 2) + 1
  new_highest_committed_index = sorted_indices[majority_size - 1]

  # Safety rule: only commit entries from the current term
  if new_highest_committed_index > highest_committed_index &&
     new_highest_committed_index <= log.length &&
     log[new_highest_committed_index - 1].term == current_term

    old_highest_committed_index = highest_committed_index
    self.highest_committed_index = new_highest_committed_index
    logger.info "Advanced highest committed index from #{old_highest_committed_index} to #{highest_committed_index}"

    # Apply newly committed entries to state machine
    apply_committed_entries

    # Persist the new highest committed index
    persist_metadata
  end
end
```

The **"only commit entries from the current term"** rule is a subtle but crucial safety guarantee in Raft. It prevents a scenario where an old leader's entries get committed after they're already stale.

## Applying entries to the state machine

Once entries are committed, we apply them to our actual application state:

```ruby
def apply_committed_entries
  while applied_up_to_index < highest_committed_index
    self.applied_up_to_index += 1
    next unless applied_up_to_index <= log.length

    entry = log[applied_up_to_index - 1]
    result = state_machine.apply(entry.command)
    
    logger.info "Applied entry #{applied_up_to_index}: " \
                "#{entry.command} => #{result}"
  end

  persist_metadata  # Save our progress
end
```

Our state machine is a simple key-value store:

```ruby
class StateMachine
  def initialize(node_id)
    @node_id = node_id
    @data_dir = File.join('/data', node_id.to_s)
    @state_file = File.join(data_dir, 'state.json')
    @store = JSON.parse(File.read(state_file))
  end

  def apply(command)
    case command['type']
    when 'SET'
      set(command['key'], command['value'])
    when 'GET'
      get(command['key'])
    when 'DELETE'
      delete(command['key'])
    end
  end

  private

  attr_reader :node_id, :store, :data_dir, :state_file

  def set(key, value)
    old_value = store[key]
    store[key] = value
    persist_state  # Save to disk
    
    { success: true, key: key, value: value, old_value: old_value }
  end

  def persist_state
    File.write(state_file, JSON.pretty_generate(store))
  end
  
  # ... GET and DELETE implementations ...
end
```

## The replication protocol: Handling success and failure

When the leader sends log entries to followers, it needs to handle both success and failure responses:

```ruby
def handle_append_entries_response(follower_id, request, response)
  mutex.synchronize do
    if response.successful?
      # Update our tracking of what this follower has
      sent_entries = request.log_entries || []
      if sent_entries.any?
        follower_confirmed_index[follower_id] = request.prev_log_index + sent_entries.length
        follower_next_replication_index[follower_id] = follower_confirmed_index[follower_id] + 1
      end

      # Check if we can now commit more entries
      advance_highest_committed_index

      # Continue replicating if there are more entries
      if follower_next_replication_index[follower_id] <= log.length
        Thread.new { replicate_to_follower(follower_id, remote_nodes[follower_id]) }
      end
    else
      # Failed - the follower's log doesn't match ours
      # Step backwards and try again
      follower_next_replication_index[follower_id] = [1, (follower_next_replication_index[follower_id] || 1) - 1].max
      logger.debug "AppendEntries failed for #{follower_id}, " \
            "decremented follower_next_replication_index to #{follower_next_replication_index[follower_id]}"

      # Retry with the earlier index
      Thread.new { replicate_to_follower(follower_id, remote_nodes[follower_id]) }
    end
  end
end
```

This **"step backwards on failure"** approach ensures that the leader eventually finds the point where its log matches the follower's log, then brings the follower up to date.

## Picking up where we left off

When a node crashes and restarts, it should recover its exact state and continue participating in the cluster.

Let's see how we integrate persistence into our node initialization:

```ruby
module Raft
  class RaftNode
    def initialize(id, cluster_nodes = [], port = nil)
      @id = id
      @cluster_nodes = cluster_nodes
      @port = port

      # ... other initialization from Part 2 ...

      # Initialize persistence and recover state
      initialize_log_storage
      
      # ... rest of initialization ...
    end

    private

    def initialize_log_storage
      @log_persistence = LogPersistence.new(id)
      load_persistent_state
    end

    def load_persistent_state
      # Load log entries from disk
      self.log = log_persistence.load_log

      # Load metadata (current_term, voted_for, highest_committed_index, applied_up_to_index)
      metadata = log_persistence.load_metadata
      self.current_term = metadata['current_term'] || 0
      self.voted_for = metadata['voted_for']
      self.highest_committed_index = metadata['highest_committed_index'] || 0
      self.applied_up_to_index = metadata['applied_up_to_index'] || 0

      logger.info "Recovered persistent state: term=#{current_term}, " \
                  "log_size=#{log.length}, commit=#{highest_committed_index}, " \
                  "applied=#{applied_up_to_index}"

      # Apply any committed entries that we haven't applied yet
      # (this can happen if we crashed after committing but before applying)
      apply_committed_entries if applied_up_to_index < highest_committed_index
    end

    def persist_state
      persist_log
      persist_metadata
    end

    def persist_metadata
      metadata = {
        current_term: current_term,
        voted_for: voted_for,
        highest_committed_index: highest_committed_index,
        applied_up_to_index: applied_up_to_index
      }
      log_persistence.save_metadata(metadata)
    end

    def persist_log
      log_persistence.save_log(log)
    end
  end
end
```

### What happens during crash recovery?

When a Raft node restarts after a crash, here's the recovery process:

1. **Load persistent state**: The node reads its log, current term, vote status, and indices from disk
2. **Restore log entries**: All log entries are loaded back into memory in the correct order
3. **Check for uncommitted work**: If there are committed entries that weren't applied before the crash, apply them now
4. **Resume normal operation**: The node starts as a follower and rejoins the cluster

Let's see this in action with some example output:

```bash
# Node crashes and restarts
=== Starting Raft Node ===
Node ID: node2
Port: 8002
==========================

[INFO] Recovered persistent state: term=3, log_size=5, commit=5, applied=3, highest_committed_index=5
[INFO] Applied entry 4: SET email alice@example.com => {success: true}
[INFO] Applied entry 5: SET age 25 => {success: true}
[INFO] Node node2 ready - recovered from crash with 5 log entries
```

### Why this recovery model works

This crash recovery approach provides several important guarantees:

- **No committed data is lost**: Once an entry is committed, it survives any number of crashes
- **Consistent restart**: Nodes always restart in a valid state that's consistent with the cluster
- **Automatic catch-up**: Restarted nodes automatically apply any committed entries they missed
- **Durability**: The separation of commit and apply means we never lose acknowledged client operations

Even in the worst case, where a node crashes right after committing an entry but before applying it, the recovery process ensures that the entry gets applied when the node restarts.

## Putting it all together

Let's run our demo and see if log replication is working. First, start the three nodes.

```bash
# Terminal 1: ruby demo/start_node.rb node1
# Terminal 2: ruby demo/start_node.rb node2  
# Terminal 3: ruby demo/start_node.rb node3
```

I've created a [simple script](https://github.com/mohllal/raft-ruby/blob/main/demo/distributed_cluster_demo.rb) to allow you to interact with the cluster and do some basic operations like adding data, getting data, and watching the cluster status.

```bash
ruby demo/distributed_cluster_demo.rb
```

You'll see a menu where you can submit commands:

```bash
=== Distributed Raft Cluster Demo ===

This demo shows a 3-node Raft cluster with real network communication.

=== Current Cluster State ===
node1: leader (term: 3, log index: 6)
node2: follower (term: 3, log index: 6)
node3: follower (term: 3, log index: 6)

Waiting for leader election...

✓ Leader elected: node1

=== Demonstrating Cluster Behavior ===

1. Heartbeats:
   The leader is sending heartbeats to maintain leadership.
   Watch the node logs to see AppendEntries messages.

2. Log Replication:
   Adding log entry through leader (node1)...
   ✓ Log entry added: LogEntry(term=3, index=7, cmd=SET demo_key demo_value)

   Checking replication status:
   node1: log length = 7, commit index = 7
   node2: log length = 7, commit index = 7
   node3: log length = 7, commit index = 7

3. Fault Tolerance:
   You can test fault tolerance by:
   - Stopping the leader (Ctrl+C) and watching a new election
   - Stopping a follower and seeing the cluster continue
   - Restarting a stopped node and watching it catch up

4. Interactive Mode:
   Commands:
   - status: Show cluster status
   - add <key> <value>: Add a log entry
   - quit: Exit demo

> add username alice
> add email alice@example.com
> status
```

Behind the scenes, here's what happens:

```bash
# Leader (node1) output:
[INFO] Received client command: SET username alice
[INFO] Appended log entry: LogEntry(term=1, index=1, cmd=SET username alice)
[INFO] Sending AppendEntries to node2 (prev: 0/0, entries: 1)
[INFO] Sending AppendEntries to node3 (prev: 0/0, entries: 1)
[INFO] Received successful response from node2
[INFO] Received successful response from node3  
[INFO] Advanced commit index from 0 to 1
[INFO] Applied entry 1: SET username alice => {success: true, key: username, value: alice}

# Follower (node2) output:
[INFO] Received AppendEntries(leader: node1, term: 1, prev: 0/0, entries: 1)
[INFO] Appended 1 entries to log
[INFO] Updated commit index from 0 to 1
[INFO] Applied entry 1: SET username alice => {success: true, key: username, value: alice}
```

**The magic**: All three nodes now have `username = alice` in their state machines, and they'll all agree on this fact forever, even through crashes and network partitions!

## What happens during failures?

Let's kill the leader and add more data:

```bash
# Stop node1 (Ctrl+C in its terminal)
# Node2 becomes leader after election

# Add more data
> add email alice@example.com
```

You'll see the new leader (node2) continue replicating to the remaining followers:

```bash
# New leader (node2) output:
[INFO] Became leader (term 2)
[INFO] Received client command: SET email alice@example.com
[INFO] Appended log entry: LogEntry(term=2, index=2, cmd=SET email alice@example.com)
[INFO] Sending AppendEntries to node3 (prev: 1/1, entries: 1)
[INFO] Advanced commit index from 1 to 2
```

When node1 comes back online, it will catch up as the new leader will replicate the missing entries in the next `AppendEntries` call (or the heartbeat message, which technically is an `AppendEntries` call with no entries).

```bash
# Restart node1
ruby demo/start_node.rb node1
```

The restarted node will receive all the entries it missed and get back in sync:

```bash
# Restarted node1 output:
[INFO] Received AppendEntries(leader: node2, term: 2, prev: 1/1, entries: 1)
[INFO] Appended 1 entries to log  
[INFO] Updated commit index from 1 to 2
[INFO] Applied entry 2: SET email alice@example.com
```

## What's next?

Congratulations! You've now implemented the core of a distributed consensus system.

Your Raft cluster can:

- ✅ Elect leaders reliably
- ✅ Replicate data consistently  
- ✅ Handle network partitions
- ✅ Recover from crashes
- ✅ Maintain strong consistency

There is still a lot to explore if you want to build a production-ready Raft implementation:

- **Log compaction** (snapshots to prevent logs from growing forever).
- **Membership changes** (adding/removing nodes safely).
- **Performance optimizations** (replication batching, pipelining).
- **Adding a data storage better suited for Raft logs** (like a database that can handle append-heavy workloads).

But with what we've built so far, you have a solid foundation for understanding how distributed systems achieve consensus in the real world!

The complete working code is available on [GitHub](https://github.com/mohllal/raft-ruby), feel free to experiment, break things, and see how Raft handles the chaos. After all, that's what it's designed for!
