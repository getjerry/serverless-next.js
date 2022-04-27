// for https://sentry.ing.getjerry.com/organizations/sentry/projects/serverless-next/?project=56
import { Scope, TransactionContext } from "@sentry/types";
import {
  OriginRequestDefaultHandlerManifest,
  OriginRequestEvent,
  OriginResponseEvent,
  RevalidationEvent,
  RoutesManifest
} from "../../types";
import { Context } from "aws-lambda";

export const jerry_sentry_dsn =
  "https://7a4e4d068fa544c5aa9f90ea5317b392@sentry.ing.getjerry.com/56";

export const sentry_flush_timeout = 2000;

export const getSentryContext = (
  event: OriginRequestEvent | OriginResponseEvent | RevalidationEvent,
  context: Context,
  manifest: OriginRequestDefaultHandlerManifest
): TransactionContext => {
  return {
    op: "serverless-next-handler-request",
    name: "Serverless-next Transaction",
    data: {
      event: JSON.stringify(event),
      context: JSON.stringify(context),
      manifest: JSON.stringify(manifest)
    }
  };
};

// add more custom tags here
export const getSentryScopeWithCustomTags = (
  scope: Scope,
  routesManifest: RoutesManifest
): Scope => {
  scope.clear();
  scope.setTag("app", routesManifest.basePath);
  return scope;
};
