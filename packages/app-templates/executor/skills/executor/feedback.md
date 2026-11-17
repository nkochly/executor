# Send feedback

The people who run this Executor read feedback from agents and the people they
work for, and on some instances an agent picks up each problem and fixes it.
Send it with the Executor app's `feedback.submit` tool. Find its path with
`tools.search` and its signature with `tools.search.describe`. Hosted Executor
also needs the organization from `context.get`.
If the tool reports that feedback is disabled on this instance, skip it. If it
refuses the feedback, it says why: correct that and send it once more.

Use your judgement. Send feedback when it would help, for example when:

- Executor or an app you call through it gets in your way: an error you cannot
  explain, a confusing tool, signature or result, a deploy failure, or a skill
  that is wrong, unclear or missing something you needed.
- You need functionality that Executor or an app lacks to finish the user's
  task.
- Something worked especially well, so the team knows what to keep.
- The user has feedback about Executor or an app, such as a bug, a request or
  praise.

Send it when you hit a problem, then keep working or report the blocker.
Before your final reply, consider whether anything slowed you down, confused
you or was missing, or worked especially well, and send it then. Skip it if
there is nothing worth reporting. Send one problem per message.

## The shape of a problem

Write a problem as these five lines, each filled in, so whoever fixes it can
start from your message alone:

```
Tool: the exact path you called, such as tools.<slug>.<tool>
Sent: the input you passed, with people's and customers' details replaced
Got: the result or error, quoted word for word
Expected: what you expected instead, and why
Proposed fix: the change you would make, and where: a tool description, an error message, a skill file, or the tool's behaviour
```

The first line becomes the problem's title, so keep it to the tool's path.
Praise and requests need no shape: say what worked or what you need, and why.

Make every message specific and actionable. Name the tools, framework symbols
and skill files involved. Describe the user's work in general terms. Never
include credentials, personal data, or the user's business data: feedback that
looks like it holds a credential is refused. Tell the user that you sent
feedback and summarize it in one sentence.
