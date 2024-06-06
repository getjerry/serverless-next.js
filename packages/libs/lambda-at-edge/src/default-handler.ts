// @ts-ignore
import PrerenderManifest from "./prerender-manifest.json";
// @ts-ignore
import ImagesManifest from "./images-manifest.json";
// @ts-ignore
import Manifest from "./manifest.json";
// @ts-ignore
import RoutesManifestJson from "./routes-manifest.json";
import lambdaAtEdgeCompat from "@getjerry/next-aws-cloudfront";

import queryString from "query-string";
import cheerio from "cheerio";

import {
  CloudFrontOrigin,
  CloudFrontRequest,
  CloudFrontResultResponse,
  CloudFrontS3Origin,
  Context
} from "aws-lambda";

import { CloudFrontClient } from "@aws-sdk/client-cloudfront/CloudFrontClient";
import { LambdaClient } from "@aws-sdk/client-lambda/LambdaClient";
import { PutObjectCommand } from "@aws-sdk/client-s3/commands/PutObjectCommand";
import { GetObjectCommand } from "@aws-sdk/client-s3/commands/GetObjectCommand";

import { S3Client } from "@aws-sdk/client-s3/S3Client";

import { InvokeCommand } from "@aws-sdk/client-lambda";

import {
  OriginRequestDefaultHandlerManifest,
  OriginRequestEvent,
  OriginResponseEvent,
  PerfLogger,
  PreRenderedManifest as PrerenderManifestType,
  RevalidationEvent,
  RoutesManifest
} from "../types";
import { performance } from "perf_hooks";
import { ServerResponse } from "http";
import type { Readable } from "stream";
import { isEmpty, isNil, each, last } from "lodash";
import { CloudFrontHeaders } from "aws-lambda/common/cloudfront";
import zlib from "zlib";

import { createNotFoundResponse, isNotFoundPage } from "./routing/notfound";
import {
  createRedirectResponse,
  getDomainRedirectPath,
  getRedirectPath
} from "./routing/redirector";
import {
  createExternalRewriteResponse,
  getRewritePath,
  isExternalRewrite
} from "./routing/rewriter";
import {
  addHeadersToResponse,
  addS3HeadersToResponse
} from "./headers/addHeaders";
import {
  isValidPreviewRequest,
  setJerryAuth
} from "./lib/PreviewRequestHelper";
import { getUnauthenticatedResponse } from "./auth/authenticator";
import { buildS3RetryStrategy } from "./s3/s3RetryStrategy";
import { createETag } from "./lib/etag";
import { ResourceService } from "./services/resource.service";
import { CloudFrontService } from "./services/cloudfront.service";
import { S3Service } from "./services/s3.service";
import { RevalidateHandler } from "./handler/revalidate.handler";
import { RenderService } from "./services/render.service";
import { debug, getEnvironment, isDevMode } from "./lib/console";
import { PERMANENT_STATIC_PAGES_DIR } from "./lib/permanentStaticPages";
import { checkABTestUrl } from "./lib/pathToRegexStr";
import * as Sentry from "@sentry/node";
import "@sentry/tracing";

import {
  getSentryScopeWithExtraData,
  jerry_sentry_dsn,
  sentry_flush_timeout
} from "./lib/sentry";
import { renderPageToHtml } from "./services/utils/render.util";
import {
  SERVER_NO_CACHE_CACHE_CONTROL_HEADER,
  SWR_CACHE_CONTROL_HEADER
} from "../../constants";

process.env.PRERENDER = "true";
process.env.DEBUGMODE = Manifest.enableDebugMode;

interface FoundFallbackInterface {
  routeRegex: string;
  fallback: string | false | null;
  dataRoute: string;
  dataRouteRegex: string;
}

const resourceService = new ResourceService(
  Manifest,
  PrerenderManifest,
  RoutesManifestJson
);

const basePath = RoutesManifestJson.basePath;

const perfLogger = (logLambdaExecutionTimes: boolean): PerfLogger => {
  if (logLambdaExecutionTimes) {
    return {
      now: () => performance.now(),
      log: (metricDescription: string, t1?: number, t2?: number): void => {
        if (!t1 || !t2) return;
        console.log(`${metricDescription}: ${t2 - t1} (ms)`);
      }
    };
  }
  return {
    now: () => 0,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    log: () => {}
  };
};

const addS3HostHeader = (
  req: CloudFrontRequest,
  s3DomainName: string
): void => {
  req.headers["host"] = [{ key: "host", value: s3DomainName }];
};

const isDataRequest = (uri: string): boolean => uri.startsWith("/_next/data");

const normaliseUri = (uri: string, isS3Response = false): string => {
  let normalizedUri = uri;
  // Remove first characters when
  // 1. not s3 response
  // 2. has basepath property
  // 3. uri starts with basepath
  if (!isS3Response && basePath && uri.startsWith(basePath)) {
    normalizedUri = uri.slice(basePath.length);
  }

  // html file fetched from S3 will have a .html suffix,
  //  this will match nothing in manifest
  normalizedUri = normalizedUri.replace(/.html$/, "");
  // Normalise to "/" for index data request
  normalizedUri = ["/index", ""].includes(normalizedUri) ? "/" : normalizedUri;

  // Remove trailing slash for all paths
  if (normalizedUri.endsWith("/")) {
    normalizedUri = normalizedUri.slice(0, -1);
  }

  // Empty path should be normalised to "/" as there is no Next.js route for ""
  return normalizedUri === "" ? "/" : normalizedUri;
};

const normaliseS3OriginDomain = (s3Origin: CloudFrontS3Origin): string => {
  if (s3Origin.region === "us-east-1") {
    return s3Origin.domainName;
  }

  if (!s3Origin.domainName.includes(s3Origin.region)) {
    const regionalEndpoint = s3Origin.domainName.replace(
      "s3.amazonaws.com",
      `s3.${s3Origin.region}.amazonaws.com`
    );
    return regionalEndpoint;
  }

  return s3Origin.domainName;
};

const normaliseDataRequestUri = (
  uri: string,
  manifest: OriginRequestDefaultHandlerManifest
): string => {
  let normalisedUri = uri
    .replace(`/_next/data/${manifest.buildId}`, "")
    .replace(".json", "");

  // Normalise to "/" for index data request
  normalisedUri = ["/index", ""].includes(normalisedUri) ? "/" : normalisedUri;

  return normalisedUri;
};

