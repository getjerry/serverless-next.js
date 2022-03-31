import { pathToRegexp } from "path-to-regexp";
import { debug } from "./console";
import { OriginRequestDefaultHandlerManifest } from "../../types";
import { CloudFrontRequest } from "aws-lambda";

// @ts-ignore
import * as _ from "./lodash";

const SLUG_PARAM_KEY = "slug";

const INJECT_PARAM_REGEX = RegExp("\\[[A-Za-z0-9]*]", "g");

export default (path: string): string =>
  pathToRegexp(path)
    .toString()
    .replace(/\/(.*)\/\i/, "$1");

type param = {
  key: string;
  value: string;
};

const getParamsFormQuery = (querystring: string, uri: string): param[] => {
  if (_.isEmpty(querystring)) {
    return [];
  }

  const result = querystring.split("&").map((s) => {
    return { key: s.split("=")[0], value: s.split("=")[1] };
  });

  const slug = _.last(uri.split("/"));
  if (!_.isEmpty(slug)) {
    result.push({ key: SLUG_PARAM_KEY, value: slug });
  }
  return result;
};

const isMatch = (
  originUrl: string,
  requestUrl: string,
  querystring: string
): boolean => {
  console.log(originUrl, requestUrl, querystring);
  const regex = convertOriginUrlToRegex(originUrl);
  return regex.test(`${requestUrl}?${querystring}`);
};

const convertOriginUrlToRegex = (originUrl: string): RegExp => {
  return new RegExp(
    `${originUrl
      .replace(INJECT_PARAM_REGEX, "[0-9a-zA-Z-]*")
      .replace(/\//gi, "\\/")
      .replace(/\?/gi, "\\?")}$`
  );
};

const rewriteUrlWithParams = (
  rewriteUrl: string,
  requestUrl: string,
  querystring: string
): string => {
  const params = getParamsFormQuery(requestUrl, querystring);
  let result = rewriteUrl;
  params.forEach((p) => {
    result = result.replace(`[${p.key}]`, `${p.value}`);
    console.log(result);
  });
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
  if (_.isEmpty(request.querystring)) {
    return;
  }

  debug(`[checkAndRewriteUrl] manifest: ${JSON.stringify(manifest)}`);
  const rewrites = manifest.urlRewrites;
  debug(`[checkAndRewriteUrl] rewriteList: ${JSON.stringify(rewrites)}`);
  if (!rewrites || rewrites.length === 0) return;

  const requestUri = request.uri.split(".")[0];

  rewrites.forEach(({ originUrl, rewriteUrl }) => {
    debug(`[originUrl]: ${originUrl}, rewriteUrl: ${rewriteUrl}`);

    if (isMatch(originUrl, requestUri, request.querystring)) {
      request.uri = rewriteUrlWithParams(
        rewriteUrl,
        requestUri,
        request.querystring
      );
      request.querystring = "";
    }
  });

  debug(`[checkAndRewriteUrl] After: ${request.uri}, ${request.querystring}`);
};
