import { pathToRegexp } from "path-to-regexp";
import { debug } from "./console";
import { OriginRequestDefaultHandlerManifest } from "../../types";
import { CloudFrontRequest } from "aws-lambda";

// @ts-ignore
import * as _ from "./lodash";

export default (path: string): string =>
  pathToRegexp(path)
    .toString()
    .replace(/\/(.*)\/\i/, "$1");

type param = {
  key: string;
  value: string;
};

export const getParamsFormQuery = (
  querystring: string,
  uri: string
): param[] => {
  const result = querystring.split("&").map((s) => {
    return { key: s.split("=")[0], value: s.split("=")[1] };
  });

  const slug = _.last(uri.split("/"));
  if (!_.isEmpty(slug)) {
    result.push({ key: "slug", value: slug });
  }
  return result;
};

const isMatch = (
  params: param[],
  originUrl: string,
  requestUrl: string,
  querystring: string
): boolean => {
  debug(
    `[isOriginUrlMatch]: ${requestUrl}?${querystring} ${urlWithParams(
      originUrl,
      params
    )}`
  );
  return `${requestUrl}?${querystring}` === urlWithParams(originUrl, params);
};

const urlWithParams = (url: string, params: param[], split = "="): string => {
  let result = url;
  params.forEach((p) => {
    if (p.key === "slug") {
      result = result.replace("[slug]", `${p.value}`);
    } else {
      result = result.replace(
        new RegExp(`${p.key}${split}\\[.*]`),
        `${p.key}${split}${p.value}`
      );
    }
    debug(`[urlWithParams]: ${result}`);
  });

  return result;
};

/**
 * check if this url and query params need to rewrite. And rewrite it if get configuration form serverless.yml
 * Now, we can only support 1 url params, like rewrite /index.html?page=[number] to /page/[number].html
 * We can use querystring lib if we want to support more functions.
 *
 * For example,
 *     urlRewrites:
 *        - name: paginationRewrite
 *          originUrl: /index.html?page=[number]
 *          rewriteUrl: /page/[number].html
 *
 * @param manifest
 * @param request
 */
export const checkAndRewriteUrl = (
  manifest: OriginRequestDefaultHandlerManifest,
  request: CloudFrontRequest
): void => {
  debug(`[checkAndRewriteUrl] manifest: ${JSON.stringify(manifest)}`);
  const rewrites = manifest.urlRewrites;
  debug(`[checkAndRewriteUrl] rewriteList: ${JSON.stringify(rewrites)}`);
  if (!rewrites || rewrites.length === 0) return;

  const requestUri = request.uri.split(".")[0];
  const params = getParamsFormQuery(request.querystring, requestUri);

  debug(
    `[checkAndRewriteUrl] params: ${JSON.stringify(
      params
    )}，requestUri: ${requestUri}`
  );
  if (_.isEmpty(params) || !requestUri) return;

  rewrites.forEach(({ originUrl, rewriteUrl }) => {
    debug(`[originUrl: ${originUrl}, rewriteUrl: ${rewriteUrl}]`);

    if (isMatch(params, originUrl, requestUri, request.querystring)) {
      request.uri = urlWithParams(rewriteUrl, params, "/");
      request.querystring = "";
    }
  });

  debug(`[checkAndRewriteUrl] After: ${request.uri}, ${request.querystring}`);
};