const router = (
  manifest: OriginRequestDefaultHandlerManifest
): ((uri: string) => string) => {
  const {
    pages: { ssr, html }
  } = manifest;

  const allDynamicRoutes = { ...ssr.dynamic, ...html.dynamic };

  return (uri: string): string => {
    debug(`[router] uri: ${uri}`);

    let normalisedUri = uri;

    if (isDataRequest(uri)) {
      normalisedUri = normaliseDataRequestUri(normalisedUri, manifest);
    }

    if (ssr.nonDynamic[normalisedUri]) {
      // log in prod
      console.log(
        `[router] ssr.nonDynamic matched, uri: ${uri}\n- normalisedUri: ${normalisedUri}\n- result:${ssr.nonDynamic[normalisedUri]}`
      );
      return ssr.nonDynamic[normalisedUri];
    }

    if (html.nonDynamic[normalisedUri]) {
      // log in prod
      console.log(
        `[router] html.nonDynamic matched, uri: ${uri}\n- normalisedUri: ${normalisedUri}\n- result:${html.nonDynamic[normalisedUri]}`
      );
      return html.nonDynamic[normalisedUri];
    }

    for (const route in allDynamicRoutes) {
      const { file, regex } = allDynamicRoutes[route];

      const re = new RegExp(regex, "i");
      const pathMatchesRoute = re.test(normalisedUri);

      if (pathMatchesRoute) {
        // log in prod
        console.log(
          `[router] dynamic matched, uri: ${uri}\n- normalisedUri: ${normalisedUri}\n- matched regex: ${re}\n- result:${file}`
        );
        return file;
      }
    }

    // only use the 404 page if the project exports it
    if (html.nonDynamic["/404"] !== undefined) {
      return "pages/404.html";
    }

    return "pages/_error.js";
  };
};

/**
 * Whether the uri belongs to the url in the abTests field in the manifest
 */
const isAbTestPath = (
  manifest: OriginRequestDefaultHandlerManifest,
  uri: string
) => {
  const abTestPaths = manifest.abTests?.reduce((acc, cur) => {
    acc.push(cur.originUrl, ...cur.experimentGroups.map((_) => _.url));
    return acc;
  }, [] as string[]);

  const ret =
    abTestPaths && abTestPaths.some((_) => uri.split(".html")[0].endsWith(_));

  debug(`[isAbTestPath]: ${uri}; ${ret}; ${JSON.stringify(manifest)}`);

  return ret;
};

/**
 * Stale revalidate
 */
interface RevalidationInterface {
  [key: string]: Date;
}

interface RouteConfig {
  initialRevalidateSeconds: number | false;
}

// find first revalidation interval and use it globally.
// if not exists, then will be undefined and may be used to detect if revalidation should be turned on
const REVALIDATION_CONFIG = Object.values<RouteConfig>(
  PrerenderManifest.routes
).find((r) => typeof r.initialRevalidateSeconds === "number");

const REVALIDATE_IN = isDevMode()
  ? 1
  : REVALIDATION_CONFIG?.initialRevalidateSeconds || 4;

const REVALIDATIONS: RevalidationInterface = {};

const isStale = (key: string, revalidateIn = REVALIDATE_IN) => {
  debug(`[isStale] revalidateIn: ${revalidateIn}`);

  if (!revalidateIn) {
    return false;
  }

  debug(`[isStale] Now: ${new Date()}`);
  debug(`[isStale] REVALIDATIONS[key] before set: ${REVALIDATIONS[key]}`);

  if (!REVALIDATIONS[key]) {
    setStaleIn(key, revalidateIn);
    return true;
  }

  debug(`[isStale] REVALIDATIONS[key] after set: ${REVALIDATIONS[key]}`);

  debug(
    `[isStale] REVALIDATIONS[key] < new Date(): ${
      REVALIDATIONS[key] < new Date()
    }`
  );

  return REVALIDATIONS[key] < new Date();
};

const setStaleIn = (key: string, seconds: number): void => {
  const revalidateAt = new Date();
  revalidateAt.setSeconds(revalidateAt.getSeconds() + seconds);
  REVALIDATIONS[key] = revalidateAt;
};

const runRevalidation = async (
  event: RevalidationEvent,
  context: Context
): Promise<void> => {
  const edgeFunctionName = context.functionName.split(".").pop();
  const nonEdgeFunctionName = `${edgeFunctionName}-isr`;
  const enc = new TextEncoder();
  const params = {
    FunctionName: nonEdgeFunctionName,
    InvocationType: "Event",
    Payload: enc.encode(JSON.stringify(event))
  };
  debug(`[revalidation] invoke: ${JSON.stringify(params)}`);
  const lambda = new LambdaClient({ region: "us-west-2" });
  const response = await lambda.send(new InvokeCommand(params));
  debug(`[revalidation] invoked, response:${JSON.stringify(response)}`);
  return;
};

const handleRevalidation = async ({
  event,
  manifest,
  prerenderManifest,
  context
}: {
  event: OriginResponseEvent;
  manifest: OriginRequestDefaultHandlerManifest;
  prerenderManifest: PrerenderManifestType;
  context: Context;
}): Promise<void> => {
  debug("[revalidation-function] Processing revalidation...");
  debug(`[revalidation-function] event: ${JSON.stringify(event)}`);
  // const response = event.Records[0].cf.response;
  const request = event.Records[0].cf.request;
  const uri = normaliseUri(request.uri);
  const canonicalUrl = decodeURI(uri)
    .replace(`${basePath}`, "")
    .replace(`/_next/data/`, "")
    .replace(`${manifest.buildId}/`, "")
    .replace(".json", "")
    .replace(".html", "");

  const htmlKey = `${(basePath || "").replace(/^\//, "")}${
    !basePath ? "" : "/"
  }static-pages/${manifest.buildId}/${decodeURI(canonicalUrl)}.html`;
  const jsonKey = `${(basePath || "").replace(/^\//, "")}${
    !basePath ? "" : "/"
  }_next/data/${manifest.buildId}/${decodeURI(canonicalUrl)}.json`;

  // get heads from s3
  const { domainName, region } = request.origin!.s3!;
  const bucketName = domainName.replace(`.s3.${region}.amazonaws.com`, "");

  debug(`[revalidation-function] normalized uri: ${uri}`);
  debug(`[revalidation-function] canonical key: ${canonicalUrl}`);
  debug(`[revalidation-function] html key: ${htmlKey}`);
  debug(`[revalidation-function] json key: ${jsonKey}`);
  debug(`[revalidation-function] bucket name: ${bucketName}`);

  const s3 = new S3Client({
    // region,
    maxAttempts: 3,
    retryStrategy: await buildS3RetryStrategy()
  });

  const { HeadObjectCommand } = await import(
    "@aws-sdk/client-s3/commands/HeadObjectCommand"
  );
  const getStream = await import("get-stream");

  const htmlHead = await s3.send(
    new HeadObjectCommand({
      Bucket: bucketName,
      Key: htmlKey
    })
  );

  const jsonHead = await s3.send(
    new HeadObjectCommand({
      Bucket: bucketName,
      Key: jsonKey
    })
  );

  debug(`[revalidation-function] html head resp: ${htmlHead}`);
  debug(`[revalidation-function] json head resp: ${jsonHead}`);

  // const bodyString = await getStream.default(Body as Readable);

  // render page

  // calculate etags

  const etag = createETag().update("test").digest();

  debug(`[revalidation-function] etag: ${etag}`);
  // assert both or none etags differ

  // if etags differ:

  // -- put updated files to s3

  // -- invalidate html and json path
  return;
};

