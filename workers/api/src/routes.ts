/**
 * Route composition.
 *
 * One module per bounded context, plus the public surface. Order matters only
 * where patterns overlap: more specific paths are registered first.
 */

import type { RequestContext } from "./http/context.js";
import type { Router } from "./http/router.js";

import { registerAuthRoutes } from "./contexts/identity/auth-routes.js";
import { registerIdentityRoutes } from "./contexts/identity/routes.js";
import { registerEventConfigRoutes } from "./contexts/event-config/routes.js";
import { registerSponsorshipRoutes } from "./contexts/sponsorship/routes.js";
import { registerSubmissionRoutes } from "./contexts/submissions/routes.js";
import { registerReviewRoutes } from "./contexts/review/routes.js";
import { registerProgramRoutes } from "./contexts/program/routes.js";
import { registerOnboardingRoutes } from "./contexts/onboarding/routes.js";
import { registerSchedulingRoutes } from "./contexts/scheduling/routes.js";
import { registerContentRoutes } from "./contexts/content/routes.js";
import { registerPlatformRoutes } from "./contexts/platform/routes.js";
import { registerCrmRoutes } from "./contexts/crm/routes.js";
import { registerPublicRoutes } from "./surfaces/public.js";
import { registerHomeRoutes } from "./surfaces/home.js";
import { registerAdminHomeRoutes } from "./surfaces/admin-home.js";
import { registerDevRoutes } from "./surfaces/dev.js";

export function registerRoutes(router: Router<RequestContext>): void {
  registerAuthRoutes(router);
  registerHomeRoutes(router);
  registerAdminHomeRoutes(router);
  registerDevRoutes(router);

  registerEventConfigRoutes(router);
  registerIdentityRoutes(router);
  registerSponsorshipRoutes(router);
  registerSubmissionRoutes(router);
  registerReviewRoutes(router);
  registerProgramRoutes(router);
  registerOnboardingRoutes(router);
  registerSchedulingRoutes(router);
  registerContentRoutes(router);
  registerPlatformRoutes(router);
  registerCrmRoutes(router);

  // Public last: its patterns are the broadest (`/e/:slug/...`, `/embed/:key`).
  registerPublicRoutes(router);
}
