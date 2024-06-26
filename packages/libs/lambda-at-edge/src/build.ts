import { nodeFileTrace, NodeFileTraceReasons } from "@vercel/nft";
import execa from "execa";
import fse from "fs-extra";
import path, { join } from "path";
import getAllFiles from "./lib/getAllFilesInDirectory";
import { getSortedRoutes } from "./lib/sortedRoutes";
import {
  ABTest,
  OriginRequestApiHandlerManifest,
  OriginRequestDefaultHandlerManifest,
  OriginRequestImageHandlerManifest,
  RoutesManifest,
  UrlRewriteList
} from "../types";
import { isDynamicRoute, isOptionalCatchAllRoute } from "./lib/isDynamicRoute";
import pathToPosix from "./lib/pathToPosix";
import {
  expressifyDynamicRoute,
  expressifyOptionalCatchAllDynamicRoute
} from "./lib/expressifyDynamicRoute";
import pathToRegexStr from "./lib/pathToRegexStr";
import normalizeNodeModules from "./lib/normalizeNodeModules";
import createServerlessConfig from "./lib/createServerlessConfig";
import { isTrailingSlashRedirect } from "./routing/redirector";
import readDirectoryFiles from "./lib/readDirectoryFiles";
import filterOutDirectories from "./lib/filterOutDirectories";
import { PrerenderManifest } from "next/dist/build";
import { Item } from "klaw";
import { Job } from "@vercel/nft/out/node-file-trace";
import {
  BasicInvalidationUrlGroup,
  getGroupFilename,
  INVALIDATION_DATA_DIR
} from "./lib/invalidation/invalidationUrlGroup";
import fs from "fs";
import { isEmpty, map, forEach } from "lodash";
import { PERMANENT_STATIC_PAGES_DIR } from "./lib/permanentStaticPages";

export const DEFAULT_LAMBDA_CODE_DIR = "default-lambda";
export const API_LAMBDA_CODE_DIR = "api-lambda";
export const IMAGE_LAMBDA_CODE_DIR = "image-lambda";
export const ASSETS_DIR = "assets";

type BuildOptions = {
  args?: string[];
  cwd?: string;
  env?: { [key: string]: unknown };
  cmd?: string;
  useServerlessTraceTarget?: boolean;
  logLambdaExecutionTimes?: boolean;
  domainRedirects?: { [key: string]: string };
  minifyHandlers?: boolean;
  enableHTTPCompression?: boolean;
  handler?: string;
  authentication?: { username: string; password: string } | undefined;
  resolve?: (
    id: string,
    parent: string,
    job: Job,
    cjsResolve: boolean
  ) => Promise<string | string[]>;
  baseDir?: string;
  canonicalHostname?: string;
  distributionId: string;
  urlRewrites?: UrlRewriteList;
  enableDebugMode?: boolean;
  invalidationUrlGroups?: BasicInvalidationUrlGroup[];
  notFoundPageMark?: string;
  permanentStaticPages?: string[];
  sentry?: {
    dsn?: string;
    tracesSampleRate: number;
  };
  abTests?: ABTest[];
  enableRemoteInvalidation?: boolean;
};

const defaultBuildOptions = {
  args: [],
  cwd: process.cwd(),
  env: {},
  cmd: "./node_modules/.bin/next",
  useServerlessTraceTarget: false,
  logLambdaExecutionTimes: false,
  domainRedirects: {},
  minifyHandlers: false,
  enableHTTPCompression: true,
  authentication: undefined,
  resolve: undefined,
  baseDir: process.cwd(),
  distributionId: "",
  urlRewrites: [],
  enableDebugMode: false,
  invalidationUrlGroups: [],
  notFoundPageMark: undefined,
  permanentStaticPages: undefined,
  sentry: undefined,
  abTests: undefined,
  enableRemoteInvalidation: false
};

class Builder {
  nextConfigDir: string;
  nextStaticDir: string;
  dotNextDir: string;
  serverlessDir: string;
  outputDir: string;
  buildOptions: BuildOptions = defaultBuildOptions;

  constructor(
    nextConfigDir: string,
    outputDir: string,
    buildOptions?: BuildOptions,
    nextStaticDir?: string
  ) {
    this.nextConfigDir = path.resolve(nextConfigDir);
    this.nextStaticDir = path.resolve(nextStaticDir ?? nextConfigDir);
    this.dotNextDir = path.join(this.nextConfigDir, ".next");
    this.serverlessDir = path.join(this.dotNextDir, "serverless");
    this.outputDir = outputDir;
    if (buildOptions) {
      this.buildOptions = buildOptions;
    }
  }

