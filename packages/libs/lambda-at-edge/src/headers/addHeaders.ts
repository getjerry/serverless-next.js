import { CloudFrontResultResponse } from "aws-lambda";
import { RoutesManifest } from "../../types";
import { matchPath } from "../routing/matcher";
import { HeaderBag } from "@aws-sdk/types";

// @ts-ignore
import * as _ from "../lib/lodash";

export function addHeadersToResponse(
  path: string,
  response: CloudFrontResultResponse,
  routesManifest: RoutesManifest
): void {
  // Add custom headers to response
  if (response.headers) {
    for (const headerData of routesManifest.headers) {
      const match = matchPath(path, headerData.source);

      if (match) {
        for (const header of headerData.headers) {
          if (header.key && header.value) {
            const headerLowerCase = header.key.toLowerCase();
            response.headers[headerLowerCase] = [
              {
                key: headerLowerCase,
                value: header.value
              }
            ];
          }
        }
      }
    }
  }
}

export function addS3HeadersToResponse(s3Headers: HeaderBag | undefined) {
  if (!s3Headers) return {};
  const a: Record<string, [{ key: string; value: string }]> = {};

  for (const [key, value] of Object.entries(s3Headers)) {
    if (key && value) {
      if (key.startsWith("x-")) {
        a[key] = [
          {
            key: key,
            value: value
          }
        ];
      } else if (key === "etag") {
        a[key] = [
          {
            key: "ETag",
            value: value
          }
        ];
      } else {
        a[key] = [
          {
            key: _.startCase(key).replace(" ", "-"),
            value: value
          }
        ];
      }
    }
    return a;
  }
}
