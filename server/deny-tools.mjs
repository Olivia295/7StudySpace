// Static, audited PreToolUse hook. It never reads the hook input or any file.
// User prompts cannot change this decision. Codex owns launching this hook.
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'STUDY77_TEXT_ONLY: all local tool calls are denied for this learning worker.',
  },
}));
