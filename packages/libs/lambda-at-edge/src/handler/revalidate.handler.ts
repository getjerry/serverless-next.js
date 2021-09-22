import { Context } from "aws-lambda";

import { RevalidationEvent } from "../../types";
import { CloudFrontService } from "../services/cloudfront.service";
import { RenderService } from "../services/render.service";
import { ResourceService } from "../services/resource.service";
import { S3Service } from "../services/s3.service";
import { debug, isDevMode } from "../lib/console";

// ISR needs to maintain a time gap of at least tens of seconds.
const REVALIDATE_TRIGGER_GAP_SECONDS = isDevMode() ? 1 : 300;

export class RevalidateHandler {
  constructor(
    private resourceService: ResourceService,
    private renderService: RenderService,
    private s3Service: S3Service,
    private cloudfrontService: CloudFrontService
  ) {}

  public async run(event: RevalidationEvent, context: Context): Promise<void> {
    const resource = this.resourceService.get(event);
    debug(JSON.stringify(resource));
    debug(JSON.stringify(event));
    debug(JSON.stringify(context));

    const [htmlHeader, jsonHeader, candidatePage] = await Promise.all([
      this.s3Service.getHeader(resource.getHtmlKey()),
      this.s3Service.getHeader(resource.getJsonKey()),
      this.renderService.getPage(resource.getPagePath(), resource.getJsonUri())
    ]);

    if (this.shouldSkipRevalidate(htmlHeader.header.LastModified)) {
      debug(
        `The last ISR was triggered ${REVALIDATE_TRIGGER_GAP_SECONDS} seconds ago, so skip this one.`
      );
      return;
    }

    debug(`[handler] Revalidate resource: ${JSON.stringify(resource)}`);

    if (!candidatePage) {
      throw new Error(`Page for ${resource.getPagePath()} not found`);
    }

    const isEqual = require("lodash.isequal");

    debug(
      `Current HTML ETAG: ${htmlHeader.getETag()}, isEqual ${isEqual(
        "a",
        "b"
      )}Candidate Page HTML ETAG: ${candidatePage.getHtmlEtag()}`
    );

    debug(
      `Current JSON ETAG: ${jsonHeader.getETag()}, Candidate Page JSON ETAG: ${candidatePage.getJsonEtag()}`
    );

    debug(`CANDIDATE PAGE: ${JSON.stringify(candidatePage)}`);

    if (
      htmlHeader.getETag() !== candidatePage.getHtmlEtag() ||
      jsonHeader.getETag() !== candidatePage.getJsonEtag()
    ) {
      debug(
        `[handler] Resource changed, update S3 cache and invalidate. html: ${resource.getHtmlKey()}, json:${resource.getJsonKey()}`
      );

      await Promise.all([
        this.s3Service.putObject(
          resource.getHtmlKey(),
          candidatePage.getHtmlBody(),
          "text/html"
        ),
        this.s3Service.putObject(
          resource.getJsonKey(),
          candidatePage.getJsonBody(),
          "application/json"
        )
      ]);

      await this.cloudfrontService.createInvalidation([
        resource.getHtmlUri(),
        resource.getJsonUri()
      ]);
    }

    return;
  }

  //check lastModified to control revalidate
  private shouldSkipRevalidate(lastModified: Date | undefined) {
    if (lastModified === undefined) return false;
    debug(
      `[checkRevalidateTimeGap] lastModified at ${lastModified}, current: ${new Date()}`
    );

    return (
      new Date() <
      new Date(lastModified!.getTime() + REVALIDATE_TRIGGER_GAP_SECONDS * 1000)
    );
  }
}
