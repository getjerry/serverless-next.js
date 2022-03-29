import { pathToRegexp } from "path-to-regexp";
import { debug } from "./console";

export default (path: string): string =>
  pathToRegexp(path)
    .toString()
    .replace(/\/(.*)\/\i/, "$1");

type param = {
  key: string;
  value: string;
};
export const getParamsFormQuery = (querystring: string): param[] => {
  return querystring.split("&").map((s) => {
    return { key: s.split("=")[0], value: s.split("=")[1] };
  });
};

export const isOriginUrlMatch = (
  params: param[],
  originUrl: string,
  requestUrl: string
): boolean => {
  debug(
    `[isOriginUrlMatch]: ${requestUrl} ${urlWithParams(originUrl, params)}]`
  );
  return requestUrl === urlWithParams(originUrl, params);
};

export const urlWithParams = (url: string, params: param[]): string => {
  params.forEach((p) => {
    url.replace(`[${p.key}]`, p.value);
  });
  debug(`[urlWithParams]: ${url}`);
  return url;
};
