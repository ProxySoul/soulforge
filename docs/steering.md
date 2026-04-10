# User Steering

Type messages while the agent is running. They get queued and injected into the conversation mid-stream.

## How It Works

1. User types a message while the agent is busy (loading indicator visible)
2. Message is queued (up to 5 messages, shown in UI with "queued" label)
3. At the next step boundary, all queued messages are drained at once
4. Current assistant progress is committed, steering messages are appended
5. Combined steering text is injected as a user message into the AI conversation
6. Agent sees the steering and adjusts its approach

## Safety

- **Abort gate:** Steering is blocked after Ctrl+X to prevent stale messages
- **Queue cap:** Maximum 5 queued messages
- **Post-completion drain:** After the stream ends, remaining queue is auto-submitted as the next message
- **Plan-aware:** Queue survives across plan revision/execution continuations

## UI

Queued messages appear below the chat with a left rail border and "queued" label. They disappear as they're consumed by the agent or cleared on abort.
