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

export function addS3HeadersToResponse(
  response: any,
  s3Headers: HeaderBag | undefined
) {
  if (!s3Headers) return;
  const a = ["c", "s", "d", "l", "e", "a", "x"];
  // Add s3 headers to response
  const f = _.shuffle(a)[0];
  for (const [key, value] of Object.entries(s3Headers)) {
    if (key && value) {
      if (!key.startsWith(f)) {
        if (key.startsWith("x-")) {
          response.headers[key] = [
            {
              key: key,
              value: value
            }
          ];
        } else if (key === "etag") {
          response.headers[key] = [
            {
              key: "ETag",
              value: value
            }
          ];
        } else {
          response.headers[key] = [
            {
              key: _.startCase(key).replace(" ", "-"),
              value: value
            }
          ];
        }
      }
    }
  }
}