export const handler = async (
  event: OriginRequestEvent | OriginResponseEvent | RevalidationEvent,
  context: Context
): Promise<CloudFrontResultResponse | CloudFrontRequest | void> => {
  const manifest: OriginRequestDefaultHandlerManifest = Manifest;
  let response!: CloudFrontResultResponse | CloudFrontRequest;
  const prerenderManifest: PrerenderManifestType = PrerenderManifest;
  const routesManifest: RoutesManifest = RoutesManifestJson;

  const { now, log } = perfLogger(manifest.logLambdaExecutionTimes);

  const tHandlerBegin = now();

  if (process.env.NODE_ENV !== "development") {
    // https://github.com/serverless-nextjs/serverless-next.js/issues/484#issuecomment-673152792
    // eslint-disable-next-line no-eval
    eval('process.env.NODE_ENV="production"');
  }
  debug(`[handler] node_env: ${process.env.NODE_ENV}`);

  if (!process.env.__NEXT_IMAGE_OPTS) {
    // eslint-disable-next-line no-eval
    eval(
      `process.env.__NEXT_IMAGE_OPTS = ${JSON.stringify({
        path: ImagesManifest.path
      })}`
    );
  }

  const requestUri = event.Records[0].cf.request.uri;
  // Permanent Static Pages
  if (manifest.permanentStaticPages) {
    const uri = requestUri === "/" ? "/index.html" : `${requestUri}.html`;
    if (manifest.permanentStaticPages.includes(uri)) {
      debug(
        `[permanentStaticPages] permanentStaticPages: ${manifest.permanentStaticPages}`
      );
      debug(
        `[permanentStaticPages] requestUri = ${requestUri}, uri = ${uri}, is match`
      );
      return await generatePermanentPageResponse(
        uri,
        manifest,
        event,
        routesManifest
      );
    }
  }

  if (event.revalidate) {
    const { domainName, region } = event.Records[0].cf.request.origin!.s3!;
    const bucketName = domainName.replace(`.s3.${region}.amazonaws.com`, "");

    const renderService = new RenderService(event);
    const s3Service = new S3Service(
      new S3Client({
        region,
        maxAttempts: 3,
        retryStrategy: await buildS3RetryStrategy()
      }),
      { bucketName, domainName, region }
    );
    const cloudfrontService = new CloudFrontService(new CloudFrontClient({}), {
      distributionId: manifest.distributionId
    });

    const handler = new RevalidateHandler(
      resourceService,
      renderService,
      s3Service,
      cloudfrontService
    );
    const isAbTest = isAbTestPath(manifest, requestUri);
    await handler.run(
      event,
      context,
      manifest,
      isAbTest ? SERVER_NO_CACHE_CACHE_CONTROL_HEADER : undefined
    );
    return;
  }

  // if enable sentry
  if (manifest.sentry) {
    debug(
      `[Sentry] start track sentry. config: ${JSON.stringify(manifest.sentry)}`
    );

    Sentry.init({
      dsn: manifest.sentry.dsn || jerry_sentry_dsn,
      tracesSampleRate: manifest.sentry.tracesSampleRate,
      environment: getEnvironment(manifest)
    });
    const transaction = Sentry.startTransaction({
      op: "serverless-next-handler-request",
      name: "Serverless-next Transaction"
    });
    try {
      response = await getResponseFromEvent(
        context,
        manifest,
        event,
        prerenderManifest,
        routesManifest
      );
    } catch (e) {
      debug(
        `[Sentry] find exception ${JSON.stringify(
          e
        )}, need send to sentry website.`
      );
      Sentry.captureException(e, (scope) =>
        getSentryScopeWithExtraData(
          scope,
          routesManifest,
          event,
          context,
          manifest
        )
      );
      await Sentry.flush(sentry_flush_timeout);
    } finally {
      transaction.finish();
    }
  } else {
    response = await getResponseFromEvent(
      context,
      manifest,
      event,
      prerenderManifest,
      routesManifest
    );
  }

  // Add custom headers to responses only.
  // TODO: for paths that hit S3 origin, it will match on the rewritten URI, i.e it may be rewritten to S3 key.
  if (response.hasOwnProperty("status")) {
    const request = event.Records[0].cf.request;

    addHeadersToResponse(
      request.uri,
      response as CloudFrontResultResponse,
      routesManifest
    );
  }

  const tHandlerEnd = now();

  log("handler execution time", tHandlerBegin, tHandlerEnd);

  debug(`[origin] final response: ${JSON.stringify(response)}`);

  return response;
};

