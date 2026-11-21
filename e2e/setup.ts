import { installScenarioLifecycle } from "./support/lifecycle.ts";
import { resolveLocalhostSubdomainsToLoopback } from "./support/localhost-names.ts";

resolveLocalhostSubdomainsToLoopback();
installScenarioLifecycle();
