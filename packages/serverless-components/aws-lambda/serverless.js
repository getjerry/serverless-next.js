const aws = require("aws-sdk");
const path = require("path");
const AwsSdkLambda = aws.Lambda;
const { mergeDeepRight, pick } = require("ramda");
const { Component, utils } = require("@serverless/core");
const {
  createLambda,
  updateLambdaCode,
  updateLambdaConfig,
  getLambda,
  deleteLambda,
  configChanged,
  pack
} = require("./utils");

const outputsList = [
  "name",
  "hash",
  "description",
  "memory",
  "timeout",
  "code",
  "bucket",
  "shims",
  "handler",
  "runtime",
  "env",
  "role",
  "arn",
  "region"
];

const defaults = {
  description: "AWS Lambda Component",
  memory: 512,
  timeout: 20,
  code: process.cwd(),
  bucket: undefined,
  shims: [],
  handler: "handler.hello",
  runtime: "nodejs12.x",
  env: {},
  region: "us-east-1"
};

class AwsLambda extends Component {
  async default(inputs = {}) {
    this.context.status(`Deploying`);

    const config = mergeDeepRight(defaults, inputs);

    if (config.role && !config.role.name) {
      config.role.name = `${config.name}-lambda-role`;
    }

    this.context.debug(
      `Starting deployment of lambda ${config.name} to the ${config.region} region.`
    );

    const lambda = new AwsSdkLambda({
      region: config.region,
      credentials: this.context.credentials.aws
    });

    if (config.role && !config.role.arn) {
      const awsIamRole = await this.load("@getjerry/aws-iam-role");
      const outputsAwsIamRole = await awsIamRole(config.role);
      config.role = { arn: outputsAwsIamRole.arn };
    }

    this.context.status("Packaging");
    this.context.debug(`Packaging lambda code from ${config.code}.`);
    config.zipPath = await pack(config.code, config.shims);

    config.hash = await utils.hashFile(config.zipPath);

    const prevLambda = await getLambda({ lambda, ...config });

    if (!prevLambda) {
      this.context.status(`Creating`);
      this.context.debug(
        `Creating lambda ${config.name} in the ${config.region} region.`
      );
      await this.uploadCode(config);
      const createResult = await createLambda({ lambda, ...config });
      config.arn = createResult.arn;
      config.hash = createResult.hash;
    } else {
      config.arn = prevLambda.arn;

      if (configChanged(prevLambda, config)) {
        if (prevLambda.hash !== config.hash) {
          this.context.status(`Uploading code`);
          this.context.debug(`Uploading ${config.name} lambda code.`);
          await this.uploadCode(config);
          await updateLambdaCode({ lambda, ...config });
        }

        this.context.status(`Updating`);
        this.context.debug(`Updating ${config.name} lambda config.`);

        const updateResult = await updateLambdaConfig({ lambda, ...config });
        config.hash = updateResult.hash;
      }
    }

    // todo we probably don't need this logic now that we auto generate names
    if (this.state.name && this.state.name !== config.name) {
      this.context.status(`Replacing`);
      await deleteLambda({ lambda, name: this.state.name });
    }

    this.context.debug(
      `Successfully deployed lambda ${config.name} in the ${config.region} region.`
    );

    const outputs = pick(outputsList, config);

    this.state = outputs;
    await this.save();
    await this.removeCode(config);

    return outputs;
  }

  async publishVersion() {
    const { name, region, hash } = this.state;

    const lambda = new AwsSdkLambda({
      region,
      credentials: this.context.credentials.aws
    });

    const { Version } = await lambda
      .publishVersion({
        FunctionName: name,
        CodeSha256: hash
      })
      .promise();

    return { version: Version };
  }

  async remove() {
    this.context.status(`Removing`);

    if (!this.state.name) {
      this.context.debug(`Aborting removal. Function name not found in state.`);
      return;
    }

    const { name, region } = this.state;

    const lambda = new AwsSdkLambda({
      region,
      credentials: this.context.credentials.aws
    });

    const awsIamRole = await this.load("@getjerry/aws-iam-role");

    await awsIamRole.remove();

    this.context.debug(`Removing lambda ${name} from the ${region} region.`);
    await deleteLambda({ lambda, name });
    this.context.debug(
      `Successfully removed lambda ${name} from the ${region} region.`
    );

    const outputs = pick(outputsList, this.state);

    this.state = {};
    await this.save();

    return outputs;
  }

  async uploadCode({ bucket, zipPath } = {}) {
    if (!bucket || !zipPath) {
      return;
    }
    this.context.status("Uploading code");
    this.context.debug(`Uploading lambda code to ${bucket}${zipPath}`);
    const codeBucket = await this.load("@serverless/aws-s3");
    await codeBucket({
      accelerated: true,
      name: bucket
    });
    await codeBucket.upload({ key: path.basename(zipPath), file: zipPath });
  }

  async removeCode({ bucket, zipPath, region } = {}) {
    if (!bucket || !zipPath) {
      return;
    }
    this.context.status("Removing code");
    this.context.debug(`Removing lambda code from ${bucket}${zipPath}`);
    const s3 = new aws.S3({
      region: region,
      credentials: this.context.credentials.aws
    });
    await s3
      .deleteObject({ Key: path.basename(zipPath), Bucket: bucket })
      .promise();
  }
}

module.exports = AwsLambda;