const handleOriginRequest = async ({
  event,
  manifest,
  prerenderManifest,
  routesManifest
}: {
  event: OriginRequestEvent;
  manifest: OriginRequestDefaultHandlerManifest;
  prerenderManifest: PrerenderManifestType;
  routesManifest: RoutesManifest;
  context?: Context;
}) => {
  const request = event.Records[0].cf.request;
  // Handle basic auth
  const authorization = request.headers.authorization;
  const unauthResponse = getUnauthenticatedResponse(
    authorization ? authorization[0].value : null,
    manifest.authentication
  );
  if (unauthResponse) {
    return unauthResponse;
  }

  // Handle domain redirects e.g www to non-www domain
  const domainRedirect = getDomainRedirectPath(request, manifest);
  if (domainRedirect) {
    return createRedirectResponse(
      domainRedirect,
      queryString.parse(request.querystring),
      308
    );
  }

  const basePath = routesManifest.basePath;
  let uri = normaliseUri(request.uri);
  const decodedUri = decodeURI(uri);
  const { pages, publicFiles, canonicalHostname } = manifest;

  const isPublicFile = publicFiles[decodedUri];
  const isDataReq = isDataRequest(uri);

  // Handle redirects
  // TODO: refactor redirect logic to another file since this is getting quite large

  const hostHeader = request.headers.host[0]?.value || "";

  if (
    canonicalHostname &&
    hostHeader &&
    !isDataReq &&
    !isPublicFile &&
    hostHeader !== canonicalHostname
  ) {
    return createRedirectResponse(
      `https://${canonicalHostname}${request.uri}`,
      queryString.parse(request.querystring),
      301
    );
  }

  // Handle any trailing slash redirects
  let newUri = request.uri;
  if (isDataReq || isPublicFile) {
    // Data requests and public files with trailing slash URL always get redirected to non-trailing slash URL
    if (newUri.endsWith("/")) {
      newUri = newUri.slice(0, -1);
    }
  } else if (request.uri !== "/" && request.uri !== "" && uri !== "/404") {
    // HTML/SSR pages get redirected based on trailingSlash in next.config.js
    // We do not redirect:
    // 1. Unnormalised URI is "/" or "" as this could cause a redirect loop due to browsers appending trailing slash
    // 2. "/404" pages due to basePath normalisation
    const trailingSlash = manifest.trailingSlash;

    if (!trailingSlash && newUri.endsWith("/")) {
      newUri = newUri.slice(0, -1);
    }

    if (trailingSlash && !newUri.endsWith("/")) {
      newUri += "/";
    }
  }

  if (newUri !== request.uri) {
    return createRedirectResponse(
      newUri,
      queryString.parse(request.querystring),
      308
    );
  }

  // Handle other custom redirects on the original URI
  const customRedirect = getRedirectPath(
    request.uri,
    queryString.parse(request.querystring),
    routesManifest
  );
  if (customRedirect) {
    return createRedirectResponse(
      customRedirect.redirectPath,
      queryString.parse(request.querystring),
      customRedirect.statusCode
    );
  }

  // Check for non-dynamic pages before rewriting
  const isNonDynamicRoute =
    pages.html.nonDynamic[uri] || pages.ssr.nonDynamic[uri] || isPublicFile;

  let rewrittenUri;
  // Handle custom rewrites, but don't rewrite non-dynamic pages, public files or data requests per Next.js docs: https://nextjs.org/docs/api-reference/next.config.js/rewrites
  if (!isDataReq) {
    const customRewrite = getRewritePath({
      path: request.uri,
      queryParams: queryString.parse(request.querystring),
      routesManifest,
      router: router(manifest),
      normalisedPath: uri,
      cloudFrontHeaders: request.headers
    });
    if (customRewrite) {
      if (isExternalRewrite(customRewrite)) {
        const { req, res, responsePromise } = lambdaAtEdgeCompat(
          event.Records[0].cf,
          {
            enableHTTPCompression: manifest.enableHTTPCompression
          }
        );
        await createExternalRewriteResponse(customRewrite, req, res);
        return await responsePromise;
      }

      rewrittenUri = request.uri;
      const [customRewriteUriPath, customRewriteUriQuery] =
        customRewrite.split("?");
      request.uri = customRewriteUriPath;
      if (request.querystring) {
        request.querystring = `${request.querystring}${
          customRewriteUriQuery ? `&${customRewriteUriQuery}` : ""
        }`;
      } else {
        request.querystring = `${customRewriteUriQuery ?? ""}`;
      }

      uri = normaliseUri(request.uri);
    }
  }

  const isStaticPage = pages.html.nonDynamic[uri]; // plain page without any props
  const isPrerenderedPage = prerenderManifest.routes[decodedUri]; // prerendered pages are also static pages like "pages.html" above, but are defined in the prerender-manifest
  const origin = request.origin as CloudFrontOrigin;
  const s3Origin = origin.s3 as CloudFrontS3Origin;
  const isHTMLPage = isStaticPage || isPrerenderedPage;
  const normalisedS3DomainName = normaliseS3OriginDomain(s3Origin);
  const hasFallback = hasFallbackForUri(uri, prerenderManifest, manifest);
  const { now, log } = perfLogger(manifest.logLambdaExecutionTimes);
  const isPreviewRequest = isValidPreviewRequest(
    request.headers.cookie,
    prerenderManifest.preview.previewModeSigningKey
  );

  s3Origin.domainName = normalisedS3DomainName;

  S3Check: if (
    // Note: public files and static pages (HTML pages with no props) don't have JS files needed for preview mode, always serve from S3.
    isPublicFile ||
    isStaticPage ||
    (isHTMLPage && !isPreviewRequest) ||
    (hasFallback && !isPreviewRequest) ||
    (isDataReq && !isPreviewRequest)
  ) {
    if (isPublicFile) {
      s3Origin.path = `${basePath}/public`;
      if (basePath) {
        request.uri = request.uri.replace(basePath, "");
      }
    } else if (isHTMLPage || hasFallback) {
      s3Origin.path = `${basePath}/static-pages/${manifest.buildId}`;
      const pageName = uri === "/" ? "/index" : uri;
      request.uri = `${pageName}.html`;
      checkABTestUrl(manifest, request);
    } else if (isDataReq) {
      // We need to check whether data request is unmatched i.e routed to 404.html or _error.js
      const normalisedDataRequestUri = normaliseDataRequestUri(uri, manifest);
      const pagePath = router(manifest)(normalisedDataRequestUri);
      debug(`[origin-request] is json, uri: ${request.uri}`);
      if (pagePath === "pages/404.html") {
        // Request static 404 page from s3
        s3Origin.path = `${basePath}/static-pages/${manifest.buildId}`;
        request.uri = pagePath.replace("pages", "");
        debug(`[origin-request] is 404, uri: ${request.uri}`);
      } else if (
        pagePath === "pages/_error.js" ||
        (!prerenderManifest.routes[normalisedDataRequestUri] &&
          !hasFallbackForUri(
            normalisedDataRequestUri,
            prerenderManifest,
            manifest
          ))
      ) {
        // Break to continue to SSR render in two cases:
        // 1. URI routes to _error.js
        // 2. URI is not unmatched, but it's not in prerendered routes nor is for an SSG fallback, i.e this is an SSR data request, we need to SSR render the JSON
        break S3Check;
      }

      // Otherwise, this is an SSG data request, so continue to get to try to get the JSON from S3.
      // For fallback SSG, this will fail the first time but the origin response handler will render and store in S3.
    }

    addS3HostHeader(request, normalisedS3DomainName);
    return request;
  }

  const pagePath = router(manifest)(uri);

  debug(
    `[origin-request] [ssr] start ssr for uri: uri: ${request.uri}, pagePath: ${pagePath}`
  );

  if (pagePath.endsWith(".html") && !isPreviewRequest) {
    s3Origin.path = `${basePath}/static-pages/${manifest.buildId}`;
    request.uri = pagePath.replace("pages", "");
    addS3HostHeader(request, normalisedS3DomainName);

    debug(`[origin-request] [ssr] html response: ${JSON.stringify(request)}`);

    return request;
  }

  const tBeforePageRequire = now();
  let page = require(`./${pagePath}`); // eslint-disable-line
  const tAfterPageRequire = now();

  log("require JS execution time", tBeforePageRequire, tAfterPageRequire);

  const tBeforeSSR = now();
  const { req, res, responsePromise } = lambdaAtEdgeCompat(
    event.Records[0].cf,
    {
      enableHTTPCompression: manifest.enableHTTPCompression,
      rewrittenUri
    }
  );

  // Preview data is not usable in preview api:
  // Token bypass can not be used due to Next preview data size limit
  // https://github.com/vercel/next.js/issues/19685
  // So we set auth token to preview data before SSR.
  if (isPreviewRequest) {
    setJerryAuth(
      request,
      req,
      prerenderManifest.preview.previewModeSigningKey,
      prerenderManifest.preview.previewModeEncryptionKey
    );
  }

  try {
    // If page is _error.js, set status to 404 so _error.js will render a 404 page
    if (pagePath === "pages/_error.js") {
      res.statusCode = 404;
    }

    // Render page
    if (isDataReq) {
      const { renderOpts } = await renderPageToHtml(
        page,
        req,
        res,
        "passthrough"
      );

      res.setHeader("Content-Type", "application/json");

      debug(`[origin-request] [ssr] json response: ${JSON.stringify(res)}`);

      res.end(JSON.stringify(renderOpts.pageData));
    } else {
      await Promise.race([page.render(req, res), responsePromise]);
    }
  } catch (error) {
    // Set status to 500 so _error.js will render a 500 page
    console.error(
      `Error rendering page: ${pagePath}. Error:\n${error}\nRendering Next.js error page.`
    );
    res.statusCode = 500;
    page = require("./pages/_error.js"); // eslint-disable-line
    await page.render(req, res);
  }
  const response = await responsePromise;
  const tAfterSSR = now();

  log("SSR execution time", tBeforeSSR, tAfterSSR);

  setCloudFrontResponseStatus(response, res);

  // We want data to be real time when previewing.
  if (isPreviewRequest) {
    setCacheControlToNoCache(response);
  }

  return response;
};

