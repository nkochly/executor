import { describe, expect, it } from "@effect/vitest";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import {
  connectionPattern,
  leavePendingConnect,
  PENDING_CONNECT_TTL_MS,
  takePendingConnect,
} from "./pending-connect";

describe("pending connect", () => {
  const onConnected = () => {};

  it("is taken once, by the integration it names", () => {
    leavePendingConnect({ integration: "muster", at: 1000, onConnected });
    expect(takePendingConnect("wiki", 1000)).toBeNull();
    expect(takePendingConnect("muster", 1000)?.integration).toBe("muster");
    expect(takePendingConnect("muster", 1000)).toBeNull();
  });

  it("expires", () => {
    leavePendingConnect({ integration: "muster", at: 1000, onConnected });
    expect(takePendingConnect("muster", 1000 + PENDING_CONNECT_TTL_MS + 1)).toBeNull();
  });

  it("turns on exactly the new connection", () => {
    expect(
      connectionPattern({
        owner: "org",
        integration: IntegrationSlug.make("muster"),
        name: "museTeam",
      }),
    ).toBe("muster.org.museTeam.*");
  });
});
