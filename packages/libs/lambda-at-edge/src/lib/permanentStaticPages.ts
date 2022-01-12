import { debug } from "./console";
import { S3Client } from "@aws-sdk/client-s3/S3Client";
import { buildS3RetryStrategy } from "../s3/s3RetryStrategy";
import { GetObjectCommand } from "@aws-sdk/client-s3/commands/GetObjectCommand";
import { Readable } from "stream";
import {
  OriginRequestDefaultHandlerManifest,
  OriginRequestEvent,
  OriginResponseEvent,
  RevalidationEvent,
  RoutesManifest
} from "../../types";

export const PERMANENT_STATIC_PAGES_DIR = "/_permanent_static_pages/";

export const generatePermanentPageResponse = async (
  uri: string,
  event: OriginRequestEvent | OriginResponseEvent | RevalidationEvent,
  manifest: OriginRequestDefaultHandlerManifest,
  routesManifest: RoutesManifest
) => {
  const { domainName, region } = event.Records[0].cf.request.origin!.s3!;
  const bucketName = domainName.replace(`.s3.${region}.amazonaws.com`, "");
  const basePath = routesManifest.basePath;

  const s3 = new S3Client({
    region,
    maxAttempts: 3,
    retryStrategy: await buildS3RetryStrategy()
  });

  //get page from S3
  const s3Key = `${(basePath || "").replace(/^\//, "")}${
    basePath === "" ? "" : "/"
  }static-pages/${manifest.buildId}${PERMANENT_STATIC_PAGES_DIR}${uri}`;

  const getStream = await import("get-stream");

  const s3Params = {
    Bucket: bucketName,
    Key: s3Key
  };

  const { Body } = await s3.send(new GetObjectCommand(s3Params));
  const bodyString = await getStream.default(Body as Readable);

  const out = {
    status: "200",
    statusDescription: "OK",
    headers: {
      "content-type": [
        {
          key: "Content-Type",
          value: "text/html"
        }
      ],
      "cache-control": [
        {
          key: "Cache-Control",
          value: "public, max-age=0, s-maxage=2678400, must-revalidate"
        }
      ]
    },
    body: bodyString
  };
  debug(`[generatePermanentPageResponse]: ${JSON.stringify(out)}`);
  return out;
};