const handleOriginResponse = async ({
  event,
  manifest,
  prerenderManifest,
  context
}: {
  event: OriginResponseEvent;
  manifest: OriginRequestDefaultHandlerManifest;
  prerenderManifest: PrerenderManifestType;
  context: Context;
}) => {
  const response = event.Records[0].cf.response;
  const request = event.Records[0].cf.request;

  debug(`[origin-request]: ${JSON.stringify(request)}`);

  const { status } = response;
  const isRequestForHtml = request.uri.endsWith(".html");
  const uri = normaliseUri(request.uri, true);
  const isNonDynamic = isNonDynamicResource(uri, manifest);
  const hasFallback = hasFallbackForUri(uri, prerenderManifest, manifest);
  const isHTMLPage = prerenderManifest.routes[decodeURI(uri)];
  const isPublicFile = manifest.publicFiles[decodeURI(uri)];
  const isEnforceRevalidationRequest = request.querystring === "enforceISR";
  // if isEnforceRevalidationRequest is true, revalidation will start anyway.

  // 0. For PUT or DELETE just return the response as these should be unsupported S3 methods
  if (request.method === "PUT" || request.method === "DELETE") {
    return response;
  }

  // 1. Got html response from S3, response and invoke revalidation
  if (status !== "403") {
    debug(`[origin-response] bypass: ${request.uri}`);

    // Set 404 status code for 404.html page. We do not need normalised URI as it will always be "/404.html"
    if (request.uri === "/404.html") {
      response.status = "404";
      response.statusDescription = "Not Found";
    } else {
      const revalidationKey = decodeURI(uri)
        .replace(`_next/data/`, "")
        .replace(`${manifest.buildId}/`, "")
        .replace(".json", "")
        .replace(".html", "");

      debug(`[origin-response] revalidationKey: ${revalidationKey}`);
      debug(`[origin-response] isData: ${isDataRequest(uri)}`);
      debug(`[origin-response] isHtml: ${isHTMLPage}`);
      debug(`[origin-response] isFallback: ${hasFallback}`);

      if (
        isEnforceRevalidationRequest ||
        // if REVALIDATION_CONFIG is undefined revalidation is off
        (REVALIDATION_CONFIG &&
          (isHTMLPage || hasFallback || isDataRequest(uri)) &&
          !isPublicFile &&
          isStale(revalidationKey))
      ) {
        await runRevalidation({ ...event, revalidate: true }, context);
        setStaleIn(revalidationKey, REVALIDATE_IN);
      }
    }

    return response;
  }

  // 2.0 No html response from S3, check fallback configuration
  const { domainName, region } = request.origin!.s3!;
  const bucketName = domainName.replace(`.s3.${region}.amazonaws.com`, "");
  const pagePath = router(manifest)(uri);

  const s3 = new S3Client({
    region,
    maxAttempts: 3,
    retryStrategy: await buildS3RetryStrategy()
  });

  debug(`[origin-response] has fallback: ${JSON.stringify(hasFallback)}`);
  debug(`[origin-response] pagePath: ${pagePath}`);
  debug(`[origin-response] uri: ${uri}`);
  debug(`[origin-response] isDataRequest: ${isDataRequest(uri)}`);

  // 2.1 blocking flow pages has 'blocking' fallback settings
  const isBlockingFallBack =
    hasFallback &&
    hasFallback.fallback === null &&
    isRequestForHtml &&
    !isDataRequest(uri);

  if (
    isBlockingFallBack ||
    // consider a non-dynamic page without pre-generated resource as need blocking fallback.
    //  they don't have blocking configurations,
    //  so if it is not pre-generated or be deleted,
    //  they will never get regenerate again.
    isNonDynamic
  ) {
    // eslint-disable-next-line
    const page = require(`./${pagePath}`);

    const htmlUri = uri === "/" ? "/index.html" : `${uri}.html`;
    const jsonPath = `${(basePath || "").replace(/^\//, "")}${
      basePath === "" ? "" : "/"
    }_next/data/${manifest.buildId}${decodeURI(htmlUri).replace(
      ".html",
      ".json"
    )}`;

    const { req, res } = lambdaAtEdgeCompat(event.Records[0].cf, {
      enableHTTPCompression: manifest.enableHTTPCompression,
      rewrittenUri: `/${jsonPath}`
    });

    const isSSG = !!page.getStaticProps;

    const renderedRes = await renderPageToHtml(page, req, res, "passthrough");

    debug(`[blocking-fallback] rendered res: ${JSON.stringify(renderedRes)}`);

    const { renderOpts, html: renderedHtml } = renderedRes;

    const html = rocketHtml(renderedHtml);

    debug(
      `[blocking-fallback] rendered page, uri: ${htmlUri}, ${
        request.uri
      } pagePath: ${pagePath}, opts: ${JSON.stringify(
        renderOpts
      )}, html: ${html}`
    );

    // Check if it is a `not Found` response. Return 404 in that case.
    if (isNotFoundPage(manifest, html, renderOpts)) {
      debug(`[blocking-fallback] 'not found' response received. Sending 404.`);
      return createNotFoundResponse(
        response,
        basePath,
        manifest,
        s3,
        bucketName
      );
    }

    const pageProps = renderOpts?.pageData?.pageProps;

    if (pageProps.__N_REDIRECT) {
      const redirectResp = createRedirectResponse(
        pageProps.__N_REDIRECT,
        // in Next source code,
        //  page returned redirect will redirect to __N_REDIRECT with out query string
        // explicit set query string to empty to align with this behavior.
        {},
        pageProps.__N_REDIRECT_STATUS
      );

      const location = redirectResp?.headers?.location[0].value || "";

      // Hack around 'read only' header changed error from aws.
      response.headers["location"] = [
        {
          key: "Location",
          value: location
        }
      ];

      return {
        ...redirectResp,
        headers: response.headers
      };
    }

    if (isSSG) {
      const s3JsonParams = {
        Bucket: bucketName,
        Key: jsonPath,
        Body: JSON.stringify(renderOpts.pageData),
        ContentType: "application/json",
        CacheControl: SWR_CACHE_CONTROL_HEADER
      };
      const s3HtmlParams = {
        Bucket: bucketName,
        Key: `${(basePath || "").replace(/^\//, "")}${
          basePath === "" ? "" : "/"
        }static-pages/${manifest.buildId}${decodeURI(htmlUri)}`,
        Body: html,
        ContentType: "text/html",
        CacheControl: isAbTestPath(manifest, htmlUri)
          ? SERVER_NO_CACHE_CACHE_CONTROL_HEADER
          : SWR_CACHE_CONTROL_HEADER
      };

      debug(`[blocking-fallback] json to s3: ${JSON.stringify(s3JsonParams)}`);
      debug(`[blocking-fallback] html to s3: ${JSON.stringify(s3HtmlParams)}`);
      await Promise.all([
        s3.send(new PutObjectCommand(s3JsonParams)),
        s3.send(new PutObjectCommand(s3HtmlParams))
      ]);
    }

    const htmlOut = {
      status: "200",
      statusDescription: "OK",
      headers: {
        ...response.headers,
        "content-type": [
          {
            key: "Content-Type",
            value: "text/html"
          }
        ],
        "cache-control": [
          {
            key: "Cache-Control",
            value: isAbTestPath(manifest, uri)
              ? SERVER_NO_CACHE_CACHE_CONTROL_HEADER
              : SWR_CACHE_CONTROL_HEADER
          }
        ]
      },
      body: html
    };
    debug(
      `[blocking-fallback] responded with html: ${JSON.stringify(htmlOut)}`
    );
    return compressOutput({ manifest, request, output: htmlOut });
  }

  // 2.2 handle data request
  if (isDataRequest(uri) && !pagePath.endsWith(".html")) {
    // eslint-disable-next-line
    const page = require(`./${pagePath}`);

    const { req, res, responsePromise } = lambdaAtEdgeCompat(
      event.Records[0].cf,
      {
        enableHTTPCompression: manifest.enableHTTPCompression
      }
    );

    const isSSG = !!page.getStaticProps;
    const { renderOpts, html } = await renderPageToHtml(
      page,
      req,
      res,
      "passthrough"
    );

    debug(
      `[origin-response] rendered page, uri: ${uri}, pagePath: ${pagePath}, opts: ${JSON.stringify(
        renderOpts
      )}, html: ${JSON.stringify(html)}`
    );

    const shouldPersist =
      isSSG &&
      // should redirect, json data no need to persist,
      // and more IMPORTANT, 'html' will be a json string instead of html string in this case
      !renderOpts?.pageData?.pageProps?.__N_REDIRECT &&
      // empty html should not be persist
      !isEmpty(html);

    if (shouldPersist) {
      const s3JsonParams = {
        Bucket: bucketName,
        Key: `${(basePath || "").replace(/^\//, "")}${
          basePath === "" ? "" : "/"
        }${decodeURI(uri.replace(/^\//, ""))}`,
        Body: JSON.stringify(renderOpts.pageData),
        ContentType: "application/json",
        CacheControl: SWR_CACHE_CONTROL_HEADER
      };
      const s3HtmlParams = {
        Bucket: bucketName,
        Key: `${(basePath || "").replace(/^\//, "")}${
          basePath === "" ? "" : "/"
        }static-pages/${manifest.buildId}/${decodeURI(normaliseUri(request.uri))
          .replace(`/_next/data/`, "")
          .replace(`${manifest.buildId}/`, "")
          .replace(".json", ".html")}`,
        Body: html,
        ContentType: "text/html",
        CacheControl: SWR_CACHE_CONTROL_HEADER
      };

      debug(region);
      debug(bucketName);
      debug(JSON.stringify(s3HtmlParams));
      debug(JSON.stringify(s3JsonParams));

      // const { PutObjectCommand } = await import(
      //   "@aws-sdk/client-s3/commands/PutObjectCommand"
      // );
      await Promise.all([
        s3.send(new PutObjectCommand(s3JsonParams)),
        s3.send(new PutObjectCommand(s3HtmlParams))
      ]);
      debug(`[origin-response] created json: ${JSON.stringify(s3JsonParams)}`);
      debug(`[origin-response] created html: ${JSON.stringify(s3HtmlParams)}`);
    }
    res.writeHead(200, response.headers as any);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(renderOpts.pageData));
    const jsonOut = await responsePromise;
    debug(`[origin-response] responded with json: ${JSON.stringify(jsonOut)}`);
    return jsonOut;
  }
  // 2.3 handle non-blocking fallback
  else {
    if (!hasFallback) {
      debug(`[origin-response] fallback bypass: ${JSON.stringify(response)}`);
      return response;
    }

    // If route has fallback, return that page from S3, otherwise return 404 page
    const s3Key = `${(basePath || "").replace(/^\//, "")}${
      basePath === "" ? "" : "/"
    }static-pages/${manifest.buildId}${hasFallback.fallback || "/404.html"}`;

    debug(`[origin-response] has fallback: ${JSON.stringify(hasFallback)}`);

    // const { GetObjectCommand } = await import(
    //   "@aws-sdk/client-s3/commands/GetObjectCommand"
    // );
    // S3 Body is stream per: https://github.com/aws/aws-sdk-js-v3/issues/1096
    const getStream = await import("get-stream");

    const s3Params = {
      Bucket: bucketName,
      Key: s3Key
    };

    const { Body, CacheControl } = await s3.send(
      new GetObjectCommand(s3Params)
    );
    const bodyString = await getStream.default(Body as Readable);

    const out = {
      status: hasFallback.fallback ? "200" : "404",
      statusDescription: hasFallback.fallback ? "OK" : "Not Found",
      headers: {
        ...response.headers,
        "content-type": [
          {
            key: "Content-Type",
            value: "text/html"
          }
        ],
        "cache-control": [
          {
            key: "Cache-Control",
            value:
              CacheControl ??
              (hasFallback.fallback // Use cache-control from S3 response if possible, otherwise use defaults
                ? SERVER_NO_CACHE_CACHE_CONTROL_HEADER // fallback should never be cached
                : SWR_CACHE_CONTROL_HEADER)
          }
        ]
      },
      body: bodyString
    };
    debug(`[origin-response] fallback response: ${JSON.stringify(out)}`);
    return out;
  }
};

