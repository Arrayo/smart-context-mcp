# Agent Rules: smart_summary

## When to use smart_summary

Use `smart_summary` to maintain conversation continuity across sessions without token bloat.

### Mandatory usage points:

1. **Start of every conversation**: Call `smart_summary({ action: "get" })` to check for existing context
2. **After completing milestones**: Call `smart_summary({ action: "append", update: {...} })` to track progress
3. **Before ending work**: Ensure latest state is saved with current `nextStep`
4. **When resuming work**: Always call `smart_summary({ action: "get" })` first

### Workflow pattern:

```
Turn 1: smart_summary(get) → smart_context(task) → implement → smart_summary(append)
Turn 2: smart_summary(get) → continue from nextStep → implement → smart_summary(append)
...
After weekend: smart_summary(get) → full context restored → continue
```

## What to track

### Always include:
- **goal**: Primary objective (never changes unless pivoting)
- **status**: `planning` | `in_progress` | `blocked` | `completed`
- **nextStep**: Immediate next action (critical for resume)
- **pinnedContext**: 1-3 critical constraints or decisions that must survive compression
- **currentFocus**: Current active area in a short phrase
- **touchedFiles**: Files modified in this session

### Include when relevant:
- **completed**: Steps finished (append incrementally)
- **decisions**: Key architectural/technical decisions with brief rationale
- **blockers**: Current blockers preventing progress
- **unresolvedQuestions**: Open questions that should be answered next
- **whyBlocked**: One-line blocker summary when `status` is `blocked`

### Do NOT track:
- Implementation details (code snippets, function names)
- Obvious steps ("read file", "write code")
- Temporary debugging info
- Full file paths if already in touchedFiles

## Examples

### Good usage:

```javascript
// After implementing auth
smart_summary({ 
  action: "append",
  update: {
    pinnedContext: ["JWT access token stays at 1h unless product asks otherwise"],
    unresolvedQuestions: ["Do refresh tokens need device scoping?"],
    currentFocus: "RBAC middleware",
    completed: ["JWT middleware", "login endpoint"],
    decisions: ["1h access token + 7d refresh", "bcrypt rounds=12"],
    touchedFiles: ["src/auth/middleware.js", "src/routes/auth.js"],
    nextStep: "add role-based access control"
  }
})
```

### Bad usage:

```javascript
// Too verbose, includes implementation details
smart_summary({ 
  action: "append",
  update: {
    completed: [
      "Read src/auth/middleware.js",
      "Wrote function verifyToken()",
      "Added import for jsonwebtoken",
      "Fixed linting errors"
    ],
    decisions: [
      "Used arrow function instead of function declaration",
      "Put middleware in separate file"
    ]
  }
})
```

## Session management

- **Single feature/task**: Use one session, append incrementally
- **Multiple parallel features**: Create separate sessions with descriptive `sessionId`
- **Switching contexts**: Call `list_sessions` to see available sessions, then `get` with specific `sessionId`
- **Completed work**: Keep session for reference, or `reset` to start fresh

## Token budget

Default 500 tokens is sufficient for most sessions. Increase to 1000-2000 only for complex multi-week projects with many decisions.

Compression is automatic — the tool keeps the full session state, then derives a resume summary that preserves `status`, `nextStep`, and active blockers first.
