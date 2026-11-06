import { createFileRoute } from "@tanstack/react-router";
import { BundlesPage, bundlesPageReads } from "@executor-js/hosted-web/pages/bundles";

/** Admin connection bundles shared by hosted products. */
export const Route = createFileRoute("/org/$organizationSlug/bundles")({
  component: BundlesPage,
  staticData: { organizationReads: bundlesPageReads },
});