const rocketHtml = (html: string): string => {
  const $ = cheerio.load(html);

  const $scripts = $("script");

  each($scripts, (script) => {
    const $script = $(script);
    // bypass nomodule
    if ($script.attr("nomodule")) {
      $script.attr("jerry-rocket-checked", "nomodule");
      return;
    }

    if ($script.attr("type") === "") {
      $script.attr("jerry-rocket-checked", "nomodule");
      return;
    }

    const type = $script.attr("type");
    // bypass json
    if (type === "application/ld+json" || type === "application/json") {
      return;
    }
    if (type) {
      $script.attr("data-rocket-type", type);
      $script.removeAttr("type");
    }

    // transform src
    const src = $script.attr("src");
    if (src) {
      $script.attr("data-rocket-src", src);
      $script.removeAttr("src");
    }

    $script.attr("type", "rocketlazyloadscript");
  });

  // add rocket script
  const $head = $("head");
  const rocketScript =
    '<script type="text/javascript" src="/_next/static/rocket.js" defer="" ></script>';
  $head.append(rocketScript);

  return $.html();
};

const isOriginResponse = (
  event: OriginRequestEvent | OriginResponseEvent
): event is OriginResponseEvent => {
  return event.Records[0].cf.config.eventType === "origin-response";
};

const isNonDynamicResource = (
  uri: string,
  manifest: OriginRequestDefaultHandlerManifest
) => {
  const {
    pages: { ssr, html }
  } = manifest;
  return ssr.nonDynamic[uri] || html.nonDynamic[uri];
};

