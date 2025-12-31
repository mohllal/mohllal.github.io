---
layout: post
title: "Implementing Raft, Part 2: Leader Election"
date: 2025-06-14
category: Implementing Raft
description: "Let's bring Raft's leader election to life with Ruby code. We'll implement the core logic that allows nodes to elect a leader, even when things go wrong."
image: '/assets/images/posts/implementing-raft-part-2/preview.png'
tags:
- ruby
- distributed systems
- raft
- consensus
excerpt: "Let's bring Raft's leader election to life with Ruby code. We'll implement the core logic that allows nodes to elect a leader, even when things go wrong."
---

In the [previous post](/implementing-raft-part-1), we explored the theory behind Raft's leader election and log replication processes. We learned how nodes transition between follower, candidate, and leader states, and how they use terms and voting to reach consensus on who should lead.

Now it's time to roll up our sleeves and turn those concepts into working Ruby code. Don't worry if you haven't memorized every detail from the last post; we'll refresh the important bits as we go along.

*Note: The code snippets provided here are simplified to focus on the core concepts. You can find the complete working implementation on this [repo](https://github.com/mohllal/raft-ruby).*

## Laying the groundwork

### How nodes talk to each other

Before we dive into leader election, we need a way for nodes to communicate. In a real-world distributed system, you’d typically use something like gRPC, REST APIs, or even a message broker like Kafka.

For our implementation, we'll use Ruby's built-in [`DRb`](https://docs.ruby-lang.org/en/3.2/DRb.html) (Distributed Ruby) library, which is simple to set up and perfect for demo purposes.

Each node needs to run a DRb server listening on its port:

```ruby
module Raft
  class DRbServer
    def initialize(node, port)
      @node = node
      @port = port
      @server_thread = nil
      @logger = Logger.new(STDOUT)
    end

    def start
      return if server_thread&.alive?

      begin
        uri = "druby://localhost:#{port}"

        DRb.start_service(uri, node)

        logger.info "DRb server started on #{uri}"

        # Keep server running in background thread
        self.server_thread = Thread.new do
          Thread.current.abort_on_exception = true
          DRb.thread.join
        end

        server_thread
      rescue StandardError => e
        logger.error "Failed to start DRb server: #{e.message}"
        raise
      end
    end
  end

  def stop
    return unless server_thread&.alive?

    logger.info "Stopping DRb server on port #{port}"
    DRb.stop_service
    server_thread.kill if server_thread.alive?
    self.server_thread = nil
  end

  private

  attr_reader :node, :port, :logger
  attr_accessor :server_thread
end
```

To talk to other nodes (forming a cluster), we create remote node connections:

```ruby
module Raft
  class RemoteNode
    def initialize(node_id, port)
      @node_id = node_id
      @uri = "druby://localhost:#{port}"
      @remote_node = DRbObject.new_with_uri(@uri)
    end

    attr_reader :node_id, :uri, :remote_node

    def request_vote(request)
      remote_node.request_vote(request)
    end

    def append_entries(request)
      remote_node.append_entries(request)
    end
  end
end
```

This abstraction lets us call methods on remote nodes as if they were local objects (in our case, the `RaftNode` class).

In production-grade systems, you'd replace this with proper RPC calls and put a retry logic, but the concept remains the same.

### Setting up our Raft node

First, let's define the three states a Raft node can be in:

```ruby
module Raft
  module NodeState
    FOLLOWER = :follower
    CANDIDATE = :candidate
    LEADER = :leader
  end
end
```

Next, we need to create our Raft node class, this is where all the magic happens. Each node needs to track a few things. Let's start with the most important ones:

```ruby
module Raft
  class RaftNode
    attr_reader :id, :state, :current_term, :voted_for

    def initialize(id, port = nil)
      @id = id
      @port = port

      # Persistent state (must survive restarts)
      @current_term = 0
      @voted_for = nil

      # Node starts as a follower
      @state = NodeState::FOLLOWER

      # Cluster remote nodes and DRb server
      @remote_nodes = {}
      @drb_server = nil

      # For thread safety
      @mutex = Mutex.new

      # Timers for elections and heartbeats
      @election_timer = nil
      @heartbeat_timer = nil

      # Logger
      @logger = Logger.new(STDOUT)

      # Start election timer (all nodes start as followers)
      start_election_timer

      logger.info "Node #{id} initialized as #{state}"
    end

    private

    attr_reader :logger, :mutex, :port
    attr_accessor :drb_server, :election_timer, :heartbeat_timer, :remote_nodes
  end
end
```

Notice how every node starts as a **follower** with **term `0`**. This makes sense when a cluster first forms, no one is in charge yet, and everyone is waiting to see who will step up as leader.

## The election timeout: Detecting leader failures

Remember from our last post that elections are triggered by timeouts. If a follower doesn't hear from a leader for too long, it assumes something is wrong and starts an election. In Raft, this is known as the **election timeout**.

Let's implement this timing mechanism:

```ruby
def start_election_timer
  # Randomized timeout between 5-10 seconds
  election_timeout = rand(5..10)

  self.election_timer = Thread.new do
    sleep(election_timeout)

    # If we are not a leader, start an election
    if state != NodeState::LEADER
      logger.info 'Election timeout - starting election'
      start_election
    end
  end
end

def stop_election_timer
  return unless election_timer

  election_timer.kill if election_timer != Thread.current
  self.election_timer = nil
end

def reset_election_timer
  stop_election_timer
  start_election_timer
end
```

The **randomization** of the election timeout is key here. By giving each node a different timeout (say, between 5 and 10 seconds), we reduce the chances of multiple nodes starting elections simultaneously, which helps avoid **split votes**.

## Starting an election: From follower to candidate

When a node's election timer expires, it's time to throw its hat in the ring and become a candidate.

Here's how a node transitions from follower to candidate:

```ruby
def become_candidate
  self.state = NodeState::CANDIDATE
  self.current_term += 1  # Increment term for new election
  self.voted_for = id     # Vote for self

  reset_election_timer

  logger.info "Became candidate (term #{current_term})"
end
```

Notice three important things happening here:

1. We **increment the term number** (our logical clock).
2. We **vote for ourselves**.
3. We **reset the election timer** to retry if this election fails (no majority votes).

## Requesting and accepting votes: From candidate to leader

Now comes the important part of actually running the election. A candidate needs to receive a **majority of votes** to become the new leader.

First, we need to send a `RequestVote` message to each node in parallel:

```ruby
def majority_count
  (remote_nodes.size + 1) / 2 + 1
end

def start_election
  become_candidate
  logger.info "Starting election for term #{current_term}"

  votes_received = 1  # We already voted for ourselves
  votes_needed = majority_count
  logger.info "Need #{votes_needed} votes, got 1 (self)"

  # Request votes from all other nodes in parallel
  remote_nodes.each do |node_id, remote_node|
    Thread.new do
      vote_request = Models::RequestVote::Request.new(candidate_id: id, term: current_term)
      
      response = remote_node.request_vote(vote_request)
      
      process_vote_response(response, votes_received, votes_needed)
    rescue StandardError => e
      logger.warn "Failed to get vote from #{node_id}: #{e.message}"
    end
  end
end
```

We spawn a separate thread for each vote request. This parallelism is important, we don't want to wait for slow nodes when others might be ready to vote immediately and to also avoid hitting the election timeout in case of doing it sequentially.

When vote responses come back, we handle them based on the term in the response:

- If we receive responses with older terms than ours (imagine we started an election in the term `5`, but while waiting for votes, we either started a new election (now in term `6`) or received a message that bumped us to a higher term), we basically **ignore them**.
- If we receive responses with higher terms than ours, it tells us there's been more recent activity in the cluster (perhaps another node won an election while we were campaigning), we **immediately step down** to follower and adopt this higher term.

```ruby
def process_vote_response(response, votes_received, votes_needed)
  mutex.synchronize do
    # Only count votes if we're still a candidate in the same term
    if state == NodeState::CANDIDATE && current_term == response.term
      if response.granted?
        votes_received += 1
        logger.info "Received vote (#{votes_received}/#{votes_needed})"

        # Did we win?
        if votes_received >= votes_needed
          logger.info "Won election with #{votes_received} votes!"
          become_leader
        end
      end
    elsif response.term > current_term
      # Oops, someone has a higher term - we're out of date
      logger.info "Discovered higher term #{response.term}"
      become_follower(response.term)
    end
  end
end
```

The mutex synchronization is important here because multiple vote responses might arrive simultaneously, and we need to ensure our vote counting is **thread-safe**.

## Granting votes: Being a good citizen

Now let's look at the other side, how nodes decide whether to grant their vote:

```ruby
def request_vote(request)
  mutex.synchronize do
    logger.info "Received #{request}"

    # Rule 1: Reject if the candidate's term is old
    if request.term < current_term
      logger.info "Rejecting vote - term too old"
      return Models::RequestVote::Response.new(term: current_term, vote_granted: false)
    end

    # Rule 2: Update our term if we see a newer one
    become_follower(request.term) if request.term > current_term

    # Rule 3: Grant vote if we haven't voted yet
    can_vote = voted_for.nil? || voted_for == request.candidate_id

    if can_vote
      self.voted_for = request.candidate_id
      reset_election_timer  # Reset timer when granting vote

      logger.info "Granted vote to #{request.candidate_id}"
      Models::RequestVote::Response.new(term: current_term, vote_granted: true)
    else
      logger.info "Denied vote - already voted for someone else"
      Models::RequestVote::Response.new(term: current_term, vote_granted: false)
    end
  end
end
```

There are a lot of things packed into this voting logic:

- We **only vote once per term** (preventing multiple leaders in the same term).
- We **reset our election timer** when granting a vote (giving the new leader time to establish itself).

In the next post, we'll add an additional safety check to ensure candidates have up-to-date logs before we vote for them. For now, our simplified implementation focuses on the core voting mechanism.

## Becoming the leader: Victory!

When a candidate receives enough votes, it transitions to the leader state:

```ruby
def become_leader
  self.state = NodeState::LEADER

  # Stop election timer since we go to leader state
  stop_election_timer

  # Reset heartbeat timer and start sending heartbeats
  reset_heartbeat_timer

  logger.info "Became leader (term #{current_term})"
end
```

The new leader needs to start sending heartbeats to all other nodes to announce its leadership and prevent other nodes from starting unnecessary elections.

### Heartbeats: Keeping the cluster in sync

Heartbeats are how the leader maintains its leadership and keeps followers from starting new elections.

In Raft, heartbeats are actually empty `AppendEntries` messages. Here's how the leader sends them:

```ruby
def send_heartbeats
  return unless leader?

  logger.info 'Sending heartbeats to followers'

  remote_nodes.each do |node_id, remote_node|
    Thread.new do
      heartbeat = Models::AppendEntries::Request.new(
        leader_id: id,
        term: current_term,
        log_entries: []  # Empty = heartbeat!
      )
      
      response = remote_node.append_entries(heartbeat)
      
      # Check if someone has a higher term, if so, we step down as a follower
      mutex.synchronize do
        if response.term > current_term
          logger.info "Discovered higher term #{response.term} - stepping down"
          become_follower(response.term)
        end
      end
    rescue StandardError => e
      logger.warn "Failed to send heartbeat to #{node_id}: #{e.message}"
    end
  end
end
```

The leader sends heartbeats at a regular interval:

```ruby
def start_heartbeat_timer
  self.heartbeat_timer = Thread.new do
    while leader?
      send_heartbeats
      sleep(1.0)  # Send heartbeat every second
    end
  end
end
```

From the follower's perspective, receiving a heartbeat (or any `AppendEntries`) resets their election timer:

```ruby
def append_entries(request)
  mutex.synchronize do
    # Reply false if term < currentTerm
    if request.term < current_term
      return Models::AppendEntries::Response.new(term: current_term, success: false)
    end

    # Any valid AppendEntries from current/newer term resets election timer
    if request.term >= current_term
      become_follower(request.term)
      reset_election_timer  # This prevents new elections!
    end

    # For now, just acknowledge the heartbeat
    Models::AppendEntries::Response.new(term: current_term, success: true)
  end
end
```

As long as the leader is alive and the network is functioning, followers keep **resetting their election timers**, and the leader remains in charge.

Only when heartbeats stop arriving do followers assume something is wrong and trigger a new election.

## Handling edge cases: When things don't go as planned

### Split votes

What if no candidate gets a majority? This can happen when multiple nodes become candidates at nearly the same time. Each candidate will:

1. Fail to achieve a majority
2. Eventually timeout
3. Start a new election with a higher term

The randomized timeouts make it likely that one candidate will start slightly earlier in the next round and win.

### Network partitions

Consider what happens when the network splits. If a leader ends up in a **minority partition**, it can't get acknowledgements from a majority of nodes.

Meanwhile, the **majority partition** will elect a new leader. When the partition heals, the old leader will see the higher term number and step down as a follower.

### Discovering higher terms

Any time a node sees a message with a **higher term** than its own, it **immediately becomes a follower**:

```ruby
def become_follower(term)
  old_state = state

  self.current_term = term if term > current_term
  self.state = NodeState::FOLLOWER
  self.voted_for = nil  # Clear vote for new term

  # Stop heartbeat timer if we were leader
  stop_heartbeat_timer if old_state == NodeState::LEADER

  # Reset election timer
  reset_election_timer

  logger.info "Became follower (term #{current_term})"
end
```

This ensures that there's **only one leader per term** and that nodes with stale information quickly get back in sync.

## Putting it all together

Let's see our implementation in action! We'll run three nodes and watch them elect a leader.

First, let's add two helper methods to our RaftNode class for setting up the cluster:

```ruby
def configure_cluster(node_ids_and_ports)
  # Initialize cluster with predefined nodes and their ports
  # node_ids_and_ports is a hash like { 'node1' => 8001, 'node2' => 8002, 'node3' => 8003 }

  # Create remote node connections
  node_ids_and_ports.each do |node_id, node_port|
    next if node_id == id # Skip self

    remote_nodes[node_id] = RemoteNode.new(node_id, node_port)
    logger.info "Configured remote node: #{node_id} at port #{node_port}"
  end

  logger.info "Cluster configured with #{remote_nodes.size} remote nodes"
end

def start_rpc_server
  # Start DRb server for this node
  DRb.start_service("druby://localhost:#{port}", self)
  self.drb_server = DRb.thread

  logger.info "DRb server started on port #{port}"
end

def stop_rpc_server
  DRb.stop_service if DRb.primary_server
  logger.info 'DRb server stopped'
end
```

Now we can create a script that runs a Raft node:

```ruby
#!/usr/bin/env ruby

DEFAULT_CLUSTER = {
  'node1' => 8001,
  'node2' => 8002,
  'node3' => 8003
}.freeze

# Create and configure the node
node = Raft::RaftNode.new(node_id, port)
node.configure_cluster(DEFAULT_CLUSTER)
node.start_rpc_server

# Keep the node running
begin
  DRb.thread.join
rescue Interrupt
  puts "\nShutting down node #{node_id}..."
  node.stop_rpc_server
  exit 0
end
```

Start each node in a separate terminal:

```bash
# Terminal 1
ruby demo/start_node.rb node1

# Terminal 2  
ruby demo/start_node.rb node2

# Terminal 3
ruby demo/start_node.rb node3
```

When you start the nodes, you'll see output like:

```plaintext
=== Starting Raft Node ===
Node ID: node1
Port: 8001
==========================
Node node1 initialized as follower
DRb server started on druby://localhost:8001
Node node1 started successfully!

12:34:15 - Node node1: follower (term 0)
[INFO] Election timeout - starting election
[INFO] Became candidate (term 1)
[INFO] Starting election for term 1
[INFO] Need 2 votes, got 1 (self)
[INFO] Received vote from node2 (2/2)
[INFO] Won election with 2 votes!
[INFO] Became leader (term 1)
12:34:25 - Node node1: leader (term 1)
[INFO] Sending heartbeats to followers
```

Meanwhile, on `node2` and `node3`, you'll see them receiving vote requests and heartbeats:

```plaintext
# Node 2 output
[INFO] Received RequestVote(candidate: node1, term: 1)
[INFO] Granted vote to node1
[INFO] Received Heartbeat(leader: node1, term: 1)
[INFO] Became follower (term 1)
12:34:25 - Node node2: follower (term 1)
```

You can see that `node2` and `node3` become followers, and `node1` becomes the leader and starts sending heartbeats to them.

You can also play around by stopping the leader and watching a new election occur:

```plaintext
# After stopping node1 (the leader)
# Node 2 output
[INFO] Election timeout - starting election
[INFO] Became candidate (term 2)
[INFO] Starting election for term 2
[INFO] Received vote from node3 (2/2)
[INFO] Won election with 2 votes!
[INFO] Became leader (term 2)
```

Woohoo! This wasn't too hard, was it?

## What's next?

We've successfully implemented leader election, but a leader without followers isn't very useful. [In the next post](/implementing-raft-part-3), we'll implement log replication to make all nodes maintain an identical copy of the system's state even when things go wrong.

Stay tuned for Part 3, where we'll make our cluster actually do something useful!
