import lambdaAtEdgeCompat from "@getjerry/next-aws-cloudfront";
import { createETag } from "../lib/etag";
import { debug } from "../lib/console";

class Page {
  constructor(
    private readonly json: Record<string, unknown>,
    private readonly html: string
  ) {}

  public getHtmlEtag() {
    return createETag().update(this.html).digest();
  }

  public getJsonEtag() {
    return createETag().update(JSON.stringify(this.json)).digest();
  }

  public getHtmlBody() {
    return this.html;
  }

  public getJsonBody() {
    return JSON.stringify(this.json);
  }
}

export class RenderService {
  constructor(private readonly event: any) {}

  public async getPage(
    pagePath?: string,
    rewrittenUri?: string
  ): Promise<Page | undefined> {
    debug(`[render] Page path: ${pagePath}`);

    // eslint-disable-next-line
    const page = require(`./${pagePath}`);

    debug(`[render] Page: ${JSON.stringify(pagePath)}`);
    debug(`[render] Page2: ${JSON.stringify(!page?.getStaticProps)}`);

    if (!page?.getStaticProps) {
      return;
    }
    debug(`[render] Page2: ${JSON.stringify(page)}`);
    debug(
      `[render] lambdaAtEdgeCompat: ${JSON.stringify(
        this.event.Records[0].cf
      )} ${rewrittenUri}`
    );
    debug("start");
    const { req, res } = lambdaAtEdgeCompat(this.event.Records[0].cf, {
      enableHTTPCompression: false,
      rewrittenUri
    });
    debug("end");
    debug(`[render]  req, res: ${JSON.stringify(req)} ${JSON.stringify(res)}`);

    const { renderOpts, html } = await page.renderReqToHTML(
      req,
      res,
      "passthrough"
    );

    debug(`[render] Rendered HTML: ${html}`);
    debug(`[render] Rendered options: ${JSON.stringify(renderOpts)}`);

    return new Page(renderOpts.pageData, html);
  }
}