  async readPublicFiles(): Promise<string[]> {
    const dirExists = await fse.pathExists(join(this.nextConfigDir, "public"));
    if (dirExists) {
      return getAllFiles(join(this.nextConfigDir, "public"))
        .map((e) => e.replace(this.nextConfigDir, ""))
        .map((e) => e.split(path.sep).slice(2).join("/"));
    } else {
      return [];
    }
  }

  async readPagesManifest(): Promise<{ [key: string]: string }> {
    const path = join(this.serverlessDir, "pages-manifest.json");
    const hasServerlessPageManifest = await fse.pathExists(path);

    if (!hasServerlessPageManifest) {
      return Promise.reject(
        "pages-manifest not found. Check if `next.config.js` target is set to 'serverless'"
      );
    }

    const pagesManifest = await fse.readJSON(path);
    const pagesManifestWithoutDynamicRoutes = Object.keys(pagesManifest).reduce(
      (acc: { [key: string]: string }, route: string) => {
        if (isDynamicRoute(route)) {
          return acc;
        }

        acc[route] = pagesManifest[route];
        return acc;
      },
      {}
    );

    const dynamicRoutedPages =
      Object.keys(pagesManifest).filter(isDynamicRoute);
    const sortedDynamicRoutedPages = getSortedRoutes(dynamicRoutedPages);
    const sortedPagesManifest = pagesManifestWithoutDynamicRoutes;

    sortedDynamicRoutedPages.forEach((route) => {
      sortedPagesManifest[route] = pagesManifest[route];
    });

    return sortedPagesManifest;
  }

  copyLambdaHandlerDependencies(
    fileList: string[],
    reasons: NodeFileTraceReasons,
    handlerDirectory: string,
    base: string
  ): Promise<void>[] {
    return fileList
      .filter((file) => {
        // exclude "initial" files from lambda artefact. These are just the pages themselves
        // which are copied over separately

        // For TypeScript apps, somehow nodeFileTrace will generate filelist with TS or TSX files, we need to exclude these files to be copied
        // as it ends up copying from same source to destination.
        if (file.endsWith(".ts") || file.endsWith(".tsx")) {
          return false;
        }

        const reason = reasons.get(file);

        return (
          (!reason || reason.type !== "initial") && file !== "package.json"
        );
      })
      .map((filePath: string) => {
        const resolvedFilePath = path.resolve(join(base, filePath));
        const dst = normalizeNodeModules(
          path.relative(this.serverlessDir, resolvedFilePath)
        );

        if (resolvedFilePath !== join(this.outputDir, handlerDirectory, dst)) {
          // Only copy when source and destination are different
          return fse.copy(
            resolvedFilePath,
            join(this.outputDir, handlerDirectory, dst)
          );
        } else {
          return Promise.resolve();
        }
      });
  }

  /**
   * Check whether this .next/serverless/pages file is a JS file used only for prerendering at build time.
   * @param prerenderManifest
   * @param relativePageFile
   */
  isPrerenderedJSFile(
    prerenderManifest: any,
    relativePageFile: string
  ): boolean {
    if (path.extname(relativePageFile) === ".js") {
      // Page route is without .js extension
      let pageRoute = relativePageFile.slice(0, -3);

      // Prepend "/"
      pageRoute = pageRoute.startsWith("/") ? pageRoute : `/${pageRoute}`;

      // Normalise index route
      pageRoute = pageRoute === "/index" ? "/" : pageRoute;

      return (
        !!prerenderManifest.routes && !!prerenderManifest.routes[pageRoute]
      );
    }

    return false;
  }

  /**
   * Process and copy RoutesManifest.
   * @param source
   * @param destination
   */
  async processAndCopyRoutesManifest(source: string, destination: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const routesManifest = require(source) as RoutesManifest;

    // Remove default trailing slash redirects as they are already handled without regex matching.
    routesManifest.redirects = routesManifest.redirects.filter((redirect) => {
      return !isTrailingSlashRedirect(redirect, routesManifest.basePath);
    });

    await fse.writeFile(destination, JSON.stringify(routesManifest));
  }

  /**
   * Process and copy handler code. This allows minifying it before copying to Lambda package.
   * @param handlerType
   * @param destination
   * @param shouldMinify
   */
  async processAndCopyHandler(
    handlerType: "api-handler" | "default-handler" | "image-handler",
    destination: string,
    shouldMinify: boolean
  ) {
    const source = require.resolve(
      `@getjerry/lambda-at-edge/dist/${handlerType}${
        shouldMinify ? ".min" : ""
      }.js`
    );

    await fse.copy(source, destination);
  }

