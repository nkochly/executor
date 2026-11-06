/**
 * An admin changes an app after it was created: the Source view edits a file in place, and saving
 * commits it and deploys that commit as a new version.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const original = `import { defineApp } from "apps";\nexport default defineApp({}, async () => ({}));`;
const Versions = Schema.Array(Schema.Struct({ id: Schema.String }));

layer(HostedLive, { excludeTestServices: true })("Source editing", (it) => {
  it.effect(scenarios.sourceEditing.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Editable ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: original }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const versions = Effect.gen(function* () {
          const response = yield* api.request(actors.owner, "GET", `${prefix}/${app.id}/versions`);
          return (yield* body(Versions, response)).length;
        });
        const before = yield* versions;
        yield* browser.login(actors.owner);
        yield* browser.use("Open working source", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=source`),
        );
        yield* browser.use("Edit index.ts", (page) =>
          page
            .getByRole("region", { name: "Source browser", exact: true })
            .getByRole("button", { name: "Edit", exact: true })
            .click(),
        );
        yield* browser.use("Change the file", (page) =>
          page
            .getByRole("textbox", { name: "Contents of index.ts", exact: true })
            .fill(`// Edited in the dashboard\n${original}`),
        );
        yield* browser.checkpoint("Editing a source file");
        yield* browser.use("Save and deploy", (page) =>
          page.getByRole("button", { name: "Save and deploy", exact: true }).click(),
        );
        yield* browser.use("The dialog closes once deployed", (page) =>
          page
            .getByRole("textbox", { name: "Contents of index.ts", exact: true })
            .waitFor({ state: "detached" }),
        );
        yield* browser.use("The working source shows the change", (page) =>
          page
            .getByRole("region", { name: "Source browser", exact: true })
            .getByText("// Edited in the dashboard")
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Saved and deployed");
        expect(yield* versions).toBe(before + 1);
      }),
    ),
  );
});
