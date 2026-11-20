import { createFileRoute } from "@tanstack/react-router";
import { BundlesPage, bundlesPageReads } from "@executor-js/hosted-web/pages/bundles";

export const Route = createFileRoute("/org/$organizationSlug/bundles")({
  component: BundlesPage,
  staticData: { organizationReads: bundlesPageReads },
});
