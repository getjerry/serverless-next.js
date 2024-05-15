export const IMMUTABLE_CACHE_CONTROL_HEADER =
  "public, max-age=31536000, immutable";

export const SERVER_CACHE_CONTROL_HEADER =
  "public, max-age=0, s-maxage=2678400, must-revalidate";

// stale while revalidating
export const SWR_CACHE_CONTROL_HEADER =
  "public, max-age=300, s-maxage=900, stale-while-revalidate=31536000, stale-while-error=31536000";

export const DEFAULT_PUBLIC_DIR_CACHE_CONTROL =
  "public, max-age=31536000, must-revalidate";

export const SERVER_NO_CACHE_CACHE_CONTROL_HEADER =
  "public, max-age=0, s-maxage=0, must-revalidate";

//  DEFAULT_PUBLIC_DIR_CACHE_REGEX
export const DEFAULT_PUBLIC_DIR_CACHE_REGEX =
  /\.(gif|jpe?g|jp2|tiff|png|webp|bmp|svg|ico)$/i;