  async buildDefaultLambda(
    buildManifest: OriginRequestDefaultHandlerManifest
  ): Promise<void[]> {
    let copyTraces: Promise<void>[] = [];

    if (this.buildOptions.useServerlessTraceTarget) {
      const ignoreAppAndDocumentPages = (page: string): boolean => {
        const basename = path.basename(page);
        return basename !== "_app.js" && basename !== "_document.js";
      };

      const allSsrPages = [
        ...Object.values(buildManifest.pages.ssr.nonDynamic),
        ...Object.values(buildManifest.pages.ssr.dynamic).map(
          (entry) => entry.file
        )
      ].filter(ignoreAppAndDocumentPages);

      const ssrPages = Object.values(allSsrPages).map((pageFile) =>
        path.join(this.serverlessDir, pageFile)
      );

      const base = this.buildOptions.baseDir || process.cwd();
      const { fileList, reasons } = await nodeFileTrace(ssrPages, {
        base,
        resolve: this.buildOptions.resolve
      });

      copyTraces = this.copyLambdaHandlerDependencies(
        Array.from(fileList),
        reasons,
        DEFAULT_LAMBDA_CODE_DIR,
        base
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const prerenderManifest = require(join(
      this.dotNextDir,
      "prerender-manifest.json"
    ));

    const hasAPIRoutes = await fse.pathExists(
      join(this.serverlessDir, "pages/api")
    );

    return Promise.all([
      ...copyTraces,
      this.processAndCopyHandler(
        "default-handler",
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "index.js"),
        !!this.buildOptions.minifyHandlers
      ),
      this.buildOptions?.handler
        ? fse.copy(
            join(this.nextConfigDir, this.buildOptions.handler),
            join(
              this.outputDir,
              DEFAULT_LAMBDA_CODE_DIR,
              this.buildOptions.handler
            )
          )
        : Promise.resolve(),
      fse.writeJson(
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "manifest.json"),
        buildManifest
      ),
      fse.copy(
        join(this.serverlessDir, "pages"),
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "pages"),
        {
          filter: (file: string) => {
            const isIndexJS = pathToPosix(file).endsWith("/index.js");

            if (isIndexJS) {
              // should keep all pages/index.js and pages/[some-path]/index.js in lambda folders
              return true;
            }
            const isNotPrerenderedHTMLPage = path.extname(file) !== ".html";
            const isNotStaticPropsJSONFile = path.extname(file) !== ".json";
            const isNotApiPage = pathToPosix(file).indexOf("pages/api") === -1;

            // If there are API routes, include all JS files.
            // If there are no API routes, exclude all JS files that used only for prerendering at build time.
            // We do this because if there are API routes, preview mode is possible which may use these JS files.
            // This is what Vercel does: https://github.com/vercel/next.js/discussions/15631#discussioncomment-44289
            // TODO: possibly optimize bundle further for those apps using API routes.
            const isNotExcludedJSFile =
              hasAPIRoutes ||
              !this.isPrerenderedJSFile(
                prerenderManifest,
                path.relative(join(this.serverlessDir, "pages"), file)
              );

            return (
              isNotApiPage &&
              isNotPrerenderedHTMLPage &&
              isNotStaticPropsJSONFile &&
              isNotExcludedJSFile
            );
          }
        }
      ),
      this.copyChunks(DEFAULT_LAMBDA_CODE_DIR),
      this.copyJSFiles(DEFAULT_LAMBDA_CODE_DIR),
      fse.copy(
        join(this.dotNextDir, "prerender-manifest.json"),
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "prerender-manifest.json")
      ),
      fse.copy(
        join(this.dotNextDir, "images-manifest.json"),
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "images-manifest.json")
      ),
      this.processAndCopyRoutesManifest(
        join(this.dotNextDir, "routes-manifest.json"),
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "routes-manifest.json")
      )
    ]);
  }

  async buildApiLambda(
    apiBuildManifest: OriginRequestApiHandlerManifest
  ): Promise<void[]> {
    let copyTraces: Promise<void>[] = [];

    if (this.buildOptions.useServerlessTraceTarget) {
      const allApiPages = [
        ...Object.values(apiBuildManifest.apis.nonDynamic),
        ...Object.values(apiBuildManifest.apis.dynamic).map(
          (entry) => entry.file
        )
      ];

      const apiPages = Object.values(allApiPages).map((pageFile) =>
        path.join(this.serverlessDir, pageFile)
      );

      const base = this.buildOptions.baseDir || process.cwd();
      const { fileList, reasons } = await nodeFileTrace(apiPages, {
        base,
        resolve: this.buildOptions.resolve
      });

      copyTraces = this.copyLambdaHandlerDependencies(
        Array.from(fileList),
        reasons,
        API_LAMBDA_CODE_DIR,
        base
      );
    }

    return Promise.all([
      ...copyTraces,
      this.processAndCopyHandler(
        "api-handler",
        join(this.outputDir, API_LAMBDA_CODE_DIR, "index.js"),
        !!this.buildOptions.minifyHandlers
      ),
      this.buildOptions?.handler
        ? fse.copy(
            join(this.nextConfigDir, this.buildOptions.handler),
            join(this.outputDir, API_LAMBDA_CODE_DIR, this.buildOptions.handler)
          )
        : Promise.resolve(),
      fse.copy(
        join(this.serverlessDir, "pages/api"),
        join(this.outputDir, API_LAMBDA_CODE_DIR, "pages/api")
      ),
      this.copyChunks(API_LAMBDA_CODE_DIR),
      this.copyJSFiles(API_LAMBDA_CODE_DIR),
      fse.writeJson(
        join(this.outputDir, API_LAMBDA_CODE_DIR, "manifest.json"),
        apiBuildManifest
      ),
      this.processAndCopyRoutesManifest(
        join(this.dotNextDir, "routes-manifest.json"),
        join(this.outputDir, API_LAMBDA_CODE_DIR, "routes-manifest.json")
      )
    ]);
  }

  /**
   * copy chunks if present and not using serverless trace
   */
  copyChunks(handlerDir: string): Promise<void> {
    return !this.buildOptions.useServerlessTraceTarget &&
      fse.existsSync(join(this.serverlessDir, "chunks"))
      ? fse.copy(
          join(this.serverlessDir, "chunks"),
          join(this.outputDir, handlerDir, "chunks")
        )
      : Promise.resolve();
  }

  /**
   * Copy additional JS files needed such as webpack-runtime.js (new in Next.js 12)
   */
  async copyJSFiles(handlerDir: string): Promise<void> {
    await Promise.all([
      (await fse.pathExists(join(this.serverlessDir, "webpack-api-runtime.js")))
        ? fse.copy(
            join(this.serverlessDir, "webpack-api-runtime.js"),
            join(this.outputDir, handlerDir, "webpack-api-runtime.js")
          )
        : Promise.resolve(),
      (await fse.pathExists(join(this.serverlessDir, "webpack-runtime.js")))
        ? fse.copy(
            join(this.serverlessDir, "webpack-runtime.js"),
            join(this.outputDir, handlerDir, "webpack-runtime.js")
          )
        : Promise.resolve()
    ]);
  }

  /**
   * Build image optimization lambda (supported by Next.js 10)
   * @param buildManifest
   */
  async buildImageLambda(
    buildManifest: OriginRequestImageHandlerManifest
  ): Promise<void[]> {
    return Promise.all([
      this.processAndCopyHandler(
        "image-handler",
        join(this.outputDir, IMAGE_LAMBDA_CODE_DIR, "index.js"),
        !!this.buildOptions.minifyHandlers
      ),
      this.buildOptions?.handler
        ? fse.copy(
            join(this.nextConfigDir, this.buildOptions.handler),
            join(
              this.outputDir,
              IMAGE_LAMBDA_CODE_DIR,
              this.buildOptions.handler
            )
          )
        : Promise.resolve(),
      fse.writeJson(
        join(this.outputDir, IMAGE_LAMBDA_CODE_DIR, "manifest.json"),
        buildManifest
      ),
      this.processAndCopyRoutesManifest(
        join(this.dotNextDir, "routes-manifest.json"),
        join(this.outputDir, IMAGE_LAMBDA_CODE_DIR, "routes-manifest.json")
      ),
      fse.copy(
        join(
          path.dirname(
            require.resolve("@getjerry/lambda-at-edge/package.json")
          ),
          "dist",
          "sharp_node_modules"
        ),
        join(this.outputDir, IMAGE_LAMBDA_CODE_DIR, "node_modules")
      ),
      fse.copy(
        join(this.dotNextDir, "images-manifest.json"),
        join(this.outputDir, IMAGE_LAMBDA_CODE_DIR, "images-manifest.json")
      )
    ]);
  }

  async prepareBuildManifests(): Promise<{
    defaultBuildManifest: OriginRequestDefaultHandlerManifest;
    apiBuildManifest: OriginRequestApiHandlerManifest;
    imageBuildManifest: OriginRequestImageHandlerManifest;
  }> {
    const pagesManifest = await this.readPagesManifest();

    const buildId = await fse.readFile(
      path.join(this.dotNextDir, "BUILD_ID"),
      "utf-8"
    );
    const {
      logLambdaExecutionTimes = false,
      domainRedirects = {},
      enableHTTPCompression = false,
      authentication = undefined
    } = this.buildOptions;

    this.normalizeDomainRedirects(domainRedirects);

    // in dev mode, the max access number will always be 1
    const defaultInvalidationGroupNumber = 1;
    const defaultBuildManifest: OriginRequestDefaultHandlerManifest = {
      buildId,
      logLambdaExecutionTimes,
      pages: {
        ssr: {
          dynamic: {},
          nonDynamic: {}
        },
        html: {
          dynamic: {},
          nonDynamic: {}
        }
      },
      publicFiles: {},
      trailingSlash: false,
      domainRedirects: domainRedirects,
      authentication: authentication,
      canonicalHostname: this.buildOptions.canonicalHostname,
      distributionId: this.buildOptions.distributionId,
      enableHTTPCompression,
      urlRewrites: this.buildOptions.urlRewrites,
      enableDebugMode: this.buildOptions.enableDebugMode,
      invalidationUrlGroups: this.buildOptions.invalidationUrlGroups?.map(
        (group) => {
          return {
            ...group,
            maxAccessNumber: this.buildOptions.enableDebugMode
              ? defaultInvalidationGroupNumber
              : group.maxAccessNumber
          };
        }
      ),
      notFoundPageMark: this.buildOptions.notFoundPageMark,
      permanentStaticPages: this.buildOptions.permanentStaticPages,
      sentry: this.buildOptions.sentry,
      abTests: this.buildOptions.abTests,
      enableRemoteInvalidation: this.buildOptions.enableRemoteInvalidation
    };

    const apiBuildManifest: OriginRequestApiHandlerManifest = {
      apis: {
        dynamic: {},
        nonDynamic: {}
      },
      domainRedirects: domainRedirects,
      authentication: authentication,
      enableHTTPCompression
    };

    const ssrPages = defaultBuildManifest.pages.ssr;
    const htmlPages = defaultBuildManifest.pages.html;
    const apiPages = apiBuildManifest.apis;

    const isHtmlPage = (path: string): boolean => path.endsWith(".html");
    const isApiPage = (path: string): boolean => path.startsWith("pages/api");

    Object.entries(pagesManifest).forEach(([route, pageFile]) => {
      // Check for optional catch all dynamic routes vs. other types of dynamic routes
      // We also add another route without dynamic parameter for optional catch all dynamic routes
      const isOptionalCatchAllDynamicRoute = isOptionalCatchAllRoute(route);
      const isOtherDynamicRoute =
        !isOptionalCatchAllDynamicRoute && isDynamicRoute(route);

      let expressRoute = "";
      let optionalBaseRoute = "";
      if (isOtherDynamicRoute) {
        expressRoute = expressifyDynamicRoute(route);
      } else if (isOptionalCatchAllDynamicRoute) {
        expressRoute = expressifyOptionalCatchAllDynamicRoute(route);
        optionalBaseRoute = route.split("/[[")[0]; // The base path of optional catch-all without parameter
        optionalBaseRoute = optionalBaseRoute === "" ? "/" : optionalBaseRoute;
      }

      if (isHtmlPage(pageFile)) {
        if (isOtherDynamicRoute) {
          const route = expressRoute;
          htmlPages.dynamic[route] = {
            file: pageFile,
            regex: pathToRegexStr(route)
          };
        } else if (isOptionalCatchAllDynamicRoute) {
          const route = expressRoute;
          htmlPages.dynamic[route] = {
            file: pageFile,
            regex: pathToRegexStr(route)
          };
          htmlPages.nonDynamic[optionalBaseRoute] = pageFile;
        } else {
          htmlPages.nonDynamic[route] = pageFile;
        }
      } else if (isApiPage(pageFile)) {
        if (isOtherDynamicRoute) {
          const route = expressRoute as string;
          apiPages.dynamic[route] = {
            file: pageFile,
            regex: pathToRegexStr(route)
          };
        } else if (isOptionalCatchAllDynamicRoute) {
          const route = expressRoute as string;
          apiPages.dynamic[route] = {
            file: pageFile,
            regex: pathToRegexStr(route)
          };
          apiPages.nonDynamic[optionalBaseRoute] = pageFile;
        } else {
          apiPages.nonDynamic[route] = pageFile;
        }
      } else if (isOtherDynamicRoute) {
        const route = expressRoute as string;
        ssrPages.dynamic[route] = {
          file: pageFile,
          regex: pathToRegexStr(route)
        };
      } else if (isOptionalCatchAllDynamicRoute) {
        const route = expressRoute as string;
        ssrPages.dynamic[route] = {
          file: pageFile,
          regex: pathToRegexStr(route)
        };
        ssrPages.nonDynamic[optionalBaseRoute] = pageFile;
      } else {
        ssrPages.nonDynamic[route] = pageFile;
      }
    });

    const publicFiles = await this.readPublicFiles();

    publicFiles.forEach((pf) => {
      defaultBuildManifest.publicFiles["/" + pf] = pf;
    });

    // Read next.config.js
    const nextConfigPath = path.join(this.nextConfigDir, "next.config.js");

    if (await fse.pathExists(nextConfigPath)) {
      const nextConfig = await require(nextConfigPath);

      let normalisedNextConfig;
      if (typeof nextConfig === "object") {
        normalisedNextConfig = nextConfig;
      } else if (typeof nextConfig === "function") {
        // Execute using phase based on: https://github.com/vercel/next.js/blob/8a489e24bcb6141ad706e1527b77f3ff38940b6d/packages/next/next-server/lib/constants.ts#L1-L4
        normalisedNextConfig = nextConfig("phase-production-server", {});
      }

      // Support trailing slash: https://nextjs.org/docs/api-reference/next.config.js/trailing-slash
      defaultBuildManifest.trailingSlash =
        normalisedNextConfig?.trailingSlash ?? false;
    }

    // Image manifest
    const imageBuildManifest: OriginRequestImageHandlerManifest = {
      domainRedirects: domainRedirects,
      enableHTTPCompression: enableHTTPCompression
    };

    return {
      defaultBuildManifest,
      apiBuildManifest,
      imageBuildManifest
    };
  }

  /**
   * Build static assets such as client-side JS, public files, static pages, etc.
   * Note that the upload to S3 is done in a separate deploy step.
   */
  async buildStaticAssets(
    defaultBuildManifest: OriginRequestDefaultHandlerManifest,
    routesManifest: RoutesManifest
  ) {
    const buildId = defaultBuildManifest.buildId;
    const basePath = routesManifest.basePath;
    const nextConfigDir = this.nextConfigDir;
    const nextStaticDir = this.nextStaticDir;

    const dotNextDirectory = path.join(this.nextConfigDir, ".next");

    const assetOutputDirectory = path.join(this.outputDir, ASSETS_DIR);

    const normalizedBasePath = basePath ? basePath.slice(1) : "";
    const withBasePath = (key: string): string =>
      path.join(normalizedBasePath, key);

    const copyIfExists = async (
      source: string,
      destination: string
    ): Promise<void> => {
      if (await fse.pathExists(source)) {
        await fse.copy(source, destination);
      }
    };

    // Copy BUILD_ID file
    const copyBuildId = copyIfExists(
      path.join(dotNextDirectory, "BUILD_ID"),
      path.join(assetOutputDirectory, withBasePath("BUILD_ID"))
    );

    const buildStaticFiles = await readDirectoryFiles(
      path.join(dotNextDirectory, "static")
    );

    const staticFileAssets = buildStaticFiles
      .filter(filterOutDirectories)
      .map(async (fileItem: Item) => {
        const source = fileItem.path;
        const destination = path.join(
          assetOutputDirectory,
          withBasePath(
            path
              .relative(path.resolve(nextConfigDir), source)
              .replace(/^.next/, "_next")
          )
        );

        return copyIfExists(source, destination);
      });

    const pagesManifest = await fse.readJSON(
      path.join(dotNextDirectory, "serverless/pages-manifest.json")
    );

    const htmlPageAssets = Object.values(pagesManifest)
      .filter((pageFile) => (pageFile as string).endsWith(".html"))
      .map((relativePageFilePath) => {
        const source = path.join(
          dotNextDirectory,
          `serverless/${relativePageFilePath}`
        );
        const destination = path.join(
          assetOutputDirectory,
          withBasePath(
            `static-pages/${buildId}/${(relativePageFilePath as string).replace(
              /^pages\//,
              ""
            )}`
          )
        );

        return copyIfExists(source, destination);
      });

    const prerenderManifest: PrerenderManifest = await fse.readJSON(
      path.join(dotNextDirectory, "prerender-manifest.json")
    );

    const prerenderManifestJSONPropFileAssets = Object.keys(
      prerenderManifest.routes
    ).map((key) => {
      const source = path.join(
        dotNextDirectory,
        `serverless/pages/${
          key.endsWith("/") ? key + "index.json" : key + ".json"
        }`
      );
      const destination = path.join(
        assetOutputDirectory,
        withBasePath(prerenderManifest.routes[key].dataRoute.slice(1))
      );

      return copyIfExists(source, destination);
    });

    const prerenderManifestHTMLPageAssets = Object.keys(
      prerenderManifest.routes
    ).map((key) => {
      const relativePageFilePath = key.endsWith("/")
        ? path.join(key, "index.html")
        : key + ".html";

      const source = path.join(
        dotNextDirectory,
        `serverless/pages/${relativePageFilePath}`
      );
      const destination = path.join(
        assetOutputDirectory,
        withBasePath(path.join("static-pages", buildId, relativePageFilePath))
      );

      return copyIfExists(source, destination);
    });

    const fallbackHTMLPageAssets = Object.values(
      prerenderManifest.dynamicRoutes || {}
    )
      .filter(({ fallback }) => {
        return !!fallback;
      })
      .map((routeConfig) => {
        const fallback = routeConfig.fallback as string;

        const source = path.join(
          dotNextDirectory,
          `serverless/pages/${fallback}`
        );

        const destination = path.join(
          assetOutputDirectory,
          withBasePath(path.join("static-pages", buildId, fallback))
        );

        return copyIfExists(source, destination);
      });

    // Check if public/static exists and fail build since this conflicts with static/* behavior.
    if (await fse.pathExists(path.join(nextStaticDir, "public", "static"))) {
      throw new Error(
        "You cannot have assets in the directory [public/static] as they conflict with the static/* CloudFront cache behavior. Please move these assets into another directory."
      );
    }

    const buildPublicOrStaticDirectory = async (
      directory: "public" | "static"
    ) => {
      const directoryPath = path.join(nextStaticDir, directory);
      if (!(await fse.pathExists(directoryPath))) {
        return Promise.resolve([]);
      }

      const files = await readDirectoryFiles(directoryPath);

      return files.filter(filterOutDirectories).map((fileItem: Item) => {
        const source = fileItem.path;
        const destination = path.join(
          assetOutputDirectory,
          withBasePath(
            path.relative(path.resolve(nextStaticDir), fileItem.path)
          )
        );

        return fse.copy(source, destination);
      });
    };

    const publicDirAssets = await buildPublicOrStaticDirectory("public");
    const staticDirAssets = await buildPublicOrStaticDirectory("static");

    return Promise.all([
      copyBuildId, // BUILD_ID
      ...staticFileAssets, // .next/static
      ...htmlPageAssets, // prerendered html pages
      ...prerenderManifestJSONPropFileAssets, // SSG json files
      ...prerenderManifestHTMLPageAssets, // SSG html files
      ...fallbackHTMLPageAssets, // fallback files
      ...publicDirAssets, // public dir
      ...staticDirAssets // static dir
    ]);
  }

  async cleanupDotNext(): Promise<void> {
    const exists = await fse.pathExists(this.dotNextDir);

    if (exists) {
      const fileItems = await fse.readdir(this.dotNextDir);

      await Promise.all(
        fileItems
          .filter(
            (fileItem) => fileItem !== "cache" // avoid deleting the cache folder as that leads to slow next builds!
          )
          .map((fileItem) => fse.remove(join(this.dotNextDir, fileItem)))
      );
    }
  }

  async build(debugMode?: boolean): Promise<void> {
    const {
      cmd,
      args,
      cwd,
      env: inputEnv,
      useServerlessTraceTarget
    } = Object.assign(defaultBuildOptions, this.buildOptions);

    const env = {
      ...process.env,
      ...inputEnv
    };

    await this.cleanupDotNext();

    await fse.emptyDir(join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR));
    await fse.emptyDir(join(this.outputDir, API_LAMBDA_CODE_DIR));
    await fse.emptyDir(join(this.outputDir, IMAGE_LAMBDA_CODE_DIR));
    await fse.emptyDir(join(this.outputDir, ASSETS_DIR));

    const { restoreUserConfig } = await createServerlessConfig(
      cwd,
      path.join(this.nextConfigDir),
      useServerlessTraceTarget
    );

    try {
      const subprocess = execa(cmd, args, {
        cwd,
        env: env as NodeJS.ProcessEnv
      });

      if (debugMode) {
        // @ts-ignore
        subprocess.stdout.pipe(process.stdout);
      }

      await subprocess;
    } finally {
      await restoreUserConfig();
    }

    const { defaultBuildManifest, apiBuildManifest, imageBuildManifest } =
      await this.prepareBuildManifests();

    await this.buildDefaultLambda(defaultBuildManifest);

    const hasAPIPages =
      Object.keys(apiBuildManifest.apis.nonDynamic).length > 0 ||
      Object.keys(apiBuildManifest.apis.dynamic).length > 0;

    if (hasAPIPages) {
      await this.buildApiLambda(apiBuildManifest);
    }

    // If using Next.j 10, then images-manifest.json is present and image optimizer can be used
    const hasImageOptimizer = fse.existsSync(
      join(this.dotNextDir, "images-manifest.json")
    );

    if (hasImageOptimizer) {
      await this.buildImageLambda(imageBuildManifest);
    }

    // Copy static assets to .serverless_nextjs directory
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const routesManifest = require(join(
      this.dotNextDir,
      "routes-manifest.json"
    ));
    await this.buildStaticAssets(defaultBuildManifest, routesManifest);

    // check if we need to create DynamicData in deploy phrase. Now, we only use invalidation urls as DynamicData
    const hasDynamicDataAssets = !isEmpty(
      defaultBuildManifest.invalidationUrlGroups
    );

    if (hasDynamicDataAssets) {
      await this.buildDynamicDataAssets(defaultBuildManifest, routesManifest);
    }

    // check if we need to create Permanently Saved Pages in deploy phrase.
    const hasPermanentStaticPages = !isEmpty(
      defaultBuildManifest.permanentStaticPages
    );

    if (hasPermanentStaticPages) {
      await this.buildPermanentStaticPages(
        defaultBuildManifest,
        routesManifest
      );
    }
  }

  /**
   * Normalize domain redirects by validating they are URLs and getting rid of trailing slash.
   * @param domainRedirects
   */
  normalizeDomainRedirects(domainRedirects: { [key: string]: string }) {
    for (const key in domainRedirects) {
      const destination = domainRedirects[key];

      let url;
      try {
        url = new URL(destination);
      } catch (error) {
        throw new Error(
          `domainRedirects: ${destination} is invalid. The URL is not in a valid URL format.`
        );
      }

      const { origin, pathname, searchParams } = url;

      if (!origin.startsWith("https://") && !origin.startsWith("http://")) {
        throw new Error(
          `domainRedirects: ${destination} is invalid. The URL must start with http:// or https://.`
        );
      }

      if (Array.from(searchParams).length > 0) {
        throw new Error(
          `domainRedirects: ${destination} is invalid. The URL must not contain query parameters.`
        );
      }

      let normalizedDomain = `${origin}${pathname}`;
      normalizedDomain = normalizedDomain.endsWith("/")
        ? normalizedDomain.slice(0, -1)
        : normalizedDomain;

      domainRedirects[key] = normalizedDomain;
    }
  }

  /**
   * Build dynamic data assets, now we only have invalidation url counters.
   * Note that the upload to S3 is done in a separate deploy step.
   */
  async buildDynamicDataAssets(
    defaultBuildManifest: OriginRequestDefaultHandlerManifest,
    routesManifest: RoutesManifest
  ) {
    const basePath = routesManifest.basePath;
    const normalizedBasePath = basePath ? basePath.slice(1) : "";
    const buildId = defaultBuildManifest.buildId;

    //create invalidation url groups dir.
    const directoryPath = path.join(
      this.outputDir,
      ASSETS_DIR,
      normalizedBasePath,
      "_next",
      "data",
      buildId,
      INVALIDATION_DATA_DIR
    );

    if (!fs.existsSync(directoryPath)) {
      fs.mkdirSync(directoryPath, { recursive: true });
    }

    const initAccessNumber = 0;
    map(defaultBuildManifest.invalidationUrlGroups || [], async (group) => {
      await fse.writeFile(
        join(directoryPath, getGroupFilename(group)),
        JSON.stringify({
          ...group,
          currentNumber: initAccessNumber
        })
      );
    });
  }

  /**
   * Build Permanent Static Pages, now we only have homepage.
   * Note that the upload to S3 is done in a separate deploy step.
   */
  async buildPermanentStaticPages(
    defaultBuildManifest: OriginRequestDefaultHandlerManifest,
    routesManifest: RoutesManifest
  ) {
    if (isEmpty(defaultBuildManifest.permanentStaticPages)) {
      return;
    }

    const basePath = routesManifest.basePath;
    const normalizedBasePath = basePath ? basePath.slice(1) : "";
    const buildId = defaultBuildManifest.buildId;

    const copyIfExists = async (
      source: string,
      destination: string
    ): Promise<void> => {
      if (await fse.pathExists(source)) {
        await fse.copy(source, destination);
      }
    };

    const sourcePath = path.join(
      this.outputDir,
      ASSETS_DIR,
      normalizedBasePath,
      "static-pages",
      buildId
    );

    //create Permanent Static Pages dir.
    const directoryPath = path.join(sourcePath, PERMANENT_STATIC_PAGES_DIR);

    if (!fs.existsSync(directoryPath)) {
      fs.mkdirSync(directoryPath, { recursive: true });
    }

    forEach(defaultBuildManifest.permanentStaticPages, (page) => {
      const source = path.join(sourcePath, page);
      const destination = path.join(directoryPath, page);
      return copyIfExists(source, destination);
    });
  }
}

export default Builder;
