## Ask Jev from an app

Jev (TypeSafe) is a decision model: it answers typed questions about some
text with a probability for each allowed answer, and writes no text. It is
reached only through the AI Gateway `jev-test`, which holds Jev's key, logs
each call and holds the spend limits. Call it exactly as below; every other
address fails.

### The one address

```
POST https://api.cloudflare.com/client/v4/accounts/<accountId>/ai/run
Authorization: Bearer <Cloudflare API token>
cf-aig-gateway-id: jev-test
cf-aig-metadata: {"service":"<app slug>"}
content-type: application/json

{ "model": "typesafe/jev", "input": { "state": { ... }, "questions": { ... } } }
```

- `cf-aig-gateway-id` is required. Without it the call lands on the
  account's `default` gateway, which has no Jev key, and answers
  `402 Insufficient balance`. That 402 says nothing about Jev's balance.
- `cf-aig-metadata` names the app so the gateway's per-service spend limit
  counts it. Over a spend limit the gateway answers 429 until the window has
  room.
- Gateway-host addresses such as `gateway.ai.cloudflare.com/v1/.../workers-ai/typesafe/jev`
  and `/ai/run/typesafe/jev` do not route to Jev. Do not try them.
- The token is a Cloudflare API token with Workers AI Read and AI Gateway
  Run on that account. The person creates it and enters it in the
  connection form; never ask for it in chat.

### The account

Declare Jev as an optional app account, so the app's tools stay visible and
work unscored before anyone links it ([accounts.md](accounts.md#two-accounts-and-multiple-tools)):

```ts
import { defineProvider, object, plain, secrets, string } from "apps";

export const jev = defineProvider({
  name: "Cloudflare AI Gateway (Jev)",
  hosts: ["api.cloudflare.com"],
  auth: {
    apiToken: secrets({
      label: "Cloudflare API token",
      fields: object({
        accountId: plain(string({ minLength: 32 })),
        gatewayId: plain(string({ minLength: 1 })),
        token: string({ minLength: 1 }),
      }),
    }),
  },
});

const requirements = { app: { accounts: { jev: jev.many() } } };
```

The person fills `accountId` with the Cloudflare account ID, `gatewayId`
with `jev-test` and `token` with the API token. Copy the provider exactly:
its name, label and fields decide its provider ID, and an account linked
to one app fits another app only when the definitions match.

### The call

A successful call answers with Jev's answer one level down, inside the
Cloudflare envelope:

```json
{
  "result": {
    "state": "Completed",
    "result": {
      "model": "jev-1.13.0",
      "answers": { "q": { "type": "noul", "noul": 0.51 } },
      "usage": {}
    }
  },
  "success": true,
  "errors": [],
  "messages": []
}
```

Questions are keyed by an ID you choose. Each is `noul` (a probability that
the instructions hold), `choice` (one key of `criteria`) or `score` (an
index into the ordered `criteria` list):

```ts
type JevAccount = { fields: { accountId: string; gatewayId: string; token: string } };

const JEV_VERSION = "jev-1.13.0";

async function askJev(
  fetch: typeof globalThis.fetch,
  account: JevAccount,
  state: unknown,
  questions: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account.fields.accountId}/ai/run`,
    {
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: {
        Authorization: `Bearer ${account.fields.token}`,
        "content-type": "application/json",
        "cf-aig-gateway-id": account.fields.gatewayId,
        "cf-aig-metadata": JSON.stringify({ service: "my-app" }),
      },
      body: JSON.stringify({ model: "typesafe/jev", input: { state, questions } }),
    },
  );
  if (!response.ok)
    throw new Error(`Jev answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = (await response.json()) as {
    result?: { result?: { model?: string; answers?: Record<string, unknown> } };
  };
  const answer = body.result?.result;
  if (answer?.model !== JEV_VERSION) return null;
  return answer.answers ?? null;
}
```

Call it from a handler with the first linked account, and keep working
without it:

```ts
const account = ctx.app.accounts.jev[0];
const answers = account
  ? await askJev(
      ctx.fetch,
      account,
      { title, summary },
      {
        relevance: {
          type: "score",
          instructions: "Rate how much this matters to ...",
          criteria: ["None", "Minor", "Major"],
        },
      },
      ctx.signal,
    )
  : null;
const score = (answers?.relevance as { score?: number } | undefined)?.score;
```

Every answer carries its question's `type`. A `score` answer is
`{ score, probabilities, confidence }`, where `score` is a weighted index
such as `1.83`, not a whole number; a `choice` answer is
`{ choice, probabilities, confidence }`; a `noul` answer is `{ noul }`. Check each answer against its question before using it, and
treat no answer as "not judged": a judgment may warn, rank or sort, never
open a gate or replace a person's approval. Answers from a version other
than the one you checked are not used, as the Trifecta services do.

### Connect it

Request the connection link only when the person is ready to create the
token and fill the form, and tell them the three values first. The link
lasts thirty minutes ([accounts.md](accounts.md#oauth-sign-in)). After the
person finishes, call one tool that asks Jev and check it returned an answer.
