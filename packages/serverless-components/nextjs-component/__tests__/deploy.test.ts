import path from "path";
import fse from "fs-extra";
import { mockS3 } from "@serverless/aws-s3";
import { mockCloudFront } from "@getjerry/aws-cloudfront";
import { mockLambda, mockLambdaPublish } from "@getjerry/aws-lambda";
import mockCreateInvalidation from "@getjerry/cloudfront";
import NextjsComponent from "../src/component";
import {
  API_LAMBDA_CODE_DIR,
  DEFAULT_LAMBDA_CODE_DIR,
  IMAGE_LAMBDA_CODE_DIR
} from "../src/constants";
import { cleanupFixtureDirectory } from "../src/lib/test-utils";
import { mockUpload } from "aws-sdk";
import { DeploymentResult } from "../dist/component";

describe("deploy tests", () => {
  let tmpCwd: string;
  let componentOutputs: DeploymentResult;
  let consoleWarnSpy: jest.Mock;
  let fseRemoveSpy: jest.SpyInstance;

  const fixturePath = path.join(__dirname, "./fixtures/simple-app");

  beforeEach(async () => {
    const realFseRemove = fse.remove.bind({});
    fseRemoveSpy = jest.spyOn(fse, "remove").mockImplementation((filePath) => {
      // don't delete mocked .next/ files as they're needed for the tests and committed to source control
      if (!filePath.includes(".next" + path.sep)) {
        return realFseRemove(filePath);
      }
    });
    consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockReturnValue() as unknown as jest.Mock;

    tmpCwd = process.cwd();
    process.chdir(fixturePath);

    mockS3.mockResolvedValue({
      name: "bucket-xyz"
    });
    mockLambda.mockResolvedValueOnce({
      arn: "arn:aws:lambda:us-east-1:123456789012:function:api-cachebehavior-func"
    });
    mockLambda.mockResolvedValueOnce({
      arn: "arn:aws:lambda:us-east-1:123456789012:function:image-cachebehavior-func"
    });
    mockLambda.mockResolvedValueOnce({
      arn: "arn:aws:lambda:us-east-1:123456789012:function:default-cachebehavior-func"
    });
    mockLambdaPublish.mockResolvedValue({
      version: "v1"
    });
    mockCloudFront.mockResolvedValueOnce({
      id: "cloudfrontdistrib",
      url: "https://cloudfrontdistrib.amazonaws.com"
    });

    const component = new NextjsComponent();
    component.context.credentials = {
      aws: {
        accessKeyId: "123",
        secretAccessKey: "456"
      }
    };

    await component.build();

    componentOutputs = await component.deploy();
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    fseRemoveSpy.mockRestore();
    process.chdir(tmpCwd);
  });

  afterAll(cleanupFixtureDirectory(fixturePath));

  it("outputs next application url from cloudfront", () => {
    expect(componentOutputs.appUrl).toEqual(
      "https://cloudfrontdistrib.amazonaws.com"
    );
  });

  it("outputs S3 bucket name", () => {
    expect(componentOutputs.bucketName).toEqual("bucket-xyz");
  });

  describe("cloudfront", () => {
    it("provisions default lambda", () => {
      expect(mockLambda).toHaveBeenNthCalledWith(3, {
        description: expect.any(String),
        handler: "index.handler",
        code: path.join(fixturePath, DEFAULT_LAMBDA_CODE_DIR),
        memory: 512,
        timeout: 10,
        runtime: "nodejs12.x",
        role: {
          service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"],
          policy: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Resource: "*",
                Action: [
                  "logs:CreateLogGroup",
                  "logs:CreateLogStream",
                  "logs:PutLogEvents"
                ]
              },
              {
                Action: ["lambda:InvokeFunction"],
                Effect: "Allow",
                Resource: "*"
              },
              {
                Action: ["cloudfront:CreateInvalidation"],
                Effect: "Allow",
                Resource: "*"
              },
              {
                Action: ["s3:GetObject", "s3:PutObject"],
                Effect: "Allow",
                Resource: "arn:aws:s3:::bucket-xyz/*"
              }
            ]
          }
        }
      });
    });

    it("provisions api lambda", () => {
      expect(mockLambda).toHaveBeenNthCalledWith(1, {
        description: expect.any(String),
        handler: "index.handler",
        code: path.join(fixturePath, API_LAMBDA_CODE_DIR),
        memory: 512,
        timeout: 10,
        runtime: "nodejs12.x",
        role: {
          service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"],
          policy: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Resource: "*",
                Action: [
                  "logs:CreateLogGroup",
                  "logs:CreateLogStream",
                  "logs:PutLogEvents"
                ]
              },
              {
                Action: ["lambda:InvokeFunction"],
                Effect: "Allow",
                Resource: "*"
              },
              {
                Action: ["cloudfront:CreateInvalidation"],
                Effect: "Allow",
                Resource: "*"
              },
              {
                Effect: "Allow",
                Resource: `arn:aws:s3:::bucket-xyz/*`,
                Action: ["s3:GetObject", "s3:PutObject"]
              }
            ]
          }
        }
      });
    });

    it("provisions image lambda", () => {
      expect(mockLambda).toHaveBeenNthCalledWith(2, {
        description: expect.any(String),
        handler: "index.handler",
        code: path.join(fixturePath, IMAGE_LAMBDA_CODE_DIR),
        memory: 512,
        timeout: 10,
        runtime: "nodejs12.x",
        role: {
          service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"],
          policy: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Resource: "*",
                Action: [
                  "logs:CreateLogGroup",
                  "logs:CreateLogStream",
                  "logs:PutLogEvents"
                ]
              },
              {
                Action: ["lambda:InvokeFunction"],
                Effect: "Allow",
                Resource: "*"
              },
              {
                Action: ["cloudfront:CreateInvalidation"],
                Effect: "Allow",
                Resource: "*"
              },
              {
                Effect: "Allow",
                Resource: `arn:aws:s3:::bucket-xyz/*`,
                Action: ["s3:GetObject", "s3:PutObject"]
              }
            ]
          }
        }
      });
    });

    it("creates distribution", () => {
      expect(mockCloudFront).toBeCalledWith({
        defaults: {
          allowedHttpMethods: expect.any(Array),
          forward: {
            queryString: true,
            cookies: "all"
          },
          minTTL: 0,
          defaultTTL: 0,
          maxTTL: 31536000,
          "lambda@edge": {
            "origin-request":
              "arn:aws:lambda:us-east-1:123456789012:function:default-cachebehavior-func:v1",
            "origin-response":
              "arn:aws:lambda:us-east-1:123456789012:function:default-cachebehavior-func:v1"
          },
          compress: true,
          viewerProtocolPolicy: "redirect-to-https"
        },
        origins: [
          {
            url: "http://bucket-xyz.s3.us-east-1.amazonaws.com",
            private: true,
            pathPatterns: {
              "_next/static/*": {
                minTTL: 0,
                defaultTTL: 86400,
                maxTTL: 31536000,
                forward: {
                  headers: "none",
                  cookies: "none",
                  queryString: false
                }
              },
              "_next/data/*": {
                minTTL: 0,
                defaultTTL: 0,
                maxTTL: 31536000,
                allowedHttpMethods: ["HEAD", "GET"],
                "lambda@edge": {
                  "origin-request":
                    "arn:aws:lambda:us-east-1:123456789012:function:default-cachebehavior-func:v1",
                  "origin-response":
                    "arn:aws:lambda:us-east-1:123456789012:function:default-cachebehavior-func:v1"
                }
              },
              "static/*": {
                minTTL: 0,
                defaultTTL: 86400,
                maxTTL: 31536000,
                forward: {
                  headers: "none",
                  cookies: "none",
                  queryString: false
                }
              },
              "api/preview": {
                minTTL: 0,
                defaultTTL: 0,
                maxTTL: 31536000,
                "lambda@edge": {
                  "origin-request":
                    "arn:aws:lambda:us-east-1:123456789012:function:api-cachebehavior-func:v1"
                },
                allowedHttpMethods: expect.any(Array)
              },
              "_next/image*": {
                minTTL: 0,
                defaultTTL: 60,
                maxTTL: 31536000,
                "lambda@edge": {
                  "origin-request":
                    "arn:aws:lambda:us-east-1:123456789012:function:image-cachebehavior-func:v1"
                },
                forward: {
                  headers: ["Accept"]
                },
                allowedHttpMethods: expect.any(Array)
              }
            }
          }
        ],
        distributionId: null
      });
    });

    it("invalidates distribution cache", () => {
      expect(mockCreateInvalidation).toBeCalledTimes(1);
    });
  });

  it("uploads static assets to S3 correctly", () => {
    expect(mockUpload).toBeCalledTimes(13);

    ["BUILD_ID"].forEach((file) => {
      expect(mockUpload).toBeCalledWith(
        expect.objectContaining({
          Key: file
        })
      );
    });

    [
      "static-pages/test-build-id/index.html",
      "static-pages/test-build-id/terms.html",
      "static-pages/test-build-id/404.html",
      "static-pages/test-build-id/about.html"
    ].forEach((file) => {
      expect(mockUpload).toBeCalledWith(
        expect.objectContaining({
          Key: file,
          CacheControl: "public, max-age=0, s-maxage=2678400, must-revalidate"
        })
      );
    });

    // Fallback page is never cached in S3
    ["static-pages/test-build-id/blog/[post].html"].forEach((file) => {
      expect(mockUpload).toBeCalledWith(
        expect.objectContaining({
          Key: file,
          CacheControl: "public, max-age=0, s-maxage=0, must-revalidate"
        })
      );
    });

    [
      "_next/static/chunks/chunk1.js",
      "_next/static/test-build-id/placeholder.js"
    ].forEach((file) => {
      expect(mockUpload).toBeCalledWith(
        expect.objectContaining({
          Key: file,
          CacheControl: "public, max-age=31536000, immutable"
        })
      );
    });

    ["_next/data/zsWqBqLjpgRmswfQomanp/index.json"].forEach((file) => {
      expect(mockUpload).toBeCalledWith(
        expect.objectContaining({
          Key: file,
          CacheControl: "public, max-age=0, s-maxage=2678400, must-revalidate"
        })
      );
    });

    ["public/sub/image.png", "public/favicon.ico"].forEach((file) => {
      expect(mockUpload).toBeCalledWith(
        expect.objectContaining({
          Key: file,
          CacheControl: "public, max-age=31536000, must-revalidate"
        })
      );
    });

    // Only certain public/static file extensions are cached by default
    ["public/sw.js", "static/donotdelete.txt"].forEach((file) => {
      expect(mockUpload).toBeCalledWith(
        expect.objectContaining({
          Key: file,
          CacheControl: undefined
        })
      );
    });
  });
});
