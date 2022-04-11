import { pathToRegexp } from "path-to-regexp";
import { debug } from "./console";
import { OriginRequestDefaultHandlerManifest } from "../../types";
import { CloudFrontRequest } from "aws-lambda";

import { forOwn, isEmpty, isEqual, isString, keys, last } from "lodash";
import queryString from "query-string";

const SLUG_PARAM_KEY = "slug";

// regex for [make], [model] in origin url.
const INJECT_PARAM_REGEX = RegExp("\\[[A-Za-z0-9]*]", "g");

export default (path: string): string =>
  pathToRegexp(path)
    .toString()
    .replace(/\/(.*)\/\i/, "$1");

// convert the serverless url to a standard regex, we can use the regex to match the url
const isUriMatch = (originUrl: string, requestUrl: string): boolean => {
  return new RegExp(
    `^${originUrl
      .replace(INJECT_PARAM_REGEX, "[0-9a-zA-Z-]*")
      .replace(/\//gi, "\\/")}$`
  ).test(requestUrl);
};

const isParamsMatch = (
  originUrlParams: string[],
  querystring: string
): boolean => {
  const params = keys(queryString.parse(querystring));
  if (isEmpty(params)) return false;
  return isEqual(
    params,
    originUrlParams.sort((a, b) => a.localeCompare(b))
  );
};

// inject the params to rewrite url.
const rewriteUrlWithParams = (
  rewriteUrl: string,
  requestUrl: string,
  querystring: string
): string => {
  let result = rewriteUrl;

  forOwn(queryString.parse(querystring), function (value, key) {
    result = result.replace(`[${key}]`, `${value}`);
  });

  result = result.replace(
    `[${SLUG_PARAM_KEY}]`,
    last(requestUrl.split("/")) || ""
  );

  return `${result}.html`;
};

/**
 * check if this url and query params need to rewrite. And rewrite it if get configuration form serverless.yml
 * Now, we can only support 1 url params, like rewrite /index.html?page=[number] to /page/[number].html
 * We can use querystring lib if we want to support more functions.
 *
 * For example,
 *     urlRewrites:
 *        - name: paginationRewrite
 *          originUrl: /index.html?page=[page]
 *          rewriteUrl: /page/[page].html
 *
 *
 * updates:
 * now this function will support more url params and slug, such as:
 *       - originUrl: /car-repair/services/[slug]?make=[make]&model=[model]
 *         rewriteUrl: /car-repair/services/[slug]/make/[make]/model/[model]
 *
 * And if we want to use the url params, the name should be same to the key name, such as,
 *      /index.html?page=[number]    wrong.
 *      /index.html?page=[page]  correct.
 *
 * This is because when we get the url params, the query string is like "?make=123&model=123".
 * We can only get the pairs as { make: 123, model: 123 }. It will be more easy to insert params to
 * '?make=[make]&model=[model]' instead of '?make=[other-name]&model=[other-name]'
 *
 * @param manifest
 * @param request
 */
export const checkAndRewriteUrl = (
  manifest: OriginRequestDefaultHandlerManifest,
  request: CloudFrontRequest
): void => {
  if (isEmpty(request.querystring)) {
    return;
  }

  debug(`[checkAndRewriteUrl] manifest: ${JSON.stringify(manifest)}`);
  const rewrites = manifest.urlRewrites;
  debug(`[checkAndRewriteUrl] rewriteList: ${JSON.stringify(rewrites)}`);
  if (!rewrites || rewrites.length === 0) return;

  const requestUri = request.uri.split(".")[0];

  for (const rewrite of rewrites) {
    const originUrl = rewrite.originUrl;
    const rewriteUrl = rewrite.rewriteUrl;
    const originUrlParams = isString(rewrite.originUrlParams)
      ? [rewrite.originUrlParams]
      : rewrite.originUrlParams;
    debug(
      `[originUrl]: ${originUrl}, rewriteUrl: ${rewriteUrl}, originUrlParams:${JSON.stringify(
        originUrlParams
      )}`
    );

    if (
      isUriMatch(originUrl, requestUri) &&
      isParamsMatch(originUrlParams, request.querystring)
    ) {
      request.uri = rewriteUrlWithParams(
        rewriteUrl,
        requestUri,
        request.querystring
      );
      request.querystring = "";
      break;
    }
  }

  debug(`[checkAndRewriteUrl] After: ${request.uri}, ${request.querystring}`);
};
