import { S3Client } from "@aws-sdk/client-s3/S3Client";
import {
  PutObjectCommand,
  HeadObjectCommand,
  HeadObjectCommandOutput
} from "@aws-sdk/client-s3";
import { GetObjectCommand } from "@aws-sdk/client-s3/commands/GetObjectCommand";

interface S3ServiceOptions {
  bucketName?: string;
  domainName?: string;
  region?: string;
}

class S3Header {
  header: HeadObjectCommandOutput;

  constructor(header: HeadObjectCommandOutput) {
    this.header = header;
  }

  getETag(): string | undefined {
    return this.header.ETag && this.header.ETag.replace(/"/g, "");
  }
}

export class S3Service {
  constructor(
    private readonly client: S3Client,
    private readonly options: S3ServiceOptions = {}
  ) {}

  public async getHeader(key: string): Promise<S3Header> {
    if (!this.options.bucketName) {
      throw new Error("Bucket name not configured");
    }
    if (!key) {
      throw new Error("Key is not provided");
    }

    try {
      const headOutput = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.options.bucketName,
          Key: key
        })
      );
      return new S3Header(headOutput);
    } catch (e) {
      return new S3Header({ $metadata: {}, ETag: undefined });
    }
  }

  public async putObject(
    key: string,
    body: string,
    contentType: string
  ): Promise<void> {
    if (!this.options.bucketName) {
      throw new Error("Bucket name not configured");
    }
    if (!body) {
      throw new Error("Data is not provided");
    }
    await this.client.send(
      new PutObjectCommand({
        Key: key,
        Body: body,
        Bucket: this.options.bucketName,
        ContentType: contentType,
        CacheControl: "public, max-age=0, s-maxage=2678400, must-revalidate"
      })
    );
  }

  public async getObject(key: string): Promise<any> {
    if (!this.options.bucketName) {
      throw new Error("Bucket name not configured");
    }
    const data = await this.client.send(
      new GetObjectCommand({
        Key: key,
        Bucket: this.options.bucketName
      })
    );

    return data;
  }
}