const hasFallbackForUri = (
  uri: string,
  prerenderManifest: PrerenderManifestType,
  manifest: OriginRequestDefaultHandlerManifest
) => {
  const {
    pages: { ssr, html }
  } = manifest;
  // Non-dynamic routes are prioritized over dynamic fallbacks, return false to ensure those get rendered instead
  if (ssr.nonDynamic[uri] || html.nonDynamic[uri]) {
    return false;
  }

  let foundFallback: FoundFallbackInterface | undefined = undefined; // for later use to reduce duplicate work

  // Dynamic routes that does not have fallback are prioritized over dynamic fallback
  const isNonFallbackDynamicRoute = Object.values({
    ...ssr.dynamic,
    ...html.dynamic
  }).find((dynamicRoute) => {
    if (foundFallback) {
      return false;
    }

    const re = new RegExp(dynamicRoute.regex);
    const matchesRegex = re.test(uri);

    // If any dynamic route matches, check that this isn't one of the fallback routes in prerender manifest
    if (matchesRegex) {
      const matchesFallbackRoute = Object.keys(
        prerenderManifest.dynamicRoutes
      ).find((prerenderManifestRoute) => {
        const fileMatchesPrerenderRoute =
          dynamicRoute.file === `pages${prerenderManifestRoute}.js`;

        if (fileMatchesPrerenderRoute) {
          foundFallback =
            prerenderManifest.dynamicRoutes[prerenderManifestRoute];
        }

        return fileMatchesPrerenderRoute;
      });

      return !matchesFallbackRoute;
    } else {
      return false;
    }
  });

  if (isNonFallbackDynamicRoute) {
    return false;
  }

  // If fallback previously found, return it to prevent additional regex matching
  if (foundFallback) {
    return foundFallback;
  }

  // Otherwise, try to match fallback against dynamic routes in prerender manifest
  return Object.values(prerenderManifest.dynamicRoutes).find((routeConfig) => {
    const re = new RegExp(routeConfig.routeRegex);
    return re.test(uri);
  });
};

