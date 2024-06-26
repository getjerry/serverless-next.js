import { pathToRegexp } from "path-to-regexp";
import murmurhash from "murmurhash";
import { debug } from "./console";
import {
  ExperimentGroup,
  OriginRequestDefaultHandlerManifest
} from "../../types";
import { CloudFrontRequest } from "aws-lambda";

// @ts-ignore
import * as _ from "../lib/lodash";
import * as querystring from "querystring";
import { isNil, toNumber } from "lodash";

const SLUG_PARAM_KEY = "slug";

// regex for [make], [model] in origin url.
const INJECT_PARAM_REGEX = RegExp("\\[[A-Za-z0-9]*]", "g");

const parse = (querystring: string): any => {
  return querystring
    .substring(querystring.indexOf("?") + 1)
    .split("&")
    .reduce(
      (memo, param) => ({
        ...memo,
        [param.split("=")[0]]: param.split("=")[1]
      }),
      {}
    );
};

export default (path: string): string =>
  pathToRegexp(path)
    .toString()
    .replace(/\/(.*)\/\i/, "$1");

// convert the serverless url to a standard regex, we can use the regex to match the url
const isUriMatch = (originUrl: string, requestUrl: string): boolean => {
  const result = new RegExp(
    `^${originUrl
      .replace(INJECT_PARAM_REGEX, "[0-9a-zA-Z-]*")
      .replace(/\//gi, "\\/")}$`
  ).test(requestUrl);

  debug(
    `[isUriMatch]:${result} with originUrl: ${originUrl}, requestUrl: ${requestUrl}`
  );
  return result;
};

const isParamsMatch = (
  originUrlParams: string | string[],
  querystring: string
): boolean => {
  const params = _.keys(parse(querystring));

  if (typeof originUrlParams === "string") {
    originUrlParams = [originUrlParams];
  }

  if (!_.isEmpty(originUrlParams) && _.isEmpty(params)) return false;

  const result = _.isEqual(params.sort(), originUrlParams.sort());

  debug(
    `[isParamsMatch]:${result} with originUrlParams: ${JSON.stringify(
      originUrlParams
    )}, querystring: ${querystring}`
  );
  return result;
};

// inject the params to rewrite url.
const rewriteUrlWithParams = (
  rewriteUrl: string,
  requestUrl: string,
  querystring: string
): string => {
  let result = rewriteUrl;

  _.forOwn(parse(querystring), function (value: string, key: string) {
    // '/' in param will be inject to url then generate invalid path,
    // like /some-path/should-be/-one-path
    const valueReplaceSlash = _.replace(value, /\//g, "%2F");
    result = _.replace(result, `[${key}]`, `${valueReplaceSlash}`);
  });

  result = result.replace(
    `[${SLUG_PARAM_KEY}]`,
    _.last(requestUrl.split("/")) || ""
  );

  return `${result}.html`;
};

/**
 * Calculate the appropriate A/B Test experiment url according to the experimentGroups field in the configuration
 * @param experimentGroups
 * @param request
 * @param originUrl
 */
const rewriteUrlWithExperimentGroups = (
  experimentGroups: ExperimentGroup[],
  request: CloudFrontRequest,
  originUrl: string
) => {
  // force to one group if query string match
  const queryParams = querystring.parse(request.querystring);
  debug(
    `[rewriteUrlWithExperimentGroups]: query params: ${JSON.stringify(
      queryParams
    )}`
  );
  const forceGroupIndex = queryParams.forceTestGroup;
  // force to origin
  if (forceGroupIndex === "original") {
    debug(`[rewriteUrlWithExperimentGroups]: force use original url.`);
    return `${originUrl}.html`;
  }

  if (!isNil(forceGroupIndex) && experimentGroups[toNumber(forceGroupIndex)]) {
    debug(
      `[rewriteUrlWithExperimentGroups]: force serve url: ${
        experimentGroups[toNumber(forceGroupIndex)].url
      }`
    );

    return `${experimentGroups[toNumber(forceGroupIndex)].url}.html`;
  }

  const clientIp = request.clientIp;

  // gen hash map: [{url: '/car-insurance/information', ratio: 25}] => [25 zeros]
  const hashMap = experimentGroups.reduce((acc, cur, index) => {
    acc = acc.concat(Array.from({ length: cur.ratio }, () => index));
    return acc;
  }, [] as number[]);

  const hashIndex = murmurhash.v2(clientIp) % 100;

  const hitExperimentGroup = experimentGroups[hashMap[hashIndex]];

  // if no hit, use origin url.
  let resultUrl = originUrl;
  // if the experiment group has states, we will check if the user region is in the states.
  if (hitExperimentGroup?.states) {
    const region =
      request.headers?.["cloudfront-viewer-country-region"]?.[0]?.value;
    if (!region) {
      resultUrl = originUrl;
    } else {
      debug(`[rewriteUrlWithExperimentGroups]: user region is ${region}`);
      resultUrl =
        hitExperimentGroup.states.findIndex((state) => state === region) >= 0
          ? hitExperimentGroup.url
          : originUrl;
    }
  } else if (hitExperimentGroup) {
    resultUrl = hitExperimentGroup.url;
  }

  debug(`[rewriteUrlWithExperimentGroups]: ${originUrl} -> ${resultUrl}}`);

  return `${resultUrl}.html`;
};

/**
 * Check and parse the abTests field
 * @param manifest
 * @param request
 */
export const checkABTestUrl = (
  manifest: OriginRequestDefaultHandlerManifest,
  request: CloudFrontRequest
): void => {
  debug(
    `[checkABTestUrl] before: ${JSON.stringify(manifest)}, ${JSON.stringify(
      request
    )}`
  );
  const abTests = manifest.abTests;
  if (!abTests || abTests.length === 0) return;

  const requestUri = request.uri.split(".")[0];

  for (const abTest of abTests) {
    debug(
      `[checkABTestUrl]: requestUri: ${requestUri}, check if in test: ${JSON.stringify(
        abTest
      )}`
    );
    const originUrl = abTest.originUrl;
    const experimentGroups = abTest.experimentGroups;

    if (isUriMatch(originUrl, requestUri)) {
      request.uri = rewriteUrlWithExperimentGroups(
        experimentGroups,
        request,
        originUrl
      );

      break;
    }
  }

  debug(`[checkABTestUrl] After: ${request.uri}`);
};