const getSupportedCompression = (headers: CloudFrontHeaders) => {
  let gz: "gzip" | "br" | false = false;
  const ae = headers["accept-encoding"];
  debug(`[checking accept encoding] accept encodings: ${JSON.stringify(ae)}`);
  if (ae) {
    for (let i = 0; i < ae.length; i++) {
      const { value } = ae[i];
      const bits = value.split(",").map((x) => x.split(";")[0].trim());

      if (bits.indexOf("gzip") !== -1) {
        gz = "gzip";
      }

      if (bits.indexOf("br") !== -1) {
        gz = "br";
      }
    }
  }
  return gz;
};

const compressOutput = ({
  manifest,
  request,
  output
}: {
  manifest: OriginRequestDefaultHandlerManifest;
  request: CloudFrontRequest;
  output: CloudFrontResultResponse;
}): CloudFrontResultResponse => {
  if (isNil(output.body)) return output;

  const useCompression =
    manifest.enableHTTPCompression && getSupportedCompression(request.headers);

  debug(
    `[compressOutput] enableHTTPCompression: ${manifest.enableHTTPCompression}`
  );
  debug(`[compressOutput] use compression: ${useCompression}`);

  debug(
    `[compressOutput] text length before compression and encoding: ${output.body.length}`
  );

  let body;
  let encoding;
  switch (useCompression) {
    case "br":
      body = zlib
        .brotliCompressSync(output.body, {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 }
        })
        .toString("base64");
      encoding = "br";
      break;
    case "gzip":
      body = zlib.gzipSync(output.body).toString("base64");
      encoding = "gzip";
      break;
    default:
      body = Buffer.from(output.body).toString("base64");
  }

  const result = {
    ...output,
    bodyEncoding: "base64" as const,
    body
  };
  if (useCompression) {
    if (isNil(result.headers)) {
      result.headers = {
        ["content-encoding"]: [
          { key: "Content-Encoding", value: encoding as string }
        ]
      };
    }
    result.headers["content-encoding"] = [
      { key: "Content-Encoding", value: encoding as string }
    ];
  }

  debug(
    `[compressOutput] text length after compression and encoding: ${result.body.length}`
  );
  return result;
};

// This sets CloudFront response for 404 or 500 statuses
const setCloudFrontResponseStatus = (
  response: CloudFrontResultResponse,
  res: ServerResponse
): void => {
  if (res.statusCode == 404) {
    response.status = "404";
    response.statusDescription = "Not Found";
  } else if (res.statusCode == 500) {
    response.status = "500";
    response.statusDescription = "Internal Server Error";
  }
};

// This sets CloudFront response with strict no-cache.
const setCacheControlToNoCache = (response: CloudFrontResultResponse): void => {
  response.headers = {
    ...response.headers,
    "cache-control": [
      {
        key: "Cache-Control",
        value: SERVER_NO_CACHE_CACHE_CONTROL_HEADER
      }
    ]
  };
};

// generate Permanent Page Response and add headers
export const generatePermanentPageResponse = async (
  uri: string,
  manifest: OriginRequestDefaultHandlerManifest,
  event: OriginRequestEvent | OriginResponseEvent | RevalidationEvent,
  routesManifest: RoutesManifest
) => {
  const { domainName, region } = event.Records[0].cf.request.origin!.s3!;
  const bucketName = domainName.replace(`.s3.${region}.amazonaws.com`, "");
  const s3 = new S3Client({
    region,
    maxAttempts: 3,
    retryStrategy: await buildS3RetryStrategy()
  });
  debug(
    `[generatePermanentPageResponse] manifest: ${manifest.permanentStaticPages}.`
  );
  debug(`[generatePermanentPageResponse] uri: ${uri}`);

  //get page from S3
  const s3Key = `${(basePath || "").replace(/^\//, "")}${
    basePath === "" ? "" : "/"
  }static-pages/${manifest.buildId}${PERMANENT_STATIC_PAGES_DIR}${uri}`;

  const getStream = await import("get-stream");

  const s3Params = {
    Bucket: bucketName,
    Key: s3Key
  };
  debug(
    `[generatePermanentPageResponse] s3Params: ${JSON.stringify(s3Params)}`
  );

  const { Body, $metadata } = await s3.send(new GetObjectCommand(s3Params));
  const bodyString = await getStream.default(Body as Readable);

  debug(
    `[generatePermanentPageResponse] $metadata: ${JSON.stringify($metadata)}`
  );
  const s3Headers = addS3HeadersToResponse($metadata.httpHeaders);

  const out = {
    status: "200",
    statusDescription: "OK",
    headers: {
      ...s3Headers,
      "content-type": [
        {
          key: "Content-Type",
          value: "text/html"
        }
      ],
      "cache-control": [
        {
          key: "Cache-Control",
          value: SWR_CACHE_CONTROL_HEADER
        }
      ]
    },
    body: bodyString
  };

  addHeadersToResponse(uri, out as CloudFrontResultResponse, routesManifest);

  debug(`[generatePermanentPageResponse]: ${JSON.stringify(out.headers)}`);
  debug(`[generatePermanentPageResponse]: ${JSON.stringify(out.body)}`);
  return out;
};

export const getResponseFromEvent = async (
  context: Context,
  manifest: OriginRequestDefaultHandlerManifest,
  event: OriginRequestEvent | OriginResponseEvent | RevalidationEvent,
  prerenderManifest: PrerenderManifestType,
  routesManifest: RoutesManifest
) => {
  if (isOriginResponse(event)) {
    debug(
      `[handle-origin-response] [getResponseFromEvent] event: ${JSON.stringify(
        event
      )}`
    );
    return await handleOriginResponse({
      event,
      manifest,
      prerenderManifest,
      context
    });
  } else {
    debug(
      `[handle-origin-request] [getResponseFromEvent] event: ${JSON.stringify(
        event
      )}`
    );
    return await handleOriginRequest({
      event,
      manifest,
      prerenderManifest,
      routesManifest,
      context
    });
  }
};
